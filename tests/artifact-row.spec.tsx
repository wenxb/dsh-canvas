// @vitest-environment jsdom
/**
 * The compact in-chat artifact card: renders the Chinese status line for a
 * settled card, and clicking the row opens the canvas panel on that artifact.
 * @module
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { ArtifactRow } from '../src/client/ArtifactRow.tsx'
import { canvasBridge } from '../src/client/canvas/state.ts'

afterEach(() => {
  canvasBridge.close()
  document.body.innerHTML = ''
})

function settledBlock(view: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 1,
    callId: 'c1',
    isError: false,
    resultView: { card: 'artifact', ...view },
  }
}

const baseProps = {
  callId: 'c1',
  toolName: 'artifact',
  cwd: undefined,
  openFile: (): void => {},
  inspect: undefined,
}

/** Seed the singleton canvas bridge with a session whose conversation carries
 *  `nodes` (settled) and `runningCalls` (in-flight) — drives zombie marking. */
function seedBridge(nodes: unknown[], runningCalls: unknown[]): void {
  let current = { nodes, runningCalls }
  const session = {
    getSnapshot: (): typeof current => current,
    subscribe: (): (() => void) => () => {},
    command: async (): Promise<{ ok: true; value: { matched: true } }> => ({ ok: true, value: { matched: true } }),
  }
  const sessions = {
    list: {
      getSnapshot: (): { current: string } => ({ current: 's1' }),
      subscribe: (): (() => void) => () => {},
    },
    binding: (_id: string): { session: typeof session } => ({ session }),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  canvasBridge.init({ sessions, get: () => undefined } as any)
}

describe('ArtifactRow (compact card)', () => {
  it('renders the Chinese status line and opens the panel on click', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const block = settledBlock({ op: 'save', id: 'art-x', version: 3, html: '<p>x</p>', title: '演示' }) as never
    act(() => {
      root.render(<ArtifactRow {...baseProps} block={block} />)
    })
    expect(document.body.textContent).toContain('演示')
    expect(document.body.textContent).toContain('已保存为 版本 3')
    act(() => {
      host.firstElementChild?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(canvasBridge.getSnapshot().open).toBe(true)
    expect(canvasBridge.getSnapshot().selectedId).toBe('art-x')
    act(() => {
      root.unmount()
    })
  })

  it('a settled patch renders NO visible block (HiddenRow marker, flow item is collapsed)', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const block = settledBlock({ op: 'patch', id: 'art-p', version: 1, html: '<p>x</p>', applied: 2 }) as never
    act(() => {
      root.render(<ArtifactRow {...baseProps} block={block} />)
    })
    expect(host.textContent?.trim()).toBe('')
    expect(host.querySelector('[data-artifact-hidden="true"]')).not.toBeNull()
    act(() => {
      root.unmount()
    })
  })

  it('a running create renders the generation hint', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const block = { callId: 'c2', name: 'artifact', argsRaw: '{"op":"create","title":"生成中"}', turn: 0, step: 0, time: 0, callView: null, subCalls: [] } as never
    act(() => {
      root.render(<ArtifactRow {...baseProps} callId="c2" block={block} />)
    })
    expect(document.body.textContent).toContain('正在生成「生成中」…')
    act(() => {
      root.unmount()
    })
  })

  it('a zombie running call (disconnect survivor superseded by a retry settle) renders NOTHING', () => {
    // Timeline already holds a settle for art-x that postdates 'ghost': the
    // bridge marks 'ghost' zombie; the chat row must hide instead of forever
    // showing 正在修改….
    const base = Date.now() - 30_000
    seedBridge(
      [{ kind: 'tool-result', seq: 1, time: base + 10_000, callId: 'retry', isError: false, resultView: { card: 'artifact', op: 'patch', id: 'art-x', version: 1, html: '<p>2</p>', applied: 1 } }],
      [{ callId: 'ghost', name: 'artifact', argsRaw: '{"op":"patch","id":"art-x"}', turn: 0, step: 0, time: base + 2_000, callView: null, subCalls: [] }],
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const block = { callId: 'ghost', name: 'artifact', argsRaw: '{"op":"patch","id":"art-x"}', turn: 0, step: 0, time: base + 2_000, callView: null, subCalls: [] } as never
    act(() => {
      root.render(<ArtifactRow {...baseProps} callId="ghost" block={block} />)
    })
    expect(host.textContent?.trim()).toBe('')
    expect(host.querySelector('[data-artifact-hidden="true"]')).not.toBeNull()
    act(() => {
      root.unmount()
    })
  })

  it('a live running patch renders NOTHING (HiddenRow, silent in chat)', () => {
    seedBridge(
      [{ kind: 'tool-result', seq: 1, time: Date.now() - 60_000, callId: 'c0', isError: false, resultView: { card: 'artifact', op: 'create', id: 'art-x', version: 1, html: '<p>1</p>' } }],
      [{ callId: 'p1', name: 'artifact', argsRaw: '{"op":"patch","id":"art-x"}', turn: 0, step: 1, time: Date.now(), callView: null, subCalls: [] }],
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const block = { callId: 'p1', name: 'artifact', argsRaw: '{"op":"patch","id":"art-x"}', turn: 0, step: 1, time: Date.now(), callView: null, subCalls: [] } as never
    act(() => {
      root.render(<ArtifactRow {...baseProps} callId="p1" block={block} />)
    })
    expect(host.textContent?.trim()).toBe('')
    expect(host.querySelector('[data-artifact-hidden="true"]')).not.toBeNull()
    act(() => {
      root.unmount()
    })
  })

  it('a running call with partial/unparsed non-create args renders NOTHING (HiddenRow, never shows 正在生成)', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const block = { callId: 'p2', name: 'artifact', argsRaw: '{"id":"art-x"', turn: 0, step: 1, time: Date.now(), callView: null, subCalls: [] } as never
    act(() => {
      root.render(<ArtifactRow {...baseProps} callId="p2" block={block} />)
    })
    expect(host.textContent?.trim()).toBe('')
    expect(host.querySelector('[data-artifact-hidden="true"]')).not.toBeNull()
    act(() => {
      root.unmount()
    })
  })

  it('a running create with unparsed args (streaming isStreamingCreate) renders the generation hint', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const block = { callId: 'c3', name: 'artifact', argsRaw: '{"op":"create","title":"流式标题","html":"<p>', turn: 0, step: 0, time: 0, callView: null, subCalls: [] } as never
    act(() => {
      root.render(<ArtifactRow {...baseProps} callId="c3" block={block} />)
    })
    expect(document.body.textContent).toContain('正在生成「流式标题」…')
    act(() => {
      root.unmount()
    })
  })

  it('a preparing create with streaming HTML reports stream to canvasBridge and renders the generating card', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const block = { callId: 'c4', name: 'artifact', turn: 0, step: 0, time: 0, phase: 'preparing', subCalls: [] } as never
    act(() => {
      root.render(
        <ArtifactRow
          {...baseProps}
          callId="c4"
          block={block}
          useToolCallArgumentsPartial={() => '{"op":"create","title":"实时流式","html":"<h1>live</h1>"}'}
        />,
      )
    })
    expect(document.body.textContent).toContain('正在生成「实时流式」…')
    expect(canvasBridge.getSnapshot().reportedStream).toEqual({
      callId: 'c4',
      html: '<h1>live</h1>',
      title: '实时流式',
    })
    act(() => {
      root.unmount()
    })
    expect(canvasBridge.getSnapshot().reportedStream).toBeUndefined()
  })
})

describe('ArtifactDraftNodeView (streaming generation card)', () => {
  it('reports streaming HTML to canvasBridge and renders the generation hint', async () => {
    const { ArtifactDraftNodeView } = await import('../src/client/stream/DraftSurface.tsx')
    const host = document.createElement('div')
    document.body.appendChild(host)

    const root = createRoot(host)
    act(() => {
      root.render(
        <ArtifactDraftNodeView
          node={{ data: { callId: 'c_stream', html: '<div>streaming</div>', title: '测试' }, kind: 'artifact-draft' }}
          openFile={() => {}}
        />,
      )
    })

    // Stream reported to canvasBridge
    expect(canvasBridge.getSnapshot().reportedStream).toEqual({
      callId: 'c_stream',
      html: '<div>streaming</div>',
      title: '测试',
    })

    // Displays the in-flight generating card
    expect(document.body.textContent).toContain('正在生成「测试」…')
    expect(document.body.textContent).toContain('完成后可在画布中查看')

    // Clicking opens the canvas panel
    act(() => {
      host.firstElementChild?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(canvasBridge.getSnapshot().open).toBe(true)

    // Unmount clears the reported stream
    act(() => {
      root.unmount()
    })
    expect(canvasBridge.getSnapshot().reportedStream).toBeUndefined()
  })
})
