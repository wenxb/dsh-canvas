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
import { parseImportRequest, parseRevertRequest, resolveImportContent } from '../src/interaction.ts'
import { formatImportCommand } from '../src/client/canvas/state.ts'

/**
 * The parser takes the text AFTER the command name, while the builder produces
 * the whole line, so the round trip strips the prefix — mirroring exactly what
 * the host's command dispatcher does before calling the parser.
 */
function payloadOf(line: string): string {
  const prefix = '/artifact-import '
  expect(line.startsWith(prefix)).toBe(true)
  return line.slice(prefix.length)
}

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

/*
 * The pure selection resolver. `includeWorking` was added to the protocol
 * because the picker's "当前内容（工作副本）" checkbox gated the import button but
 * was otherwise ignored by the command — unchecking it changed nothing, since
 * the host unconditionally used the source working copy as the imported
 * artifact's content. A control that does not do what it says is worse than no
 * control, so the semantics it now actually has are pinned here.
 */
describe('resolveImportContent', () => {
  const snapshot = {
    html: '<p>working</p>',
    versions: [
      { version: 1, html: '<p>one</p>', time: 100 },
      { version: 2, html: '<p>two</p>', time: 200 },
    ],
  }

  it('defaults to the working copy with no versions', () => {
    const result = resolveImportContent(snapshot, undefined, true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.html).toBe('<p>working</p>')
    expect(result.versions).toEqual([])
  })

  it('carries the working copy alongside the selected versions', () => {
    const result = resolveImportContent(snapshot, [1], true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.html).toBe('<p>working</p>')
    expect(result.versions.map(v => v.version)).toEqual([1])
  })

  it('substitutes the newest selected version when the working copy is excluded', () => {
    const result = resolveImportContent(snapshot, [1, 2], false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Version 2 is the newest selected, so it BECOMES the content — otherwise
    // the import would have no bytes at all.
    expect(result.html).toBe('<p>two</p>')
    expect(result.versions.map(v => v.version)).toEqual([1, 2])
  })

  it('rejects excluding the working copy when nothing is selected', () => {
    const result = resolveImportContent(snapshot, undefined, false)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('nothing selected')
    expect(resolveImportContent(snapshot, [], false).ok).toBe(false)
  })

  it('rejects a selection that matches no version', () => {
    const result = resolveImportContent(snapshot, [9], true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('none of the requested versions')
  })

  it('sorts the selection ascending regardless of input order', () => {
    const result = resolveImportContent(snapshot, [2, 1], true)
    expect(result.ok && result.versions.map(v => v.version)).toEqual([1, 2])
  })
})

/*
 * `formatImportCommand` builds the exact line the picker sends. It is a second
 * producer of the payload `parseImportRequest` consumes, and the two live in
 * different modules (client canvas state vs. host interaction), so nothing but
 * this test makes them agree — a rename on one side would silently fall back to
 * the default and the checkbox would go dead again.
 */
describe('the picker command line round-trips through the parser', () => {
  it('omits the flag when the working copy is wanted', () => {
    const parsed = parseImportRequest(payloadOf(formatImportCommand('s-1', 'art-a', [2], true)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.includeWorking).toBeUndefined()
    expect(parsed.value.versions).toEqual([2])
  })

  it('carries an explicit false when the working copy is excluded', () => {
    const parsed = parseImportRequest(payloadOf(formatImportCommand('s-1', 'art-a', [2], false)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.includeWorking).toBe(false)
    expect(parsed.value.versions).toEqual([2])
  })

  it('sends no versions array for a working-copy-only import', () => {
    const line = formatImportCommand('s-1', 'art-a', undefined, true)
    expect(line).not.toContain('versions')
    expect(parseImportRequest(payloadOf(line)).ok).toBe(true)
  })
})
