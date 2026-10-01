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
