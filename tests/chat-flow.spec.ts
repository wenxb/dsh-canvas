// @vitest-environment jsdom
/*
 * The chat-flow collapse, against a stand-in for the host's chat DOM.
 *
 * This module reaches outside the plugin's own subtree to hide the flow item of
 * a tool call that renders nothing, because a `tool.call.toolview` component
 * cannot otherwise say "and remove my wrapper too" — and leaving the wrapper
 * standing strands a blank band per hidden call in the host's gapped flex list.
 *
 * The host markup is reconstructed from its attribute contract, which is the
 * point of these tests: they pin the CONTRACT (which ancestors get hidden, that
 * restoration is exact, and that a shared item is never taken down), so a
 * change here is a deliberate decision rather than an accident. What they
 * cannot do is guarantee a future host still emits those attributes — that is
 * what detectFlowItemSupport() reports at runtime.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { detectFlowItemSupport, hideFlowItemAround, revealFlowItemAround } from '../src/client/chat-flow.ts'

/** Build the host's structure:
 *  flowItem[data-chat-flow-kind] > callRow[data-chat-call-id] > slot > ourNode
 *  with an optional sibling to simulate a shared flow item. */
function buildHostDom(options: { shared?: boolean; display?: string } = {}): {
  ourNode: HTMLElement
  callRow: HTMLElement
  flowItem: HTMLElement
} {
  document.body.innerHTML = ''
  const list = document.createElement('div')
  list.style.display = 'flex'
  list.style.gap = '8px'
  const flowItem = document.createElement('div')
  flowItem.setAttribute('data-chat-flow-kind', 'tool')
  if (options.display !== undefined) flowItem.style.display = options.display
  const callRow = document.createElement('div')
  callRow.setAttribute('data-chat-call-id', 'call-1')
  const slot = document.createElement('div')
  slot.setAttribute('data-slot', 'conversation.chat.node')
  const ourNode = document.createElement('div')
  ourNode.setAttribute('data-artifact-hidden', 'true')
  ourNode.style.display = 'none'
  slot.append(ourNode)
  callRow.append(slot)
  flowItem.append(callRow)
  if (options.shared === true) {
    const sibling = document.createElement('div')
    sibling.textContent = 'unrelated content'
    flowItem.append(sibling)
  }
  list.append(flowItem)
  document.body.append(list)
  return { ourNode, callRow, flowItem }
}

beforeEach(() => { document.body.innerHTML = '' })

describe('detectFlowItemSupport', () => {
  it('reports ok when the host markers are present', () => {
    const { ourNode } = buildHostDom()
    expect(detectFlowItemSupport(ourNode)).toEqual({ ok: true })
  })

  it('names the missing attribute when the host renamed the call row', () => {
    const { ourNode } = buildHostDom()
    document.querySelector('[data-chat-call-id]')!.removeAttribute('data-chat-call-id')
    const result = detectFlowItemSupport(ourNode)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('data-chat-call-id')
  })

  it('falls back to the slot parent when the flow attributes are gone', () => {
    // A host that drops data-chat-flow-* but keeps the slot: the fallback path
    // must still find an item, so the blank band does not silently return.
    const { ourNode } = buildHostDom()
    document.querySelector('[data-chat-flow-kind]')!.removeAttribute('data-chat-flow-kind')
    expect(detectFlowItemSupport(ourNode)).toEqual({ ok: true })
  })

  it('reports a reason when nothing is mounted', () => {
    const result = detectFlowItemSupport(null)
    expect(result.ok).toBe(false)
  })
})

describe('hideFlowItemAround', () => {
  it('hides both the call row and the flow item', () => {
    const { ourNode, callRow, flowItem } = buildHostDom()
    hideFlowItemAround(ourNode)
    expect(callRow.style.display).toBe('none')
    expect(flowItem.style.display).toBe('none')
  })

  it('restores the EXACT prior display value, not an empty string', () => {
    // Restoring '' would clobber a display the host deliberately set.
    const { ourNode, flowItem } = buildHostDom({ display: 'block' })
    const restore = hideFlowItemAround(ourNode)
    expect(flowItem.style.display).toBe('none')
    restore()
    expect(flowItem.style.display).toBe('block')
  })

  it('never hides a flow item that carries other content', () => {
    // A shared item stays visible: hiding it would take unrelated content down
    // with it, which is worse than a cosmetic gap.
    const { ourNode, callRow, flowItem } = buildHostDom({ shared: true })
    hideFlowItemAround(ourNode)
    expect(callRow.style.display).toBe('none')
    expect(flowItem.style.display).not.toBe('none')
  })

  it('is idempotent across coexisting hidden rows (a run of patches)', () => {
    // Two hidden rows in the SAME flow item: the second must not capture the
    // first's 'none' as the value to restore, or unmounting one would un-hide
    // the other's item.
    const { ourNode, callRow, flowItem } = buildHostDom()
    const second = document.createElement('div')
    second.setAttribute('data-chat-call-id', 'call-2')
    callRow.append(second)
    const restoreA = hideFlowItemAround(ourNode)
    const restoreB = hideFlowItemAround(second)
    restoreA()
    // B has not been restored, so the item must STILL be hidden.
    expect(flowItem.style.display).toBe('none')
    restoreB()
    expect(flowItem.style.display).toBe('')
  })

  it('is a no-op for a null element', () => {
    expect(() => hideFlowItemAround(null)()).not.toThrow()
  })
})

describe('revealFlowItemAround', () => {
  it('brings back an item a previous hidden state collapsed', () => {
    // A running create is hidden while it has no html, then settles into a real
    // card: the collapse performed earlier must be undone.
    const { ourNode, callRow, flowItem } = buildHostDom()
    hideFlowItemAround(ourNode)
    expect(flowItem.style.display).toBe('none')
    revealFlowItemAround(ourNode)
    expect(flowItem.style.display).toBe('')
    expect(callRow.style.display).toBe('')
  })

  it('leaves a host-set display alone when the item was never hidden', () => {
    const { ourNode, flowItem } = buildHostDom({ display: 'block' })
    revealFlowItemAround(ourNode)
    expect(flowItem.style.display).toBe('block')
  })
})