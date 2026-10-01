/**
 * The `artifact-draft` chat node: a ConversationNodeDefinition (registered on
 * the runtime's `conversationEvents` service — no ui-conversation value
 * imports) that folds the model's STREAMING artifact calls into a live chat
 * node. While the model writes a `create` call's html token by token, the
 * accumulated `tool-call-delta` arguments are parsed tolerantly and published
 * as a draft node the browser half renders into a persistent bridge iframe
 * (no per-chunk iframe reload). The draft hides once the call is announced
 * (`tool/call`) — the settled/announced tool row takes over — and never
 * appears for patch/read/destroy/list calls (their args carry no html).
 *
 * The Definition follows the engine contract like the shipped assistant-step
 * Definition: identity is the `turn:step` of the streaming events, matched
 * events carry `role: 'update'`, and `step/start` is the single `start`.
 * @module
 */
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

function conversationContextKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`
}
import { extractStreamingHtml, extractStreamingTitle, isStreamingCreate } from './extract.ts'

/** The wire shape of one streamed artifact call inside the Definition state. */
interface DraftCall {
  callId: string
  /** Accumulated tool-call arguments text (partial JSON while streaming). */
  argsRaw: string
  /** The html argument extracted so far (empty until the `html` key arrives). */
  html: string
  /** Whether the args have yielded an html value yet (a create call's draft). */
  hasHtml: boolean
  /** The title argument so far, when it has completed. */
  title?: string
  /** Whether `tool/call` arrived (the keyed tool row now owns the display). */
  announced: boolean
  /** Whether `tool/result` arrived (the draft is done either way). */
  settled: boolean
  /** Whether the owning step ended with this call unfinished (interrupt —
   *  crash-disconnect recovery synthesizes the missing `step/end`): the
   *  draft is permanently dead and must stop showing 正在生成. */
  dead: boolean
}

interface ArtifactDraftState {
  readonly turn: number
  readonly step: number
  readonly calls: ReadonlyMap<string, DraftCall>
}

/** The data of one rendered `artifact-draft` chat node. */
export interface ArtifactDraftData {
  /** The streamed artifact call's id. */
  callId: string
  /** The html streamed so far. */
  html: string
  /** The completed title argument so far, when it has arrived. */
  title?: string
}

// The data map belongs to ui-chat (`contract/chat-nodes.d.ts`), NOT to
// ui-conversation — merging onto the wrong module typechecks as a no-op and
// leaves 'artifact-draft' an illegal node kind for any consumer that uses
// ChatNode<'artifact-draft'>. Mirrors how the shipped node definitions
// (conversation-nodes/*.d.ts) augment it.
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Live artifact draft: renders the model's streaming create html. */
    'artifact-draft': ArtifactDraftData
  }
}

function initialState(turn: number, step: number): ArtifactDraftState {
  return { turn, step, calls: new Map() }
}

/**
 * Whether one event carries an assistant streaming frame.
 *
 * DSH 0.1.5 delivers client-only stream frames as `assistant/live-chunk`
 * (`AssistantLiveChunkEvent`, carrying `{attemptId, turn, step, chunk}`);
 * the earlier durable name `assistant/chunk` is gone from the client event
 * vocabulary. Matching only the old name made the streaming draft never
 * appear — the live preview silently stopped updating during generation.
 * Accept both so the draft keeps working across host versions.
 * @param event - candidate client event.
 * @returns true when it is a streaming-chunk frame.
 */
/** The client streaming frame's data shape (structural — the wire type is not
 *  re-imported here). */
export interface LiveChunkEvent {
  type: 'assistant/live-chunk' | 'assistant/chunk'
  seq: number
  time: number
  data: { turn: number; step: number; chunk: { type: string; [key: string]: unknown } }
}

/**
 * Type guard for one assistant streaming frame: narrows a client event union to
 * the live-chunk shape so the draft's `data.chunk` reads type-check.
 * @param event - candidate client event.
 * @returns true when the event is a streaming-chunk frame.
 */
function isLiveChunk(event: { type: string }): event is LiveChunkEvent & { type: string } {
  return event.type === 'assistant/live-chunk' || event.type === 'assistant/chunk'
}

/** Step identity used by every matched event (mirrors the assistant Definition). */
function stepId(event: { data: { turn: number; step: number } }): string {
  return `${event.data.turn}:${event.data.step}`
}

/** Narrow a block-end tool-call content block (structural: the wire block
 *  shape is not re-imported here). */
function asArtifactToolCall(block: unknown): { id: string; arguments: string } | null {
  if (block === null || typeof block !== 'object') return null
  const candidate = block as Record<string, unknown>
  if (candidate.type !== 'tool-call' || candidate.name !== 'artifact') return null
  if (typeof candidate.id !== 'string' && typeof candidate.id !== 'number') return null
  if (typeof candidate.arguments !== 'string') return null
  return { id: String(candidate.id), arguments: candidate.arguments }
}

function draftCall(callId: string, argsRaw: string, previous: DraftCall | undefined): DraftCall {
  const extracted = extractStreamingHtml(argsRaw)
  const title = extractStreamingTitle(argsRaw)
  return {
    callId,
    argsRaw,
    html: extracted?.html ?? '',
    hasHtml: extracted !== null,
    ...title === undefined ? {} : { title },
    announced: previous?.announced ?? false,
    settled: previous?.settled ?? false,
    dead: previous?.dead ?? false,
  }
}

/**
 * Fold one matched event into the draft state.
 * @param state - current Definition state.
 * @param match - the accepted event.
 * @returns the next state.
 */
export function updateDraftState(state: ArtifactDraftState, match: ConversationMatch): ArtifactDraftState {
  const event = match.event
  if (isLiveChunk(event)) {
    const chunk = event.data.chunk
    if (chunk.type === 'tool-call-delta' && chunk.name === 'artifact') {
      const callId = String(chunk.id)
      const calls = new Map(state.calls)
      const previous = calls.get(callId)
      calls.set(callId, draftCall(callId, (previous?.argsRaw ?? '') + chunk.argumentsDelta, previous))
      return { ...state, calls }
    }
    if (chunk.type === 'block-end') {
      const call = asArtifactToolCall(chunk.block)
      if (call === null) return state
      const calls = new Map(state.calls)
      calls.set(call.id, draftCall(call.id, call.arguments, calls.get(call.id)))
      return { ...state, calls }
    }
    return state
  }
  if (event.type === 'tool/call') {
    const calls = new Map(state.calls)
    const existing = calls.get(event.data.callId)
    if (existing !== undefined) {
      calls.set(event.data.callId, { ...existing, announced: true })
    } else {
      for (const [id, call] of calls) {
        calls.set(id, { ...call, announced: true })
      }
    }
    return { ...state, calls }
  }
  if (event.type === 'tool/result') {
    const source = event.data.message.source
    const calls = new Map(state.calls)
    const existing = calls.get(source.callId)
    if (existing !== undefined) {
      calls.set(source.callId, { ...existing, settled: true })
    } else {
      for (const [id, call] of calls) {
        calls.set(id, { ...call, settled: true })
      }
    }
    return { ...state, calls }
  }
  if (event.type === 'step/end') {
    // Step closed with a call never announced/settled: the stream died
    // (disconnect, cancellation, abort — crash recovery synthesizes this
    // step/end). Every unfinished call in this step is permanently dead; the
    // retried attempt lives in a NEW step with its own draft node.
    let touched = false
    const calls = new Map(state.calls)
    for (const [callId, call] of calls) {
      if (call.settled || call.dead) continue
      calls.set(callId, { ...call, dead: true })
      touched = true
    }
    return touched ? { ...state, calls } : state
  }
  return state
}

/** Find the streamed call worth rendering: the newest create draft still
 *  owned by the tool row lifecycle (not announced, not settled). */
function activeDraft(state: ArtifactDraftState): DraftCall | undefined {
  let active: DraftCall | undefined
  for (const call of state.calls.values()) {
    if (call.announced || call.settled || call.dead || !call.hasHtml || !isStreamingCreate(call.argsRaw)) continue
    active = call
  }
  return active
}

/**
 * The artifact-draft Definition: streams the model's in-flight `artifact
 * create` html into a live chat node, hiding once the tool call is announced
 * or settled (the keyed tool row owns the settled display).
 */
export const artifactDraftDefinition: ConversationNodeDefinition<ArtifactDraftState> = {
  kind: 'artifact-draft',
  target: 'chat',
  match(event) {
    if (event.type === 'step/start') return { id: stepId(event), role: 'start' }
    if (isLiveChunk(event)) {
      const chunk = event.data.chunk
      if (chunk.type === 'tool-call-delta' && chunk.name === 'artifact') {
        return { id: stepId(event), role: 'update' }
      }
      if (chunk.type === 'block-end') {
        if (asArtifactToolCall(chunk.block) !== null) return { id: stepId(event), role: 'update' }
      }
      return null
    }
    if (event.type === 'tool/call' && event.data.name === 'artifact') {
      return { id: stepId(event), role: 'update' }
    }
    if (event.type === 'tool/result') {
      // The result carries no tool name; the update filters by callId, and an
      // unrelated result for the same step is a no-op.
      return { id: stepId(event), role: 'update' }
    }
    if (event.type === 'step/end') {
      // Interrupt (disconnect/cancel) closes the step with unfinished calls:
      // the synthesized step/end is what retires the 正在生成 draft forever.
      return { id: stepId(event), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'step/start') throw new Error('artifact-draft start requires step/start')
    return initialState(match.event.data.turn, match.event.data.step)
  },
  update: (context, match) => updateDraftState(context.state, match),
  publication: (match) => {
    if (isLiveChunk(match.event)
      && match.event.data.chunk.type === 'tool-call-delta') {
      return 'animation-frame'
    }
    return 'immediate'
  },
  buildViewNode(context) {
    const state = context.state
    const active = state === undefined ? undefined : activeDraft(state)
    if (active === undefined) {
      // The engine forbids withdrawing a target this Definition has already
      // materialized: when a previous build produced a visible node, keep the
      // SAME key with hidden visibility (the settled tool row takes over);
      // when nothing was ever materialized, there is nothing to hide.
      const current = context.current.get('chat')
      if (current === undefined || current === null) return null
      return { ...current, visibility: 'hidden' }
    }
    // Anchor at the first streamed artifact delta so the draft sits where the
    // model started writing the call.
    let anchorSeq = context.start?.event.seq ?? 0
    for (const match of context.matches) {
      if (!isLiveChunk(match.event)) continue
      const chunk = match.event.data.chunk
      if (chunk.type === 'tool-call-delta' && chunk.name === 'artifact') {
        anchorSeq = match.event.seq
        break
      }
    }
    return {
      key: conversationContextKey('artifact-draft', context.id),
      kind: 'artifact-draft',
      id: context.id,
      target: 'chat',
      anchorSeq,
      location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: { callId: active.callId, html: active.html, ...active.title === undefined ? {} : { title: active.title } },
    }
  },
}
