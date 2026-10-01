/**
 * Timeline reconstruction for the canvas panel: settled artifact cards in a
 * conversation snapshot rebuild each artifact's checkpoints, dirty flag, and
 * destroy tombstones — including legacy `revision`-numbered sessions.
 */
import { describe, expect, it } from 'vitest'
import { buildTimelines, scanArtifactEntries, scanPersistDir } from '../src/client/canvas/scan.ts'

/** A settled tool-result node carrying an artifact card. */
function result(seq: number, view: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'tool-result', seq, time: 1000 + seq, callId: `c${seq}`, isError: false, resultView: { card: 'artifact', ...view }, ...extra }
}

describe('scanArtifactEntries', () => {
  it('collects artifact cards and skips foreign/running/list nodes', () => {
    const nodes = [
      { kind: 'user' },
      result(1, { op: 'create', id: 'art-a1', version: 1, html: '<p>1</p>', title: 'A' }),
      { kind: 'assistant' },
      result(2, { op: 'patch', id: 'art-a1', version: 1, html: '<p>2</p>', applied: 3 }),
      result(3, { card: 'generic', title: 'other tool' }),
      { kind: 'tool-result', seq: 4, time: 1004, callId: 'cx', isError: false, resultView: null },
      result(5, { op: 'list', artifacts: [{ id: 'art-a1', version: 1, bytes: 10 }] }),
      result(6, { op: 'destroy', id: 'art-a1' }),
    ]
    const entries = scanArtifactEntries(nodes)
    expect(entries.map(entry => entry.seq)).toEqual([1, 2, 6])
    expect(entries[0]).toMatchObject({ id: 'art-a1', op: 'create', version: 1, html: '<p>1</p>', title: 'A', callId: 'c1' })
    expect(entries[2]).toMatchObject({ id: 'art-a1', op: 'destroy', html: undefined })
  })

  it('falls back to the legacy revision field when version is absent', () => {
    const entries = scanArtifactEntries([result(1, { op: 'create', id: 'art-old', revision: 7, html: '<i>x</i>' })])
    expect(entries[0]?.version).toBe(7)
  })
})

describe('scanPersistDir', () => {
  const listNode = (dir: string | undefined) => ({
    kind: 'tool-result', seq: 1, time: 0, callId: 'c1', isError: false,
    resultView: { card: 'artifact', op: 'list', ...dir === undefined ? {} : { dir }, artifacts: [] },
  })
  it('returns the newest persist dir a list card carried', () => {
    expect(scanPersistDir([])).toBeUndefined()
    expect(scanPersistDir([listNode('/a')])).toBe('/a')
    expect(scanPersistDir([listNode('/a'), listNode('/b')])).toBe('/b')
    expect(scanPersistDir([listNode(undefined)])).toBeUndefined()
  })
})

describe('buildTimelines', () => {
  it('checkpoints only create/save; patches mark the working copy dirty', () => {
    const entries = scanArtifactEntries([
      result(1, { op: 'create', id: 'x', version: 1, html: 'v1' }),
      result(2, { op: 'patch', id: 'x', version: 1, html: 'v2', applied: 1 }),
      result(3, { op: 'patch', id: 'x', version: 1, html: 'v3', applied: 2 }),
      result(4, { op: 'save', id: 'x', version: 2, html: 'v3' }),
      result(5, { op: 'patch', id: 'x', version: 2, html: 'v4', applied: 1 }),
    ])
    const timeline = buildTimelines(entries).get('x')
    expect(timeline?.checkpoints.map(c => [c.version, c.html])).toEqual([[1, 'v1'], [2, 'v3']])
    expect(timeline?.workingHtml).toBe('v4')
    expect(timeline?.workingDirty).toBe(true)
  })

  it('revert resets the working copy to the saved content (not dirty)', () => {
    const entries = scanArtifactEntries([
      result(1, { op: 'create', id: 'x', version: 1, html: 'v1' }),
      result(2, { op: 'save', id: 'x', version: 2, html: 'v2' }),
      result(3, { op: 'revert', id: 'x', version: 1, html: 'v1' }),
    ])
    const timeline = buildTimelines(entries).get('x')
    expect(timeline?.workingHtml).toBe('v1')
    expect(timeline?.workingDirty).toBe(false)
    expect(timeline?.checkpoints).toHaveLength(2)
  })

  it('destroy marks the tombstone; later entries stop checkpointing', () => {
    const entries = scanArtifactEntries([
      result(1, { op: 'create', id: 'x', version: 1, html: 'v1' }),
      result(2, { op: 'destroy', id: 'x' }),
      result(3, { op: 'save', id: 'x', version: 2, html: 'zombie' }),
    ])
    const timeline = buildTimelines(entries).get('x')
    expect(timeline?.destroyed).toBe(true)
    expect(timeline?.checkpoints).toHaveLength(1)
  })

  it('tracks the latest interactive declaration', () => {
    const entries = scanArtifactEntries([
      result(1, { op: 'create', id: 'x', version: 1, html: 'v1', interactive: true }),
      result(2, { op: 'interactive', id: 'x', version: 1, interactive: false }),
    ])
    const timeline = buildTimelines(entries).get('x')
    expect(timeline?.interactive).toBe(false)
  })

  it('derives versions for legacy sessions that numbered every patch', () => {
    // Legacy create carried revision 1; legacy patches bumped it. Only the
    // create becomes a checkpoint; patches leave the working copy dirty.
    const entries = scanArtifactEntries([
      result(1, { op: 'create', id: 'old', revision: 1, html: 'a' }),
      result(2, { op: 'patch', id: 'old', revision: 2, html: 'b' }),
      result(3, { op: 'patch', id: 'old', revision: 3, html: 'c' }),
    ])
    const timeline = buildTimelines(entries).get('old')
    expect(timeline?.checkpoints.map(c => c.version)).toEqual([1])
    expect(timeline?.workingHtml).toBe('c')
    expect(timeline?.workingDirty).toBe(true)
  })
})
