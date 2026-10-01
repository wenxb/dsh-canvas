/**
 * THE CLIENT FOLD, with a patch that carries no source.
 *
 * The canvas rebuilds artifact history from the conversation. Since a patch no
 * longer ships its resulting working copy, the fold must reproduce it from the
 * tool call's arguments — and, just as importantly, a patch card with no `html`
 * must still be RECOGNIZED. `artifactCardModel` used to require `html` for every
 * source-bearing op, so a sourceless patch returned null and would have vanished
 * from the timeline entirely: the canvas would appear to stop updating, with no
 * error anywhere.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { buildTimelines, scanArtifactEntries } from '../src/client/canvas/scan.ts'

const CREATE_HTML = '<body><h1>title</h1></body>'
const PATCHED = '<body><h1>EDITED</h1></body>'

/** A settled tool-result node carrying a card and its originating call args. */
function node(seq: number, view: Record<string, unknown>, args?: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'tool-result',
    seq,
    time: 1_000 + seq,
    callId: `c${seq}`,
    isError: false,
    resultView: { card: 'artifact', ...view },
    ...args === undefined ? {} : { call: { argsRaw: JSON.stringify(args) } },
  }
}

const createNode = (seq: number): Record<string, unknown> =>
  node(seq, { op: 'create', id: 'art-a', version: 1, html: CREATE_HTML, title: 'T' }, { op: 'create', id: 'art-a', html: CREATE_HTML })

/** A patch whose meta has NO html, only the descriptor. */
const patchNode = (seq: number, args: Record<string, unknown> | undefined): Record<string, unknown> =>
  node(seq, { op: 'patch', id: 'art-a', version: 1, applied: 1, bytes: PATCHED.length }, args)

describe('a sourceless patch card survives recognition', () => {
  it('is NOT dropped from the scan (the silent-vanish regression)', () => {
    // Before the fix `artifactCardModel` required `html`, so this returned no
    // entry at all and the patch disappeared from the canvas.
    const entries = scanArtifactEntries([patchNode(2, { op: 'patch', id: 'art-a', old_string: 'title', new_string: 'EDITED' })])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.op).toBe('patch')
    expect(entries[0]?.id).toBe('art-a')
    expect(entries[0]?.html).toBeUndefined()
  })

  it('carries the patch cause read off the tool call', () => {
    const entries = scanArtifactEntries([patchNode(2, { op: 'patch', id: 'art-a', old_string: 'title', new_string: 'EDITED', replace_all: true })])
    expect(entries[0]?.patch).toEqual({ oldString: 'title', newString: 'EDITED', replaceAll: true })
  })

  it('has no cause when the call args are missing or malformed', () => {
    expect(scanArtifactEntries([patchNode(2, undefined)])[0]?.patch).toBeUndefined()
    const bad = node(2, { op: 'patch', id: 'art-a', version: 1 })
    ;(bad as { call: { argsRaw: string } }).call = { argsRaw: '{not json' }
    expect(scanArtifactEntries([bad])[0]?.patch).toBeUndefined()
  })
})

describe('the fold reproduces the working copy from the cause', () => {
  const fold = (nodes: readonly unknown[]) => buildTimelines(scanArtifactEntries(nodes)).get('art-a')

  it('applies the patch to the working copy', () => {
    const timeline = fold([
      createNode(1),
      patchNode(2, { op: 'patch', id: 'art-a', old_string: '<h1>title</h1>', new_string: '<h1>EDITED</h1>' }),
    ])
    // Without this the canvas would keep showing the pre-patch content while the
    // store held the edit — the display silently lagging the artifact.
    expect(timeline?.workingHtml).toBe(PATCHED)
  })

  it('marks the working copy dirty (unsaved edits exist)', () => {
    const timeline = fold([
      createNode(1),
      patchNode(2, { op: 'patch', id: 'art-a', old_string: '<h1>title</h1>', new_string: '<h1>EDITED</h1>' }),
    ])
    expect(timeline?.workingDirty).toBe(true)
  })

  it('applies a replace_all patch', () => {
    const timeline = fold([
      node(1, { op: 'create', id: 'art-a', version: 1, html: 'X X X' }, { op: 'create', html: 'X X X' }),
      patchNode(2, { op: 'patch', id: 'art-a', old_string: 'X', new_string: 'Y', replace_all: true }),
    ])
    expect(timeline?.workingHtml).toBe('Y Y Y')
  })

  it('prefers a stored source when the log still carries one (old logs)', () => {
    const legacy = node(2, { op: 'patch', id: 'art-a', version: 1, html: '<p>legacy</p>', applied: 1 },
      { op: 'patch', id: 'art-a', old_string: 'nope', new_string: 'nope' })
    const timeline = fold([createNode(1), legacy])
    expect(timeline?.workingHtml).toBe('<p>legacy</p>')
  })

  it('leaves the working copy alone when the cause cannot be applied', () => {
    // A patch whose target is absent means our reconstruction is not the state
    // it applied to. Keep what we have rather than inventing content.
    const timeline = fold([
      createNode(1),
      patchNode(2, { op: 'patch', id: 'art-a', old_string: 'ABSENT', new_string: 'X' }),
    ])
    expect(timeline?.workingHtml).toBe(CREATE_HTML)
    expect(timeline?.workingDirty).toBe(true)
  })

  it('replays a run of arg-only patches in order', () => {
    const timeline = fold([
      node(1, { op: 'create', id: 'art-a', version: 1, html: '<b>1</b>' }, { op: 'create', html: '<b>1</b>' }),
      patchNode(2, { op: 'patch', id: 'art-a', old_string: '1', new_string: '2' }),
      patchNode(3, { op: 'patch', id: 'art-a', old_string: '2', new_string: '3' }),
      patchNode(4, { op: 'patch', id: 'art-a', old_string: '3', new_string: '4' }),
    ])
    expect(timeline?.workingHtml).toBe('<b>4</b>')
  })
})
