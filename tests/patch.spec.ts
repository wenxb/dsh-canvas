/**
 * The shared patch module. It exists because the log no longer stores a full
 * copy of the working copy after every patch, so BOTH the host replay and the
 * client timeline fold reproduce patches from the tool call's arguments. One
 * implementation, so the two sides cannot rebuild different content.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { applyPatch, contentHash, readPatchArgs, replaceOccurrences } from '../src/patch.ts'

describe('replaceOccurrences', () => {
  it('replaces the first occurrence only by default', () => {
    expect(replaceOccurrences('aXbXc', 'X', '-', false)).toEqual({ html: 'a-bXc', count: 1 })
  })

  it('replaces every occurrence with replaceAll', () => {
    expect(replaceOccurrences('aXbXc', 'X', '-', true)).toEqual({ html: 'a-b-c', count: 2 })
  })

  it('is a NO-OP when the target is absent — not an error', () => {
    // The store raises PatchNotFoundError on a zero-count patch, so a logged
    // patch that replayed to zero means our working copy is not the one it
    // applied to. The function itself must report that, not throw.
    expect(replaceOccurrences('abc', 'Z', '-', false)).toEqual({ html: 'abc', count: 0 })
  })

  it('is a NO-OP for an identical old/new pair', () => {
    expect(replaceOccurrences('abc', 'b', 'b', true)).toEqual({ html: 'abc', count: 0 })
  })

  it('is a NO-OP for an empty target (never a zero-width infinite loop)', () => {
    expect(replaceOccurrences('abc', '', 'X', true)).toEqual({ html: 'abc', count: 0 })
  })

  it('matches LITERALLY, never as a regex', () => {
    // A patch containing regex metacharacters or `$1` must land verbatim: a
    // regex-based implementation would either throw or substitute.
    expect(replaceOccurrences('a.c', '.', '$1', false)).toEqual({ html: 'a$1c', count: 1 })
    expect(replaceOccurrences('a[b', '[', 'X', false)).toEqual({ html: 'aXb', count: 1 })
  })

  it('handles multi-line and unicode targets exactly', () => {
    expect(replaceOccurrences('<h1>标题</h1>', '<h1>标题</h1>', '<h2>新</h2>', false))
      .toEqual({ html: '<h2>新</h2>', count: 1 })
  })

  it('counts non-overlapping occurrences', () => {
    expect(replaceOccurrences('aaaa', 'aa', 'b', true)).toEqual({ html: 'bb', count: 2 })
  })
})

describe('readPatchArgs', () => {
  it('reads the wire (snake_case) shape', () => {
    expect(readPatchArgs({ op: 'patch', old_string: 'a', new_string: 'b', replace_all: true }))
      .toEqual({ oldString: 'a', newString: 'b', replaceAll: true })
  })

  it('defaults replace_all to false when absent', () => {
    expect(readPatchArgs({ op: 'patch', old_string: 'a', new_string: 'b' }))
      .toEqual({ oldString: 'a', newString: 'b', replaceAll: false })
  })

  it('refuses anything that is not a patch, so a wrong op cannot be replayed', () => {
    expect(readPatchArgs({ op: 'create', old_string: 'a', new_string: 'b' })).toBeUndefined()
    expect(readPatchArgs({ op: 'save' })).toBeUndefined()
  })

  it('refuses a patch missing either side', () => {
    expect(readPatchArgs({ op: 'patch', old_string: 'a' })).toBeUndefined()
    expect(readPatchArgs({ op: 'patch', new_string: 'b' })).toBeUndefined()
  })

  it('refuses non-objects', () => {
    expect(readPatchArgs(undefined)).toBeUndefined()
    expect(readPatchArgs(null)).toBeUndefined()
    expect(readPatchArgs('patch')).toBeUndefined()
  })

  it('treats a non-boolean replace_all as false rather than truthy', () => {
    expect(readPatchArgs({ op: 'patch', old_string: 'a', new_string: 'b', replace_all: 'yes' })?.replaceAll).toBe(false)
  })
})

describe('applyPatch', () => {
  it('applies the arguments to a working copy', () => {
    const args = readPatchArgs({ op: 'patch', old_string: '<h1>a</h1>', new_string: '<h1>b</h1>' })!
    expect(applyPatch('<body><h1>a</h1></body>', args)).toEqual({ html: '<body><h1>b</h1></body>', count: 1 })
  })
})

describe('contentHash', () => {
  it('is deterministic and eight hex digits', () => {
    const first = contentHash('<h1>hello</h1>')
    expect(first).toBe(contentHash('<h1>hello</h1>'))
    expect(first).toMatch(/^[0-9a-f]{8}$/)
  })

  it('changes when the content changes', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'))
    expect(contentHash('abcdef')).not.toBe(contentHash('abcdeg'))
  })

  it('does not collapse on unicode or long input', () => {
    expect(contentHash('鹈鹕骑自行车')).not.toBe(contentHash('鹈鹕骑自行車'))
    const long = 'x'.repeat(100_000)
    expect(contentHash(long)).toMatch(/^[0-9a-f]{8}$/)
  })
})
