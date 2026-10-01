// @vitest-environment jsdom
/*
 * REACHABILITY of the cross-session import picker.
 *
 * This file exists because of a shipped defect the whole unit suite could not
 * see: the picker's entry points (the header 导入 button and the empty-state
 * button) both lived inside `CanvasBody`, which `CanvasTabContent` renders ONLY
 * when `selectedId !== undefined`. On a session with no artifacts yet,
 * `selectedId` IS undefined — so neither button rendered, and the import feature
 * was unreachable from the one state where it is most useful and where this
 * plugin has no other controls at all.
 *
 * The lesson is that "the component renders" is not the property worth pinning;
 * "the control is reachable from the state that needs it" is. So this mounts the
 * REAL CanvasTabContent for the empty session and asserts the affordance is
 * present AND that clicking it actually opens the panel — the picker's own unit
 * tests passed the whole time the feature was dead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CanvasTabContent } from '../src/client/canvas/panel.tsx'
import { canvasBridge } from '../src/client/canvas/state.ts'

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = undefined
  root = undefined
  canvasBridge.resetForTests()
  vi.unstubAllGlobals()
})

/** Stub the library route so the picker can mount without a host. */
function stubLibrary(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, sessions: [] }),
  })))
}

/** Mount the real canvas tab body for an EMPTY session (no artifacts). */
async function renderEmptyCanvas(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<CanvasTabContent />)
  })
}

/** The import affordance, wherever it currently lives. */
function importButton(): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll('button') ?? [])]
    .find(b => (b.textContent ?? '').includes('从其他会话导入')) as HTMLButtonElement | undefined
}

describe('the import picker is reachable from an empty session', () => {
  it('renders 从其他会话导入 when there is no artifact at all', async () => {
    stubLibrary()
    await renderEmptyCanvas()
    // The exact state that had no entry point: first open, nothing created yet.
    expect(importButton()).toBeDefined()
  })

  it('still explains how to make an artifact, so the empty state is not replaced', async () => {
    stubLibrary()
    await renderEmptyCanvas()
    expect(container!.textContent ?? '').toContain('还没有 HTML artifact')
  })

  it('actually OPENS the picker when clicked (a dead button would pass the above)', async () => {
    stubLibrary()
    await renderEmptyCanvas()
    const button = importButton()
    expect(button).toBeDefined()
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const text = container!.textContent ?? ''
    // The panel's own chrome proves the picker mounted.
    expect(text).toContain('取消')
    expect(text).toContain('从其他会话导入')
  })

  it('returns to the canvas when the picker is cancelled', async () => {
    stubLibrary()
    await renderEmptyCanvas()
    await act(async () => {
      importButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const cancel = [...container!.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '取消')
    expect(cancel).toBeDefined()
    await act(async () => {
      cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container!.textContent ?? '').toContain('还没有 HTML artifact')
  })

  it('surfaces a library failure instead of an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })))
    await renderEmptyCanvas()
    await act(async () => {
      importButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // A 403 rendered as "no artifacts" would mislead; the reason must show.
    expect(container!.textContent ?? '').toContain('403')
  })
})

/*
 * THE POST-IMPORT REFRESH.
 *
 * An import mints its artifact SERVER-SIDE (the command picks the id — that is
 * why it wakes the model with it), so the client's host index is stale by
 * definition when the import resolves. `refreshHostList` latches after one
 * successful read, so the newly imported artifact stayed invisible and the
 * canvas kept showing the old contents until a full page reload. Found by
 * importing for real and watching the canvas not change.
 *
 * The bridge is driven through the same fake-sessions double the canvas spec
 * uses (the real `sessions.list` shape with an authoritative `current`), so the
 * host-index reads below are the bridge's OWN requests.
 */
describe('an import forces a re-read of the host index', () => {
  /** The list-index response for a set of artifact ids. */
  const listing = (...ids: string[]): unknown => ({
    ok: true,
    artifacts: ids.map(id => ({ id, html: `<p>${id}</p>`, savedVersion: 1 })),
  })

  /** Bind the bridge to a sessions double whose host index changes per read. */
  function bindBridge(responses: unknown[]): { reads: () => number } {
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!String(url).includes('/artifact/api/list')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, sessions: [] }) }
      }
      const body = responses[Math.min(reads, responses.length - 1)]
      reads += 1
      return { ok: true, status: 200, json: async () => body }
    }))
    const session = {
      getSnapshot: () => ({ nodes: [], runningCalls: [] }),
      subscribe: () => () => {},
      command: async () => ({ ok: true, value: { matched: true } }),
    }
    const sessions = {
      list: { getSnapshot: () => ({ current: 's1' }), subscribe: () => () => {} },
      binding: () => ({ sessionId: 's1', session, ctx: {} }),
    }
    canvasBridge.init({ sessions, get: () => undefined } as never)
    return { reads: () => reads }
  }

  it('re-reads the index after onImported(), past the one-shot latch', async () => {
    const { reads } = bindBridge([listing('art-old'), listing('art-old', 'art-new')])
    canvasBridge.ensureHostIndex()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    const afterFirst = reads()
    await act(async () => {
      canvasBridge.onImported()
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    // The latch would normally stop here; an import must clear it.
    expect(reads()).toBeGreaterThan(afterFirst)
  })

  it('SELECTS the newly appeared artifact, not merely any artifact', async () => {
    bindBridge([listing('art-old'), listing('art-old', 'art-new')])
    canvasBridge.ensureHostIndex()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => {
      canvasBridge.onImported()
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    // The minted id is unknowable from the client, so the selection is a DIFF —
    // selecting a pre-existing artifact instead would look like a no-op.
    expect(canvasBridge.getSnapshot().selectedId).toBe('art-new')
  })

  it('keeps the current selection when the index gained nothing new', async () => {
    bindBridge([listing('art-old'), listing('art-old')])
    canvasBridge.ensureHostIndex()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    canvasBridge.select('art-old')
    await act(async () => {
      canvasBridge.onImported()
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(canvasBridge.getSnapshot().selectedId).toBe('art-old')
  })
})

/*
 * THE PANEL WIRING for that refresh.
 *
 * The bridge tests above call `onImported()` directly, so they stay green if the
 * PICKER forgets to call it — which is exactly the shipped defect (the user
 * imports, the canvas does not change). This drives the real picker UI through a
 * successful import instead, so the wiring itself is covered.
 *
 * `submitImport` reaches the session through the bridge's captured context, so
 * the stand-in must answer `sessions.binding(id).session.command(line)`.
 */
describe('the picker refreshes the canvas after a successful import', () => {
  /** Route every fetch the picker makes; the list index changes on re-read. */
  function bindForImport(): void {
    let listReads = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url)
      const json = async (body: unknown) => ({ ok: true, status: 200, json: async () => body })
      if (target.includes('/artifact/api/library?') && target.includes('artifactId=')) {
        return json({ ok: true, artifact: { versions: [{ version: 1, time: 1000, bytes: 10 }] } })
      }
      if (target.includes('/artifact/api/library')) {
        return json({
          ok: true,
          // No session title: the client names it from displayTitle.
          // NO artifact title, so the row is labelled by its ID — which is what
          // the finder below keys on. (A titled row shows the title only.)
          sessions: [{ sessionId: 'session-src', artifacts: [{ artifactId: 'art-src', versions: 1, bytes: 10 }] }],
        })
      }
      if (target.includes('/artifact/api/list')) {
        listReads += 1
        // The FIRST read is EMPTY so nothing auto-selects and the picker stays
        // mounted (a single artifact would be auto-opened, replacing the
        // picker with the canvas body). The import must then trigger a SECOND
        // read that reveals the newly minted artifact.
        const artifacts = listReads === 1
          ? []
          : [{ id: 'art-src', html: '<p>src</p>', savedVersion: 1 }]
        return json({ ok: true, artifacts })
      }
      return json({ ok: true })
    }))
    const session = {
      getSnapshot: () => ({ nodes: [], runningCalls: [] }),
      subscribe: () => () => {},
      command: async () => ({ ok: true, value: { matched: true } }),
    }
    const sessions = {
      list: {
        getSnapshot: () => ({ current: 's1', ids: ['s1'], byId: { s1: { id: 's1', displayTitle: '当前会话' } } }),
        subscribe: () => () => {},
      },
      binding: () => ({ sessionId: 's1', session, ctx: {} }),
    }
    canvasBridge.init({ sessions, get: () => undefined } as never)
    // No explicit ensureHostIndex: the tab body's mount effect performs the
    // first read, so the read count reflects the real lifecycle.
  }

  it('selects the imported artifact, proving the picker called onImported()', async () => {
    bindForImport()
    await renderEmptyCanvas()
    // The picker is reachable from the empty state (the earlier fix).
    const open = importButton()
    expect(open).toBeDefined()
    await act(async () => {
      open!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    // Choose the source artifact, which loads its versions.
    const sourceRow = [...container!.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('art-src'))
    expect(sourceRow).toBeDefined()
    await act(async () => {
      sourceRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    // Import.
    const submit = [...container!.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim().endsWith('导入') && !(b.textContent ?? '').includes('从其他会话'))
    expect(submit).toBeDefined()
    await act(async () => {
      submit!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    // Only the panel's own onImported() call can have produced this: the host
    // index would still be latched on its first read otherwise.
    expect(canvasBridge.getSnapshot().selectedId).toBe('art-src')
  })
})
