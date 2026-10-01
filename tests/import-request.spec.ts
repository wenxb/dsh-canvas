/*
 * The import command's payload parser.
 *
 * The two slug tests in tests/export.spec.ts cover the file-writing direction;
 * this file covers the USER-facing entry point of the other direction. Two
 * properties matter most:
 *
 *  - "omitted versions" must mean WORKING COPY ONLY, never all versions. The
 *    review's motivating artifact had 17 versions at ~2 MB; a parser that
 *    widened an omitted field into "everything" would silently copy megabytes
 *    on the picker's default path.
 *  - a malformed version entry must be REJECTED, not dropped. Dropping one
 *    would import a different set of versions than the user selected, which is
 *    the kind of silent divergence that makes a picker untrustworthy.
 */
import { describe, expect, it } from 'vitest'
import { parseImportRequest, parseRevertRequest } from '../src/interaction.ts'

describe('parseImportRequest', () => {
  it('parses a minimal working-copy import and leaves `versions` absent', () => {
    const result = parseImportRequest(JSON.stringify({ sessionId: 's-1', artifactId: 'art-a' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // ABSENT, not [] and not a list of everything: the host reads absence as
    // "working copy only".
    expect(result.value.versions).toBeUndefined()
    expect(result.value.sessionId).toBe('s-1')
    expect(result.value.artifactId).toBe('art-a')
  })

  it('keeps an explicit version selection', () => {
    const result = parseImportRequest(JSON.stringify({ sessionId: 's', artifactId: 'a', versions: [3, 1] }))
    expect(result.ok && result.value.versions).toEqual([1, 3])
  })

  it('de-duplicates and sorts versions so the host sees a canonical order', () => {
    const result = parseImportRequest(JSON.stringify({ sessionId: 's', artifactId: 'a', versions: [5, 2, 5, 2, 9] }))
    expect(result.ok && result.value.versions).toEqual([2, 5, 9])
  })

  it('treats an empty version array as the working-copy default', () => {
    const result = parseImportRequest(JSON.stringify({ sessionId: 's', artifactId: 'a', versions: [] }))
    expect(result.ok && result.value.versions).toBeUndefined()
  })

  it('rejects a version list with a non-integer rather than dropping the entry', () => {
    for (const versions of [[1, '2'], [1, 2.5], [1, 0], [1, -3], [null]]) {
      const result = parseImportRequest(JSON.stringify({ sessionId: 's', artifactId: 'a', versions }))
      expect(result.ok).toBe(false)
    }
  })

  it('rejects a non-array versions field', () => {
    expect(parseImportRequest(JSON.stringify({ sessionId: 's', artifactId: 'a', versions: 'all' })).ok).toBe(false)
    expect(parseImportRequest(JSON.stringify({ sessionId: 's', artifactId: 'a', versions: 3 })).ok).toBe(false)
  })

  it('requires both ids as non-empty strings', () => {
    for (const payload of [
      {}, { sessionId: 's' }, { artifactId: 'a' },
      { sessionId: '', artifactId: 'a' }, { sessionId: 's', artifactId: '' },
      { sessionId: 1, artifactId: 'a' },
    ]) {
      const result = parseImportRequest(JSON.stringify(payload))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/artifact-import/)
    }
  })

  it('carries an optional title only when non-empty', () => {
    const withTitle = parseImportRequest(JSON.stringify({ sessionId: 's', artifactId: 'a', title: '名字' }))
    expect(withTitle.ok && withTitle.value.title).toBe('名字')
    const blank = parseImportRequest(JSON.stringify({ sessionId: 's', artifactId: 'a', title: '' }))
    expect(blank.ok && blank.value.title).toBeUndefined()
  })

  it('rejects malformed JSON and non-object payloads with a command-prefixed message', () => {
    for (const raw of ['', 'not json', '{', 'null', '[]', '"str"', '3']) {
      const result = parseImportRequest(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('artifact-import')
    }
  })

  it('names the command in every error, so a bad payload is diagnosable', () => {
    const result = parseImportRequest('{bad')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/^artifact-import:/)
  })
})

/*
 * parseRevertRequest had NO test at all, and it backs the canvas 回退 button —
 * a user-initiated mutation of the working copy. Added here because it is the
 * sibling of the parser above and shares the same failure modes.
 */
describe('parseRevertRequest', () => {
  it('parses a valid revert', () => {
    const result = parseRevertRequest(JSON.stringify({ id: 'art-1', version: 2 }))
    expect(result.ok && result.value).toEqual({ id: 'art-1', version: 2 })
  })

  it('carries an optional title only when non-empty', () => {
    const withTitle = parseRevertRequest(JSON.stringify({ id: 'a', version: 1, title: 't' }))
    expect(withTitle.ok && withTitle.value.title).toBe('t')
    const blank = parseRevertRequest(JSON.stringify({ id: 'a', version: 1, title: '' }))
    expect(blank.ok && blank.value.title).toBeUndefined()
  })

  it('rejects a non-positive or fractional version', () => {
    for (const version of [0, -1, 1.5, '2', null, undefined]) {
      expect(parseRevertRequest(JSON.stringify({ id: 'a', version })).ok).toBe(false)
    }
  })

  it('rejects a missing or empty id', () => {
    for (const payload of [{}, { version: 1 }, { id: '', version: 1 }, { id: 3, version: 1 }]) {
      expect(parseRevertRequest(JSON.stringify(payload)).ok).toBe(false)
    }
  })

  it('rejects malformed JSON with a command-prefixed message', () => {
    const result = parseRevertRequest('nope')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/^artifact-revert:/)
  })
})
