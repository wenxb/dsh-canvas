// @vitest-environment jsdom
/**
 * The canvas bridge singleton: baseline semantics (history never auto-opens),
 * auto-open on a NEW settled version event, streaming placeholder behavior,
 * and view-index clamping. Runs against a fake sessions double — no React,
 * no host.
 * @module
 */
import { afterEach, describe, expect, it } from 'vitest'
import { canvasBridge } from '../src/client/canvas/state.ts'

type Listener = () => void

/** Minimal ConversationSnapshot-shaped fixture (only the read fields). */
function snapshot(nodes: unknown[], runningCalls: unknown[] = []): Record<string, unknown> {
  return { nodes, runningCalls }
}

function createNode(seq: number, view: Record<string, unknown>, callId = `c${seq}`, ageMs = 0): Record<string, unknown> {
  return { kind: 'tool-result', seq, time: Date.now() - ageMs, callId, isError: false, resultView: { card: 'artifact', ...view } }
}
const OLD = 60_000

/** Fake ISessions: one current session whose snapshot we push manually. */
function makeSessionsDouble() {
  const listeners = new Set<Listener>()
  let current: Record<string, unknown> = snapshot([])
  const session = {
    getSnapshot: (): Record<string, unknown> => current,
    subscribe: (fn: Listener): (() => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    command: async (): Promise<{ ok: true; value: { matched: true } }> => ({ ok: true, value: { matched: true } }),
  }
  const binding = { sessionId: 's1', session, ctx: {} }
  // The real client face is `sessions.list` (an ObservableSnapshot with the
  // authoritative `current`); the doubles model exactly that.
  const sessions = {
    list: {
      getSnapshot: (): { current: string } => ({ current: 's1' }),
      subscribe: (_fn: Listener): (() => void) => () => {},
    },
    binding: (_id: string): typeof binding => binding,
  }
  return {
    sessions,
    push(next: Record<string, unknown>): void {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function initBridge(): ReturnType<typeof makeSessionsDouble> {
  const double = makeSessionsDouble()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  canvasBridge.init({ sessions: double.sessions, get: () => undefined } as any)
  return double
}

afterEach(() => {
  canvasBridge.resetForTests()
})

describe('canvas bridge auto-open', () => {
  it('baseline bind does NOT open for pre-existing history', () => {
    const double = initBridge()
    double.push(snapshot([
      createNode(1, { op: 'create', id: 'art-a', version: 1, html: '<p>a</p>', title: 'A' }, undefined, OLD),
      createNode(2, { op: 'save', id: 'art-a', version: 2, html: '<p>b</p>' }, undefined, OLD),
    ]))
    const state = canvasBridge.getSnapshot()
    expect(state.open).toBe(false)
    expect(state.order).toEqual(['art-a'])
    expect(state.timelines.get('art-a')?.checkpoints).toHaveLength(2)
  })

  it('a NEW settled save past the baseline opens the panel and selects it', () => {
    const double = initBridge()
    double.push(snapshot([createNode(1, { op: 'create', id: 'art-a', version: 1, html: '<p>a</p>' }, undefined, OLD)]))
    expect(canvasBridge.getSnapshot().open).toBe(false)
    double.push(snapshot([
      createNode(1, { op: 'create', id: 'art-a', version: 1, html: '<p>a</p>' }),
      createNode(2, { op: 'save', id: 'art-a', version: 2, html: '<p>b</p>', title: 'B' }),
    ]))
    const state = canvasBridge.getSnapshot()
    expect(state.open).toBe(true)
    expect(state.selectedId).toBe('art-a')
    expect(state.viewIndex).toBe(1) // newest checkpoint
  })

  it('a reported draft stream opens the placeholder; settle clears it via entries', () => {
    const double = initBridge()
    canvasBridge.reportStream({ callId: 'cs1', html: '<b>par', title: 'Live' })
    let state = canvasBridge.getSnapshot()
    expect(state.open).toBe(true)
    expect(state.reportedStream?.title).toBe('Live')
    // Settled result for that callId clears the stream and selects the artifact.
    double.push(snapshot([createNode(5, { op: 'create', id: 'art-live', version: 1, html: '<b>party</b>', title: 'Live' }, 'cs1')]))
    state = canvasBridge.getSnapshot()
    expect(state.reportedStream).toBeUndefined()
    expect(state.selectedId).toBe('art-live')
  })

  it('an announced-but-unsettled running create surfaces as runningStream', () => {
    const double = initBridge()
    double.push(snapshot([], [{
      callId: 'cr9',
      name: 'artifact',
      argsRaw: '{"op":"create","title":"Run","html":"<i>x</i>"}',
      turn: 0, step: 0, time: 1, callView: null, subCalls: [],
    }]))
    const state = canvasBridge.getSnapshot()
    expect(state.runningStream?.callId).toBe('cr9')
    expect(state.runningStream?.html).toBe('<i>x</i>')
    expect(state.open).toBe(true)
  })
})

describe('canvas bridge pending semantics', () => {
  const base = Date.now() - 30_000
  const settled = (seq: number, time: number, callId: string, view: Record<string, unknown>): Record<string, unknown> =>
    ({ kind: 'tool-result', seq, time, callId, isError: false, resultView: { card: 'artifact', ...view } })
  const patchView = (html: string): Record<string, unknown> =>
    ({ op: 'patch', id: 'art-x', version: 1, html, applied: 1 })
  const runningPatch = (callId: string, time: number): Record<string, unknown> =>
    ({ callId, name: 'artifact', argsRaw: '{"op":"patch","id":"art-x","old_string":"a","new_string":"b"}', turn: 0, step: 1, time })

  it('a live running patch sets pending and its own settle clears it', () => {
    const double = initBridge()
    const create = settled(1, base, 'c1', { op: 'create', id: 'art-x', version: 1, html: '<p>1</p>' })
    double.push(snapshot([create], [runningPatch('p1', base + 2_000)]))
    expect(canvasBridge.getSnapshot().pending?.op).toBe('patch')
    expect(canvasBridge.getSnapshot().pending?.callId).toBe('p1')
    double.push(snapshot([create, settled(2, base + 4_000, 'p1', patchView('<p>2</p>'))], []))
    expect(canvasBridge.getSnapshot().pending).toBeUndefined()
  })

  it('a retry-stranded call is a zombie: a LATER settle on the target clears pending', () => {
    const double = initBridge()
    const create = settled(1, base, 'c1', { op: 'create', id: 'art-x', version: 1, html: '<p>1</p>' })
    // Disconnect scenario: attempt 'p1' started at T, never resolved; the
    // retried call 'p2' landed and settled at T+10s under its own callId.
    const ghost = runningPatch('p1', base + 2_000)
    const retrySettle = settled(2, base + 10_000, 'p2', patchView('<p>2</p>'))
    double.push(snapshot([create, retrySettle], [ghost]))
    expect(canvasBridge.getSnapshot().pending).toBeUndefined()
    // The canvas must reflect the retried content, not the ghost's attempt.
    expect(canvasBridge.getSnapshot().timelines.get('art-x')?.workingHtml).toBe('<p>2</p>')
  })

  it('a stranded call is NOT a zombie while nothing newer settled (still pending)', () => {
    const double = initBridge()
    const create = settled(1, base, 'c1', { op: 'create', id: 'art-x', version: 1, html: '<p>1</p>' })
    double.push(snapshot([create], [runningPatch('p1', base + 2_000)]))
    expect(canvasBridge.getSnapshot().pending?.callId).toBe('p1')
  })
})

describe('canvas bridge destroy handling', () => {
  it('deleting the VIEWED artifact jumps selection to the newest survivor', () => {
    const double = initBridge()
    double.push(snapshot([
      { kind: 'tool-result', seq: 1, time: 100, callId: 'c1', isError: false, resultView: { card: 'artifact', op: 'create', id: 'art-a', version: 1, html: '<p>a</p>' } },
      { kind: 'tool-result', seq: 2, time: 200, callId: 'c2', isError: false, resultView: { card: 'artifact', op: 'create', id: 'art-b', version: 1, html: '<p>b</p>' } },
    ]))
    canvasBridge.open('art-a')
    expect(canvasBridge.getSnapshot().selectedId).toBe('art-a')
    // destroy arrives for the VIEWED artifact
    double.push(snapshot([
      { kind: 'tool-result', seq: 1, time: 100, callId: 'c1', isError: false, resultView: { card: 'artifact', op: 'create', id: 'art-a', version: 1, html: '<p>a</p>' } },
      { kind: 'tool-result', seq: 2, time: 200, callId: 'c2', isError: false, resultView: { card: 'artifact', op: 'create', id: 'art-b', version: 1, html: '<p>b</p>' } },
      { kind: 'tool-result', seq: 3, time: 300, callId: 'c3', isError: false, resultView: { card: 'artifact', op: 'destroy', id: 'art-a' } },
    ]))
    expect(canvasBridge.getSnapshot().selectedId).toBe('art-b')
    expect(canvasBridge.getSnapshot().timelines.get('art-a')?.destroyed).toBe(true)
  })

  it('deleting the ONLY artifact leaves selection (with destroy banner) — nothing to fall back to', () => {
    const double = initBridge()
    double.push(snapshot([
      { kind: 'tool-result', seq: 1, time: 100, callId: 'c1', isError: false, resultView: { card: 'artifact', op: 'create', id: 'art-a', version: 1, html: '<p>a</p>' } },
    ]))
    canvasBridge.open('art-a')
    double.push(snapshot([
      { kind: 'tool-result', seq: 1, time: 100, callId: 'c1', isError: false, resultView: { card: 'artifact', op: 'create', id: 'art-a', version: 1, html: '<p>a</p>' } },
      { kind: 'tool-result', seq: 2, time: 200, callId: 'c2', isError: false, resultView: { card: 'artifact', op: 'destroy', id: 'art-a' } },
    ]))
    expect(canvasBridge.getSnapshot().selectedId).toBe('art-a')
    expect(canvasBridge.getSnapshot().timelines.get('art-a')?.destroyed).toBe(true)
  })
})

describe('canvas bridge cross-reload (per-session localStorage persistence)', () => {
  it('restores OPEN (but not the selection) from localStorage on a cold rebind (the F5 case)', () => {
    // Seed storage as if the user left the canvas's session YESTERDAY — the
    // bridge is a fresh process boot (afterEach reset everything). Only `open`
    // is restored: after a reload the canvas must come back at the PICKER so
    // the user picks an artifact (or sees every canvas card), rather than
    // silently landing on whatever was viewed before. In-session switches
    // (tab / session) keep the selection — only F5 drops it.
    globalThis.localStorage?.setItem(
      'dsh-html-artifact:canvas-ui:s-reload',
      JSON.stringify({ open: true, selectedId: 'art-old', viewIndex: 0 }),
    )
    const current = { nodes: [], runningCalls: [] }
    const session = {
      getSnapshot: () => current,
      subscribe: () => () => {},
      command: async (): Promise<{ ok: true; value: { matched: true } }> => ({ ok: true, value: { matched: true } }),
    }
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-reload' }), subscribe: () => () => {} },
      binding: (_id: string) => ({ sessionId: 's-reload', session, ctx: {} }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    canvasBridge.init({ sessions, get: () => undefined } as any)
    expect(canvasBridge.getSnapshot().open).toBe(true)
    expect(canvasBridge.getSnapshot().selectedId).toBeUndefined()
  })

  it('a session with NO persisted entry starts closed (no cross-session bleed)', () => {
    const current = { nodes: [], runningCalls: [] }
    const session = {
      getSnapshot: () => current,
      subscribe: () => () => {},
      command: async (): Promise<{ ok: true; value: { matched: true } }> => ({ ok: true, value: { matched: true } }),
    }
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-virgin' }), subscribe: () => () => {} },
      binding: (_id: string) => ({ sessionId: 's-virgin', session, ctx: {} }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    canvasBridge.init({ sessions, get: () => undefined } as any)
    expect(canvasBridge.getSnapshot().open).toBe(false)
    expect(canvasBridge.getSnapshot().selectedId).toBeUndefined()
  })
})

describe('canvas bridge revert correctness', () => {
  it('a model-side revert auto-jumps to the REVERTED version (not the newest)', () => {
    const double = initBridge()
    canvasBridge.open('art-x')
    // The auto-jump only fires on FRESH events (replayed history carries old
    // timestamps and must NOT jump), so time these at Date.now().
    const now = Date.now()
    double.push(snapshot([
      { kind: 'tool-result', seq: 1, time: now - 200, callId: 'c1', isError: false, resultView: { card: 'artifact', op: 'create', id: 'art-x', version: 1, html: '<p>v1</p>' } },
      { kind: 'tool-result', seq: 2, time: now - 100, callId: 'c2', isError: false, resultView: { card: 'artifact', op: 'save', id: 'art-x', version: 2, html: '<p>v2</p>' } },
      { kind: 'tool-result', seq: 3, time: now, callId: 'c3', isError: false, resultView: { card: 'artifact', op: 'revert', id: 'art-x', version: 1, html: '<p>v1</p>' } },
    ]))
    const snap = canvasBridge.getSnapshot()
    // version badge reads version 1, body shows v1, not v2
    expect(snap.viewIndex).toBe(0)
    expect(snap.timelines.get('art-x')?.checkpoints[0]?.version).toBe(1)
  })

  it('a USER-side revert (command path) syncs the canvas VIA the overlay — no waiting for the next op', () => {
    const double = initBridge()
    double.push(snapshot([
      { kind: 'tool-result', seq: 1, time: 100, callId: 'c1', isError: false, resultView: { card: 'artifact', op: 'create', id: 'art-x', version: 1, html: '<p>v1</p>' } },
      { kind: 'tool-result', seq: 2, time: 200, callId: 'c2', isError: false, resultView: { card: 'artifact', op: 'patch', id: 'art-x', version: 1, html: '<p>v1 plus unsaved</p>', applied: 1 } },
      { kind: 'tool-result', seq: 3, time: 300, callId: 'c3', isError: false, resultView: { card: 'artifact', op: 'save', id: 'art-x', version: 2, html: '<p>v1 plus unsaved</p>' } },
    ]))
    canvasBridge.open('art-x')
    // view is at latest (v2). The user clicks 回退此版本 on v1 somewhere →
    // run the same hidden-smoke path the panel does.
    canvasBridge.applyLocalRevert('art-x', 1)
    const snap = canvasBridge.getSnapshot()
    expect(snap.viewIndex).toBe(0)
    expect(snap.timelines.get('art-x')?.workingHtml).toBe('<p>v1</p>')
    expect(snap.timelines.get('art-x')?.workingDirty).toBe(false)
  })
})

  it('a model-side revert while the panel is CLOSED auto-opens on the REVERTED version, not the latest', () => {
    const double = initBridge()
    const now = Date.now()
    // NO canvasBridge.open() — the panel is closed when the events land.
    double.push(snapshot([
      { kind: 'tool-result', seq: 1, time: now - 3, callId: 'c1', isError: false, resultView: { card: 'artifact', op: 'create', id: 'art-y', version: 1, html: '<p>v1</p>' } },
      { kind: 'tool-result', seq: 2, time: now - 2, callId: 'c2', isError: false, resultView: { card: 'artifact', op: 'save', id: 'art-y', version: 2, html: '<p>v2</p>' } },
      { kind: 'tool-result', seq: 3, time: now - 1, callId: 'c3', isError: false, resultView: { card: 'artifact', op: 'save', id: 'art-y', version: 3, html: '<p>v3</p>' } },
      { kind: 'tool-result', seq: 4, time: now, callId: 'c4', isError: false, resultView: { card: 'artifact', op: 'revert', id: 'art-y', version: 1, html: '<p>v1</p>' } },
    ]))
    const s = canvasBridge.getSnapshot()
    expect(s.open).toBe(true)
    expect(s.selectedId).toBe('art-y')
    expect(s.viewIndex).toBe(0)  // 版本 1 — the one reverted TO
    expect(s.timelines.get('art-y')?.workingDirty).toBe(false)
  })

  it('a FORKED session whose log only carries a tail: revert synthesizes the missing checkpoint', () => {
    const double = initBridge()
    canvasBridge.open('art-fork')
    const now = Date.now()
    // The log starts at save v8 — create/save 1..7 were cut by the fork.
    double.push(snapshot([
      { kind: 'tool-result', seq: 1, time: now - 300, callId: 'c1', isError: false, resultView: { card: 'artifact', op: 'save', id: 'art-fork', version: 8, html: '<p>v8 content</p>' } },
      { kind: 'tool-result', seq: 2, time: now - 200, callId: 'c2', isError: false, resultView: { card: 'artifact', op: 'patch', id: 'art-fork', version: 8, html: '<p>v8 + tweak 1</p>', applied: 1 } },
      { kind: 'tool-result', seq: 3, time: now - 100, callId: 'c3', isError: false, resultView: { card: 'artifact', op: 'patch', id: 'art-fork', version: 8, html: '<p>v8 + tweak 2</p>', applied: 1 } },
      { kind: 'tool-result', seq: 4, time: now, callId: 'c4', isError: false, resultView: { card: 'artifact', op: 'revert', id: 'art-fork', version: 7, html: '<p>v7 content</p>' } },
    ]))
    const s = canvasBridge.getSnapshot()
    const t = s.timelines.get('art-fork')!
    expect(t.checkpoints.map(c => c.version)).toEqual([7, 8])
    expect(t.workingDirty).toBe(false)
    expect(t.workingHtml).toBe('<p>v7 content</p>')
    // auto-jump landed on the reverted version even though the checkpoint was synthesized
    expect(s.viewIndex).toBe(0)
  })

  it('after a reload mid-fork, the restored view snaps to the checkpoint equal to the live working copy', () => {
    const double = initBridge()
    const now = Date.now()
    double.push(snapshot([
      { kind: 'tool-result', seq: 1, time: now - 200, callId: 'c1', isError: false, resultView: { card: 'artifact', op: 'save', id: 'art-fk', version: 8, html: '<p>v8</p>' } },
      { kind: 'tool-result', seq: 2, time: now - 100, callId: 'c2', isError: false, resultView: { card: 'artifact', op: 'revert', id: 'art-fk', version: 7, html: '<p>v7</p>' } },
    ]))
    canvasBridge.open('art-fk')
    // User then navigates to the synthesized older checkpoint… but the
    // initial open currently lands on v8 (latest). Simulate a RELOAD: new
    // bridge, same persisted state viewIndex → should reconcile to v7.
    const s1 = canvasBridge.getSnapshot()
    // Working copy IS v7 after the revert — "current state" semantics lands
    // the fresh open on v7 (index 0), NOT on the newest save.
    expect(s1.viewIndex).toBe(0)

    // —— new bridge instance, same session id (same localStorage key) ——
    canvasBridge.resetForTests()
    const double2 = initBridge()
    void double2 // initBridge re-inits; push the same tail again
    double2.push(snapshot([
      { kind: 'tool-result', seq: 1, time: now - 200, callId: 'c1', isError: false, resultView: { card: 'artifact', op: 'save', id: 'art-fk', version: 8, html: '<p>v8</p>' } },
      { kind: 'tool-result', seq: 2, time: now - 100, callId: 'c2', isError: false, resultView: { card: 'artifact', op: 'revert', id: 'art-fk', version: 7, html: '<p>v7</p>' } },
    ]))
    const s2 = canvasBridge.getSnapshot()
    // events are stale now (old timestamps => no auto-jump), and the
    // persisted viewIndex(1 = v8) does NOT match the live working copy (v7)
    // — reconciliation snaps the view onto v7.
    expect(s2.viewIndex).toBe(0)
  })

describe('canvas bridge navigation', () => {
  it('navigate/jumpCurrent clamp within checkpoints', () => {
    const double = initBridge()
    double.push(snapshot([
      createNode(1, { op: 'save', id: 'art-n', version: 1, html: 'v1' }),
      createNode(2, { op: 'save', id: 'art-n', version: 2, html: 'v2' }),
      createNode(3, { op: 'save', id: 'art-n', version: 3, html: 'v3' }),
    ]))
    // History exists → panel closed; select manually.
    canvasBridge.select('art-n')
    expect(canvasBridge.getSnapshot().viewIndex).toBe(2)
    canvasBridge.navigate(-1)
    expect(canvasBridge.getSnapshot().viewIndex).toBe(1)
    canvasBridge.navigate(-99)
    expect(canvasBridge.getSnapshot().viewIndex).toBe(0)
    canvasBridge.navigate(99)
    expect(canvasBridge.getSnapshot().viewIndex).toBe(2)
    canvasBridge.jumpCurrent()
    expect(canvasBridge.getSnapshot().viewIndex).toBe(2)
  })
})

describe('canvas bridge truncated-window recovery (the host index)', () => {
  it('a patch-only window (create/save truncated away) gains title + versions from the host index', async () => {
    // The web client loads a TAIL page of the session log: an old artifact's
    // create/save ops fall outside it, so the window scan yields patches only —
    // no title, zero checkpoints, and therefore no version badge, no prev/next
    // and no 下载. The host route replays the whole log / disk cache and must
    // fill those gaps, and the fill must SURVIVE later window rescans.
    const double = initBridge()
    double.push(snapshot([
      createNode(10, { op: 'patch', id: 'art-old', version: 2, html: '<p>patched</p>' }, 'c10', OLD),
    ], []))
    expect(canvasBridge.getSnapshot().timelines.get('art-old')?.title).toBeUndefined()
    expect(canvasBridge.getSnapshot().timelines.get('art-old')?.checkpoints).toHaveLength(0)

    // What the host route returns for that session.
    const versions = [
      { version: 1, html: '<p>one</p>', time: 1 },
      { version: 2, html: '<p>two</p>', time: 2 },
    ]
    const fetchStub = async (): Promise<{ ok: true; json: () => Promise<unknown> }> => ({
      ok: true,
      json: async () => ({ ok: true, artifacts: [{ id: 'art-old', version: 2, bytes: 11, html: '<p>two</p>', savedVersion: 2, title: '旧的画布', versions }] }),
    })
    const original = globalThis.fetch
    globalThis.fetch = fetchStub as unknown as typeof fetch
    try {
      canvasBridge.ensureHostIndex()
      await new Promise(resolve => setTimeout(resolve, 0))
      const merged = canvasBridge.getSnapshot().timelines.get('art-old')
      expect(merged?.title).toBe('旧的画布')
      expect(merged?.checkpoints.map(c => c.version)).toEqual([1, 2])
      expect(merged?.checkpoints[1]?.html).toBe('<p>two</p>')

      // A later rescan rebuilds the timeline map wholesale — the host fill
      // must be re-applied, not lost (the bug that made this "still broken").
      double.push(snapshot([
        createNode(10, { op: 'patch', id: 'art-old', version: 2, html: '<p>patched</p>' }, 'c10', OLD),
        createNode(11, { op: 'patch', id: 'art-old', version: 2, html: '<p>patched twice</p>' }, 'c11', OLD),
      ], []))
      const after = canvasBridge.getSnapshot().timelines.get('art-old')
      expect(after?.title).toBe('旧的画布')
      expect(after?.checkpoints.map(c => c.version)).toEqual([1, 2])
    } finally {
      globalThis.fetch = original
    }
  })

  it('an artifact entirely outside the window still gets a card (identity + content from the host)', async () => {
    const double = initBridge()
    double.push(snapshot([], []))
    const original = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ ok: true, artifacts: [{ id: 'art-gone', html: '<p>x</p>', savedVersion: 3, title: '窗口外的画布' }] }),
    })) as unknown as typeof fetch
    try {
      canvasBridge.ensureHostIndex()
      await new Promise(resolve => setTimeout(resolve, 0))
      const timeline = canvasBridge.getSnapshot().timelines.get('art-gone')
      expect(timeline?.title).toBe('窗口外的画布')
      expect(canvasBridge.getSnapshot().order).toContain('art-gone')
      expect(timeline?.checkpoints.map(c => c.version)).toEqual([3])
    } finally {
      globalThis.fetch = original
    }
  })
})
