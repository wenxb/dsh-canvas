/**
 * Collapsing the chat flow item for a tool call that draws nothing.
 *
 * THE PROBLEM: the artifact tool produces ops the user should NOT see as chat
 * blocks — `patch` (an edit inside the working copy; versions are the blocks
 * that matter), and every non-create op while still running. Returning `null`
 * from the toolview component is not enough: the host renders each tool call
 * inside its own flow item, and the chat column is a FLEX list with a gap, so a
 * bare `null` leaves one empty flow item per hidden call standing. A run of
 * four patches stranded an ~80px blank band mid-conversation.
 *
 * WHY THIS TOUCHES THE DOM: there is no supported way for a `tool.call.toolview`
 * component to say "render nothing at all, including my flow item". The slot
 * contract gives a component a place INSIDE the item, not control over the item
 * itself. So the wrapper has to be hidden by walking up from our own node. This
 * is the one place in the plugin that reaches outside its own subtree, and it
 * is confined here deliberately.
 *
 * FRAGILITY, AND HOW IT IS CONTAINED: the walk depends on host-owned attributes
 * (`data-chat-call-id`, `data-chat-flow-kind`, `data-slot`). If a host release
 * renames them, the walk finds nothing and the blank band returns — the failure
 * mode is COSMETIC (a gap), never a broken or hidden message, because:
 *   - we only ever set `display: none` and restore the exact prior value;
 *   - nothing is removed from the DOM, so no state or scroll anchor is lost;
 *   - `detectFlowItemSupport()` (below) reports clearly when the contract is
 *     gone, which is what a future test should assert on. A previous version of
 *     this code failed SILENTLY (the gap reappeared with no signal anywhere).
 *
 * MUST BE IDEMPOTENT: several hidden rows coexist (a run of patches), each with
 * its own effect. The original display value is captured per element and
 * restored on cleanup, so an unmount in any order restores what that row
 * changed rather than clobbering another row's state.
 */

/** Host attributes this module depends on. Kept in one place so a rename is a
 *  single edit and a test can assert the live DOM still matches. */
const CALL_ROW_ATTR = 'data-chat-call-id'
const FLOW_KIND_ATTR = 'data-chat-flow-kind'
const FLOW_KEY_ATTR = 'data-chat-flow-key'
const SLOT_ATTR = 'data-slot'
const CONVERSATION_NODE_SLOT = 'conversation.chat.node'

/**
 * Whether the host still exposes the flow-item markers this module walks.
 *
 * A probe for diagnostics and tests: returns the reason it could not find an
 * item, rather than throwing or silently doing nothing.
 * @param element - any node inside the conversation (e.g. our own hidden div).
 * @returns `{ ok: true }` when a flow item was located.
 */
export function detectFlowItemSupport(
  element: Element | null,
): { ok: true } | { ok: false; reason: string } {
  if (element === null) return { ok: false, reason: 'no element (not mounted)' }
  const callRow = element.closest(`[${CALL_ROW_ATTR}]`)
  if (callRow === null) {
    return { ok: false, reason: `no ancestor carries [${CALL_ROW_ATTR}] — host renamed it?` }
  }
  const flowItem = findFlowItem(element)
  if (flowItem === null) {
    return {
      ok: false,
      reason: `no ancestor carries [${FLOW_KIND_ATTR}]/[${FLOW_KEY_ATTR}] or [${SLOT_ATTR}=${CONVERSATION_NODE_SLOT}] — host renamed the flow item?`,
    }
  }
  return { ok: true }
}

/** The flow item containing this node, via the host markers, with the slot
 *  parent as a fallback for hosts that stopped emitting the flow attributes. */
function findFlowItem(element: Element): HTMLElement | null {
  const viaFlow = element.closest<HTMLElement>(`[${FLOW_KIND_ATTR}], [${FLOW_KEY_ATTR}]`)
  if (viaFlow !== null) return viaFlow
  const node = element.closest(`[${SLOT_ATTR}="${CONVERSATION_NODE_SLOT}"]`)
  const parent = node?.parentElement
  return parent instanceof HTMLElement ? parent : null
}

/** What one row hid, so cleanup restores exactly that. */
interface HiddenTargets {
  callRow: HTMLElement | undefined
  flowItem: HTMLElement | undefined
}

/**
 * How many hidden rows currently need each element hidden, and the display
 * value to restore once the LAST of them releases it.
 *
 * Without this, two hidden rows sharing one element clobber each other: the
 * first hides it, the second captures `'none'` as "the value I must restore",
 * and unmounting the first restores `'none'`... or, worse, unmounting the
 * second restores `'none'` and the element that should have become visible again
 * stays hidden. Reference counting makes each row's effect independent of the
 * order its siblings mount and unmount.
 *
 * A WeakMap so a detached element (the conversation scrolls, nodes are
 * recycled) does not leak its entry.
 */
interface HideBookkeeping {
  count: number
  originalDisplay: string
}
const hideBookkeeping = new WeakMap<HTMLElement, HideBookkeeping>()

/** Hide one element, remembering the display to restore after the last
 *  release. Idempotent per element across any number of callers. */
function acquireHide(element: HTMLElement): void {
  const existing = hideBookkeeping.get(element)
  if (existing !== undefined) {
    existing.count += 1
    return
  }
  hideBookkeeping.set(element, { count: 1, originalDisplay: element.style.display })
  element.style.display = 'none'
}

/** Release one hide of an element; restores the original display when the last
 *  holder lets go. */
function releaseHide(element: HTMLElement): void {
  const entry = hideBookkeeping.get(element)
  if (entry === undefined) return
  entry.count -= 1
  if (entry.count > 0) return
  hideBookkeeping.delete(element)
  element.style.display = entry.originalDisplay
}

/**
 * Hide the chat flow item around a node that rendered nothing.
 * @param element - our own (already invisible) node inside the flow item.
 * @returns a restore function; call it on unmount.
 */
export function hideFlowItemAround(element: HTMLElement | null): () => void {
  if (element === null) return () => {}
  const targets: HiddenTargets = { callRow: undefined, flowItem: undefined }

  const callRow = element.closest<HTMLElement>(`[${CALL_ROW_ATTR}]`)
  if (callRow !== null) {
    acquireHide(callRow)
    targets.callRow = callRow
  }

  const flowItem = findFlowItem(element)
  // Only collapse the flow item when it exists SOLELY for this call. A node
  // that shares its item with other content (childElementCount > 1) must stay
  // visible; hiding it would take unrelated content with it. The one exception
  // is an artifact-draft item, which is ours by construction.
  const oursAlone = flowItem !== null
    && (flowItem.dataset.chatFlowKind === 'artifact-draft' || flowItem.childElementCount === 1)
  if (flowItem !== null && oursAlone) {
    acquireHide(flowItem)
    targets.flowItem = flowItem
  }

  return () => {
    if (targets.callRow !== undefined) releaseHide(targets.callRow)
    if (targets.flowItem !== undefined) releaseHide(targets.flowItem)
  }
}

/**
 * Undo a hide performed by a row that became VISIBLE again (a running create
 * settles into a real card, so the item must come back).
 *
 * Releases this row's hold rather than writing `''` directly, so a sibling row
 * that still needs the element hidden keeps it hidden.
 * @param element - our node, now rendering real content.
 */
export function revealFlowItemAround(element: HTMLElement | null): void {
  if (element === null) return
  const callRow = element.closest<HTMLElement>(`[${CALL_ROW_ATTR}]`)
  if (callRow !== null) releaseHide(callRow)
  const flowItem = findFlowItem(element)
  if (flowItem !== null) releaseHide(flowItem)
}