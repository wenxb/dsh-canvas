/**
 * Explicit versioning semantics of the ArtifactStore: create saves 版本 1,
 * patch never bumps, save snapshots the working copy, revertTo restores a
 * saved version without touching history.
 */
import { describe, expect, it } from 'vitest'
import {
  ArtifactStore,
  ArtifactTooLargeError,
  NoChangeError,
  PatchNotFoundError,
  UnknownVersionError,
  rebuildFromMetas,
  replaceOccurrences,
  truncateHtml,
} from '../src/registry.ts'

describe('ArtifactStore versioning', () => {
  it('create saves 版本 1 and get reports it', () => {
    const store = new ArtifactStore()
    const id = store.create('<p>one</p>', 'Demo', 1024)
    expect(store.get(id)).toMatchObject({ html: '<p>one</p>', version: 1, title: 'Demo' })
    expect(store.versionsOf(id)).toHaveLength(1)
    expect(store.versionsOf(id)[0]?.version).toBe(1)
  })

  it('patch mutates the working copy WITHOUT creating a version', () => {
    const store = new ArtifactStore()
    const id = store.create('<p>one</p>', undefined, 1024)
    const { state, count } = store.patch(id, 'one', 'two', false, 1024)
    expect(count).toBe(1)
    expect(state.html).toBe('<p>two</p>')
    expect(state.version).toBe(1)
    expect(store.versionsOf(id)).toHaveLength(1)
  })

  it('save snapshots the working copy as the next version', () => {
    const store = new ArtifactStore()
    const id = store.create('<p>v1</p>', undefined, 1024)
    store.patch(id, 'v1', 'v2', false, 1024)
    const { state, unchanged } = store.save(id)
    expect(unchanged).toBe(false)
    expect(state.version).toBe(2)
    expect(store.versionsOf(id).map(v => v.version)).toEqual([1, 2])
    expect(store.versionsOf(id)[1]?.html).toBe('<p>v2</p>')
  })

  it('save with unchanged content reports unchanged and does not push', () => {
    const store = new ArtifactStore()
    const id = store.create('<p>same</p>', undefined, 1024)
    const { unchanged } = store.save(id)
    expect(unchanged).toBe(true)
    expect(store.versionsOf(id)).toHaveLength(1)
  })

  it('revertTo resets the working copy and keeps history; later save continues numbering', () => {
    const store = new ArtifactStore()
    const id = store.create('<p>A</p>', undefined, 1024)
    store.patch(id, 'A', 'B', false, 1024)
    store.save(id) // 版本 2: <p>B</p>
    store.patch(id, 'B', 'C', false, 1024)
    store.save(id) // 版本 3: <p>C</p>
    const reverted = store.revertTo(id, 1)
    expect(reverted.html).toBe('<p>A</p>')
    expect(reverted.version).toBe(3) // newest SAVED version is untouched
    // A patch after revert edits the restored copy...
    const { state } = store.patch(id, 'A', 'A2', false, 1024)
    expect(state.html).toBe('<p>A2</p>')
    // ...and the next save continues from the highest number.
    const saved = store.save(id)
    expect(saved.state.version).toBe(4)
    expect(store.versionsOf(id).map(v => v.version)).toEqual([1, 2, 3, 4])
  })

  it('revertTo an unknown version throws UnknownVersionError', () => {
    const store = new ArtifactStore()
    const id = store.create('<p>x</p>', undefined, 1024)
    expect(() => store.revertTo(id, 9)).toThrow(UnknownVersionError)
  })

  it('caps the version list at MAX_VERSIONS (oldest dropped)', () => {
    const store = new ArtifactStore()
    const id = store.create('0', undefined, 1024)
    for (let i = 1; i <= 25; i++) {
      store.patch(id, String(i - 1), String(i), false, 1024)
      store.save(id)
    }
    const versions = store.versionsOf(id)
    expect(versions).toHaveLength(20)
    expect(versions[0]?.version).toBe(7)
    expect(versions[19]?.version).toBe(26)
  })

  it('interactive flag: set at create, toggleable later', () => {
    const store = new ArtifactStore()
    const on = store.create('<p>i</p>', 'Demo', 1024, true)
    expect(store.get(on).interactive).toBe(true)
    expect(store.get(on).interactive).toBe(true)
    const off = store.create('<p>p</p>', undefined, 1024)
    expect(store.get(off).interactive).toBeUndefined()
    const state = store.setInteractive(off, true)
    expect(state.interactive).toBe(true)
    expect(store.get(off).interactive).toBe(true)
    store.setInteractive(off, false)
    expect(store.get(off).interactive).toBe(false)
  })

  it('keeps the patch error contract', () => {
    const store = new ArtifactStore()
    const id = store.create('<p>abc</p>', undefined, 1024)
    expect(() => store.patch(id, 'same', 'same', false, 1024)).toThrow(NoChangeError)
    expect(() => store.patch(id, 'nope', 'x', false, 1024)).toThrow(PatchNotFoundError)
    expect(() => store.create('x'.repeat(2048), undefined, 1024)).toThrow(ArtifactTooLargeError)
    expect(() => store.get('art-missing')).toThrow(/not found/)
  })
})

describe('source helpers', () => {
  it('replaceOccurrences mirrors edit-tool semantics', () => {
    expect(replaceOccurrences('aaa', 'a', 'b', true)).toEqual({ html: 'bbb', count: 3 })
    expect(replaceOccurrences('aaa', 'a', 'b', false)).toEqual({ html: 'baa', count: 1 })
    expect(replaceOccurrences('abc', 'x', 'y', false)).toEqual({ html: 'abc', count: 0 })
    expect(replaceOccurrences('abc', 'b', 'b', false)).toEqual({ html: 'abc', count: 0 })
  })

  it('truncateHtml respects the byte cap without splitting characters', () => {
    expect(truncateHtml('hello', 5)).toEqual({ html: 'hello', truncated: false })
    const cut = truncateHtml('héllo', 3)
    expect(cut.truncated).toBe(true)
    expect(new TextEncoder().encode(cut.html).byteLength).toBeLessThanOrEqual(3)
  })
})


describe('rebuildFromMetas (log-based store recovery)', () => {
  it('reconstructs create/patch/save/revert sequences', () => {
    const states = rebuildFromMetas([
      { op: 'create', id: 'a', version: 1, html: 'v1', title: 'T', interactive: true },
      { op: 'patch', id: 'a', version: 1, html: 'v2', applied: 1 },
      { op: 'save', id: 'a', version: 2, html: 'v2' },
      { op: 'patch', id: 'a', version: 2, html: 'v3', applied: 1 },
      { op: 'revert', id: 'a', version: 1, html: 'v1' },
    ])
    const a = states.get('a')
    expect(a?.html).toBe('v1')
    expect(a?.title).toBe('T')
    expect(a?.interactive).toBe(true)
    expect(a?.versions.map(v => v.version)).toEqual([1, 2])
  })

  it('skips truncated reads as working-copy sources', () => {
    const states = rebuildFromMetas([
      { op: 'create', id: 'a', version: 1, html: 'full-source' },
      { op: 'read', id: 'a', version: 1, html: 'trunca', truncated: true },
    ])
    expect(states.get('a')?.html).toBe('full-source')
  })

  it('ignores unknown ops and meta-less results', () => {
    const states = rebuildFromMetas([
      { op: 'interactive', id: 'a', interactive: false },
      { op: 'create', id: 'a', version: 1, html: 'v1' },
      { op: 'interactive', id: 'a', interactive: false },
    ])
    expect(states.get('a')?.interactive).toBe(false)
    expect(states.get('a')?.html).toBe('v1')
  })

  it('bootstraps from a patch meta when the create meta is missing (fork/schema-era recovery)', () => {
    // The real-world trace: a fork seed (or schema-rejected create era) starts
    // the artifact's meta history at a PATCH — the first html-bearing meta is
    // a complete source snapshot and must rebuild a usable state.
    const states = rebuildFromMetas([
      { op: 'patch', id: 'sw', version: 1, html: 'base-plus-edit', applied: 1 },
      { op: 'save', id: 'sw', version: 2, html: 'base-plus-edit' },
      { op: 'patch', id: 'sw', version: 2, html: 'further-edit', applied: 1 },
    ])
    const sw = states.get('sw')
    expect(sw).not.toBeUndefined()
    expect(sw?.html).toBe('further-edit')
    // The bootstrap made v1 = the post-patch content, so the logged save of
    // that same content is a genuine no-op (matches the live store's
    // unchanged-save semantics) — the version list stays [1].
    expect(sw?.versions.map(v => v.version)).toEqual([1])
  })

  it('a rebuilt-without-create state is fully usable (patch + revert)', () => {
    const states = rebuildFromMetas([
      { op: 'save', id: 'x', version: 3, html: 'saved-three' },
    ])
    const store = new ArtifactStore()
    store.restore('x', states.get('x')!)
    expect(store.get('x').html).toBe('saved-three')
    store.patch('x', 'saved-three', 'patched-three', false, 1024 * 1024)
    store.revertTo('x', 3)
    expect(store.get('x').html).toBe('saved-three')
  })
})

describe('forked-session rebuild (tail-only history)', () => {
  it('a revert meta for an unknown version materializes that version', () => {
    const metas = [
      { op: 'save', id: 'art-f', version: 8, html: '<p>v8</p>' },
      { op: 'revert', id: 'art-f', version: 7, html: '<p>v7</p>' },
    ] as const
    const states = rebuildFromMetas(metas as any)
    const st = states.get('art-f')!
    expect(st.html).toBe('<p>v7</p>')
    expect(st.versions.map(v => v.version)).toEqual([7, 8])
    // a SECOND revert to that version must now succeed against the store
    const store = new ArtifactStore()
    store.restore('art-f', st)
    store.revertTo('art-f', 7)
    expect(store.get('art-f')!.html).toBe('<p>v7</p>')
  })
})

/*
 * F4 — the stale-patch bug. Disk-first boot restores an artifact, then log
 * replay must still fold in log content that is NEWER than the disk cache.
 *
 * The old replay guard was `if (!store.has(id)) store.restore(...)`: because
 * the disk cache is written on mutation it can lag the log, and every artifact
 * op projects its full html into the log, so the log is authoritative for
 * content. Skipping an already-present id left the store on pre-patch html and
 * the next patch then edited stale text — a wrong replacement or a
 * PatchNotFoundError after any restart.
 */
describe('adoptReplay — log beats a lagging disk cache', () => {
  const meta = (op: string, html: string, id = 'art-1', version?: number): any => ({
    op, id, html, ...version === undefined ? {} : { version },
    ...op === 'create' ? { title: 'T' } : {},
  })

  it('adopts the log when the same version carries different html (unsaved patch)', () => {
    const store = new ArtifactStore()
    // Disk cache: v1 plus an older working copy.
    store.restore('art-1', { html: '<p>stale</p>', versions: [{ version: 1, html: '<p>v1</p>', time: 1 }] })
    // Log: same version 1, but a patch moved the working copy on.
    for (const [id, snap] of rebuildFromMetas([meta('create', '<p>v1</p>', 'art-1', 1), meta('patch', '<p>patched</p>')])) {
      store.adoptReplay(id, snap)
    }
    expect(store.get('art-1').html).toBe('<p>patched</p>')
    // ...and the next patch now operates on the CURRENT html, not the stale one.
    const result = store.patch('art-1', '<p>patched</p>', '<p>next</p>', false, 1 << 20)
    expect(result.count).toBe(1)
    expect(store.get('art-1').html).toBe('<p>next</p>')
  })

  it('does NOT let a partial log erase history the disk still holds', () => {
    const store = new ArtifactStore()
    store.restore('art-1', {
      html: '<p>v3</p>',
      versions: [
        { version: 1, html: '<p>v1</p>', time: 1 },
        { version: 2, html: '<p>v2</p>', time: 2 },
        { version: 3, html: '<p>v3</p>', time: 3 },
      ],
    })
    // A pruned/partial log with only version 1 must not win.
    const adopted = store.adoptReplay('art-1', {
      html: '<p>v1</p>',
      versions: [{ version: 1, html: '<p>v1</p>', time: 1 }],
    })
    expect(adopted).toBe(false)
    expect(store.versionsOf('art-1').map(v => v.version)).toEqual([1, 2, 3])
  })

  it('reports no adoption when the log matches the store exactly', () => {
    const store = new ArtifactStore()
    store.restore('art-1', { html: '<p>x</p>', versions: [{ version: 1, html: '<p>x</p>', time: 1 }] })
    expect(store.adoptReplay('art-1', { html: '<p>x</p>', versions: [{ version: 1, html: '<p>x</p>', time: 1 }] })).toBe(false)
  })

  it('adopts a tombstone from the log (destroy must survive replay)', () => {
    const store = new ArtifactStore()
    store.restore('art-1', { html: '<p>x</p>', versions: [{ version: 1, html: '<p>x</p>', time: 1 }] })
    const adopted = store.adoptReplay('art-1', {
      html: '<p>x</p>', deleted: true, versions: [{ version: 1, html: '<p>x</p>', time: 1 }],
    })
    expect(adopted).toBe(true)
    expect(store.isLive('art-1')).toBe(false)
    expect(store.has('art-1')).toBe(true)
  })

  it('restores an id the store lacks (the simple cold case)', () => {
    const store = new ArtifactStore()
    expect(store.adoptReplay('art-9', { html: '<p>n</p>', versions: [{ version: 1, html: '<p>n</p>', time: 1 }] })).toBe(true)
    expect(store.get('art-9').html).toBe('<p>n</p>')
  })

  it('size() counts tombstones so a replay watermark is not re-walked', () => {
    // list() hides tombstones; keying the skip decision off list().length made
    // an all-destroyed session replay its whole log on every `list` call.
    const store = new ArtifactStore()
    store.restore('art-1', { html: '<p>x</p>', deleted: true, versions: [{ version: 1, html: '<p>x</p>', time: 1 }] })
    expect(store.list()).toEqual([])
    expect(store.size()).toBe(1)
  })
})
