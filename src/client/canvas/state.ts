/**
 * Canvas bridge: the module-singleton store behind the artifact canvas panel.
 * Slot entries receive no cross-session state, so the bridge holds the
 * sessions service itself, follows the CURRENT session's conversation
 * snapshot, and republishes a small React-facing state object:
 *
 * - version histories are RECONSTRUCTED from the timeline (see ./scan.ts) —
 *   every settled create/patch/save/revert/read carries full HTML;
 * - the in-flight create is tracked twice: the draft chat-node reports delta
 *   html here (`reportStream`), and announced-but-unsettled calls are read
 *   off `snapshot.runningCalls` (complete args at announce time);
 * - PANEL STATE IS PER-SESSION: open/selection/viewIndex live in a Map keyed by
 *   session id — switching sessions swaps to that session's state (closed
 *   unless it was left open there), never leaking across;
 * - THE CANVAS IS A NATIVE SIDEBAR TAB: dsh-better-sidebar (required peer)
 *   registers it into DSH's own right sidebar — width, fullscreen, collapse,
 *   resize and per-session layout are the native panel's; the plugin owns only
 *   the tab body;
 * - AUTO-OPEN: a NEW version event (settled create/save/revert, fresh in
 *   wall-clock terms) opens the panel when the session's state is closed —
 *   the Gemini-canvas behavior.
 *
 * The same singleton delivers interaction submissions and user-side reverts
 * through slash commands bound to the current session.
 * @module
 */
import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { RunningToolCall } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface ConversationSnapshot {
  readonly nodes?: readonly unknown[]
  readonly runningCalls?: readonly RunningToolCall[]
}

/**
 * One Conversation view snapshot as the host publishes it. Current hosts keep
 * the transcript in the `chat` view's `legacy` slice
 * (`uiConversation.binding(id).target('chat')` → `ChatSnapshot`); hosts that
 * predate the view split exposed `nodes`/`runningCalls` top-level (and the
 * Session lifecycle snapshot carried them too).
 */
interface ChatViewSnapshot {
  readonly nodes?: readonly unknown[]
  readonly runningCalls?: readonly RunningToolCall[]
  readonly legacy?: {
    readonly nodes?: readonly unknown[]
    readonly runningCalls?: readonly RunningToolCall[]
  }
}

/** The `chat` Conversation view source (structurally typed — never imported). */
interface ChatViewSource {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/** The structural slice of the `uiConversation` service this bridge needs. */
interface UiConversationFace {
  binding(source: unknown): { target(target: string): ChatViewSource } | undefined
}

/**
 * Fold whichever transcript shape a host publishes into the local snapshot
 * record: the `chat` view's `legacy` slice on current hosts, the top-level
 * fields on older ones.
 * @param snapshot - a `chat` view snapshot (or a legacy conversation snapshot).
 * @returns the transcript half, with absent fields left undefined.
 */
function transcriptOf(snapshot: unknown): ConversationSnapshot {
  const record = snapshot as ChatViewSnapshot | null | undefined
  if (record === null || record === undefined) return {}
  // `exactOptionalPropertyTypes` forbids explicit `undefined` on optional
  // fields, so absent halves are OMITTED rather than set to undefined.
  const source = record.legacy !== undefined && record.legacy !== null ? record.legacy : record
  let nodes = source.nodes
  const nodesStore = (record as unknown as { nodes?: { values?: () => readonly unknown[] } })?.nodes
  if (nodes === undefined && typeof nodesStore?.values === 'function') {
    nodes = nodesStore.values()
  }
  return {
    ...nodes === undefined || nodes === null ? {} : { nodes },
    ...source.runningCalls === undefined || source.runningCalls === null ? {} : { runningCalls: source.runningCalls },
  }
}
import { extractStreamingHtml, extractStreamingTitle, isStreamingCreate } from '../stream/extract.ts'
import { buildTimelines, currentCheckpointIndex, scanArtifactEntries, scanPersistDir, type ArtifactCheckpoint, type ArtifactEntry, type ArtifactTimeline } from './scan.ts'

/** Settled version events newer than this are treated as live activity. */
const VERSION_EVENT_WINDOW_MS = 15_000

/** The dsh-better-sidebar workbench face (the REQUIRED canvas host): the
 *  canvas is a native workbench tab — panes, splits, float windows, resize
 *  and per-session isolation are all the sidebar's own. Structurally typed
 *  so we never import the package. */
export interface SidebarFace {
  registerTab(descriptor: {
    id: string
    title: string
    icon?: unknown
    single?: boolean
    order?: number
    component: (props: unknown) => unknown
  }): () => void
  openTab(seed: { type: string; title?: string; path?: string }, scope?: { sessionId: string }): void
  closeTab(tabId: string, scope?: { sessionId: string }): void
  /** Open a file in the sidebar's own editor (shiki-highlighted). */
  openFile?(scope: { sessionId: string }, path: string, title?: string): void
}

/** The workbench tab type the canvas registers under. */
export const CANVAS_TAB_TYPE = 'dsh-html-artifact-canvas'

/** One in-flight NON-create op (patch/save/revert) targeting an artifact. */
export interface PendingOp {
  /** The running tool call's id. */
  callId: string
  /** The op verb: patch | save | revert (read/destroy/list are instant). */
  op: string
  /** The targeted artifact id ('' while the id argument is still streaming). */
  id: string
}

/** One in-flight create preview (delta phase or announced phase). */
export interface StreamPreview {
  /** The streaming tool call's id. */
  callId: string
  /** The html accumulated so far ('' before the html key starts). */
  html: string
  /** The completed title argument so far, when any. */
  title: string | undefined
}

/** Per-session panel state (the canvas binds to the session, not the app). */
interface SessionUi {
  open: boolean
  selectedId: string | undefined
  /** Index into the selected timeline's checkpoints (-1 = none yet). */
  viewIndex: number
}

/** The React-facing canvas state for the CURRENT session. */
export interface CanvasSnapshot {
  rev: number
  open: boolean
  /** The artifact being viewed (undefined until one is picked). */
  selectedId: string | undefined
  /** Index into the selected timeline's checkpoints (-1 = none yet). */
  viewIndex: number
  /** True while the panel is following an in-flight generation. */
  streamFollow: boolean
  /** Delta-phase preview reported by the draft chat node. */
  reportedStream: StreamPreview | undefined
  /** Announce-phase preview derived from running calls. */
  runningStream: StreamPreview | undefined
  /** In-flight patch/save/revert (the panel shows a loading veil). */
  pending: PendingOp | undefined
  /** Reconstructed histories keyed by artifact id. */
  timelines: ReadonlyMap<string, ArtifactTimeline>
  /** The newest persist dir a `list` card carried (server-side disk cache),
   *  or undefined when persistence is off — the 编辑器 button needs it. */
  persistDir: string | undefined
  /** Artifact ids, most recently touched first. */
  order: readonly string[]
}

// Module-level session facts shared by the bridge and the command submitters
// (the bridge is itself a singleton; these mirror its lifetime).
let activeSessions: ISessions | undefined
let activeSessionId: SessionId | undefined

/**
 * The session the canvas is currently bound to, for UI that addresses it
 * directly (the import picker excludes it from the cross-session listing).
 * @returns the bound session id, or undefined before the binding settles.
 */
export function activeSessionIdOf(): string | undefined {
  return activeSessionId
}

/** Tolerantly read the op/id off a running call's (possibly partial) args. */
function runningOpOf(argsRaw: string): { op: string; id: string } | null {
  const op = /"op"\s*:\s*"([a-z]+)"/.exec(argsRaw)?.[1]
  if (op === undefined) return null
  const id = /"id"\s*:\s*"([^"]+)"/.exec(argsRaw)?.[1]
  return { op, id: id ?? '' }
}

function streamOfCall(call: RunningToolCall): StreamPreview | null {
  if (call.name !== 'artifact') return null
  if (!isStreamingCreate(call.argsRaw)) return null
  return {
    callId: call.callId,
    html: extractStreamingHtml(call.argsRaw)?.html ?? '',
    title: extractStreamingTitle(call.argsRaw),
  }
}

/**
 * View state (panel open, which version is being browsed) is kept in
 * localStorage, keyed per session.
 *
 * WHY localStorage, AND WHY THAT IS NOT A "PARALLEL MECHANISM": the review
 * flagged this as duplicating harness session state, so it was checked against
 * the client service surface (cordis_inspect_query → platform client, provider
 * Service). The exposed services are layout, locale, sessions, slots, theme,
 * timer, uiWorkspace and workspaces — none of them stores plugin-owned
 * per-session view state, and the only per-session persistence the plugin
 * itself owns is the artifacts DIRECTORY, which lives on the host. A plugin
 * cannot write there from the client without adding an HTTP route, and this
 * plugin deliberately has no client→host write channel. So localStorage is the
 * only available client-side store.
 *
 * The accepted tradeoff: view state does not follow the user across browsers or
 * devices, and clearing site data resets it. That is a cosmetic loss (which
 * version was on screen), not data loss — the artifacts themselves are on disk
 * and the canvas rebuilds every timeline from the session log.
 *
 * Shape is VERSIONED so a future change can migrate instead of throwing away
 * every stored entry on the first mismatch.
 */
const UI_STORAGE_PREFIX = 'dsh-html-artifact:canvas-ui:'
/** Bumped when the persisted shape changes incompatibly; older entries are
 *  discarded rather than misread. */
const UI_STORAGE_VERSION = 1
/** Stored entries are bounded: a long-lived profile accumulates one key per
 *  session ever opened, and nothing else prunes them. */
const UI_STORAGE_MAX_ENTRIES = 200
type PersistedUi = { version: number; open: boolean; viewIndex: number; savedAt: number }

function loadPersistedUi(sessionId: string): SessionUi {
  const empty: SessionUi = { open: false, selectedId: undefined, viewIndex: -1 }
  try {
    const raw = globalThis.localStorage?.getItem(UI_STORAGE_PREFIX + sessionId)
    if (raw == null) return empty
    const parsed = JSON.parse(raw) as Partial<PersistedUi>
    if (parsed.version !== UI_STORAGE_VERSION) return empty
    return {
      open: parsed.open === true,
      // selectedId is NOT restored: a page reload should reopen the canvas at
      // the artifact PICKER (the list), not straight into the last-viewed
      // artifact — the user may want a different one, and the picker is the
      // one-click recovery path.
      selectedId: undefined,
      viewIndex: typeof parsed.viewIndex === 'number' ? parsed.viewIndex : -1,
    }
  } catch {
    return empty
  }
}

/** Drop the oldest entries once the prefix exceeds its budget. localStorage
 *  has no per-prefix API, so this walks the key list — cheap at this size. */
function prunePersistedUi(): void {
  try {
    const storage = globalThis.localStorage
    if (storage === undefined) return
    const keys: { key: string; savedAt: number }[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === null || !key.startsWith(UI_STORAGE_PREFIX)) continue
      let savedAt = 0
      try {
        savedAt = (JSON.parse(storage.getItem(key) ?? '{}') as Partial<PersistedUi>).savedAt ?? 0
      } catch { /* unreadable entry sorts oldest, so it is pruned first */ }
      keys.push({ key, savedAt })
    }
    if (keys.length <= UI_STORAGE_MAX_ENTRIES) return
    keys.sort((a, b) => a.savedAt - b.savedAt)
    for (const { key } of keys.slice(0, keys.length - UI_STORAGE_MAX_ENTRIES)) storage.removeItem(key)
  } catch { /* storage blocked — non-fatal */ }
}

function persistUi(sessionId: string, ui: SessionUi): void {
  try {
    const storage = globalThis.localStorage
    if (storage === undefined) return
    const payload: PersistedUi = {
      version: UI_STORAGE_VERSION,
      open: ui.open,
      // selectedId deliberately NOT persisted (see loadPersistedUi).
      viewIndex: ui.viewIndex,
      savedAt: Date.now(),
    }
    storage.setItem(UI_STORAGE_PREFIX + sessionId, JSON.stringify(payload))
    prunePersistedUi()
  } catch { /* storage full / blocked — non-fatal */ }
}

class CanvasBridge {
  private readonly listeners = new Set<() => void>()
  /** Set at rebind when a persisted-open canvas must be re-opened once the
   *  sidebar service lands (it registers after us sometimes). */
  private needsSidebarReplay = false
  private feedDisposer: (() => void) | undefined
  private sessionDisposer: (() => void) | undefined
  /** The `chat` Conversation view subscription (current hosts' transcript source). */
  private chatDisposer: (() => void) | undefined
  /** Pending late-bind retry timer for the chat view (see scheduleRetry). */
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryAttempt = 0
  /** The client root context, kept for late `uiConversation` resolves. */
  private ctx: Context | undefined
  private lastConversation: ConversationSnapshot | undefined
  private sidebar: SidebarFace | undefined

  private rev = 0
  private snapshotValue: CanvasSnapshot = {
    rev: 0,
    open: false,
    selectedId: undefined,
    viewIndex: -1,
    streamFollow: false,
    reportedStream: undefined,
    runningStream: undefined,
    pending: undefined,
    timelines: new Map(),
    persistDir: undefined,
    order: [],
  }

  /** Per-session panel state; the current session's entry IS the snapshot. */
  private readonly sessionUi = new Map<string, SessionUi>()
  private streamFollowState = false
  private reportedValue: StreamPreview | undefined
  private runningStreamValue: StreamPreview | undefined
  private pendingValue: PendingOp | undefined
  /** Running calls judged dead (a retried attempt settled AFTER them, or an
   *  interrupted stream): chat rows consult this to hide their 正在修改/
   *  正在生成 rows instead of displaying a live row forever. */
  private zombieIds = new Set<string>()
  /** Set on every rebind: one-shot request to reconcile the RESTORED
   *  viewIndex with the actual working copy (the first ingest consumes it).
   *  A user-side persisted viewIndex can point at a checkpoint whose html no
   *  longer matches the working copy — e.g. a model-side revert landed while
   *  the tab was gone. The canvas then opens on "latest" while showing old
   *  content. On rebind, snap the restored view onto the checkpoint that IS
   *  the working copy (any match beats a misleading default). */
  private needsViewReconcile = false
  /** User-side /artifact-revert lands in the session as a COMMAND (not a
   *  tool/result card) — the timeline never sees it. Keep a client-side
   *  overlay of those reverts so the canvas follows the revert until the
   *  next real op supersedes it. Cleared on (re)bind. */
  private localOverlay: ArtifactEntry[] = []
  /** Highest settled artifact-op seq seen at bind time: history never auto-opens. */
  private baselineSeq = 0
  private timelinesValue = new Map<string, ArtifactTimeline>()
  private persistDirValue: string | undefined
  private orderValue: readonly string[] = []
  // Incremental-scan watermark: the conversation log is append-mostly, so
  // per-token ingests scan only the NEW tail instead of the whole history.
  private scannedLength = -1
  private scannedMinSeq = Number.MAX_SAFE_INTEGER
  private cachedEntries: ReturnType<typeof scanArtifactEntries> = []

  /** The current session's UI entry (created closed on first touch). */
  private ui(): SessionUi {
    const id = activeSessionId ?? '(no-session)'
    let entry = this.sessionUi.get(id)
    if (entry === undefined) {
      // Cold start or a page reload: restore this session's last canvas state.
      entry = loadPersistedUi(id)
      this.sessionUi.set(id, entry)
    }
    return entry
  }

  /**
   * Initialize the bridge for the plugin lifetime.
   * @param ctx - client root context (injects the sessions services and the
   *   dsh-better-sidebar workbench — the canvas's required host).
   * @returns a disposer detaching every subscription.
   */
  init(ctx: Context): () => void {
    activeSessions = ctx.sessions
    this.ctx = ctx
    // Optional host: dsh-better-sidebar's workbench. Read via ctx.get(): the
    // ctx proxy throws on undeclared property access, and declaring it in
    // `inject` would make the service REQUIRED (the plugin would never load
    // without the sidebar); ctx.get() resolves the root reflect store instead.
    this.sidebar = (ctx.get('betterSidebar') as SidebarFace | undefined) ?? undefined
    const update = (): void => {
      const next = this.resolveCurrentSessionId()
      if (next !== activeSessionId) {
        activeSessionId = next
        this.rebind()
      } else if (next !== undefined && this.chatDisposer === undefined) {
        // Same session, still unbound: the sessions list changed (the session
        // just got listed / materialized) — take the event-driven retry rather
        // than waiting out the backoff chain.
        this.tryBind()
      }
    }
    update()

    const disposers: (() => void)[] = []
    try {
      const sr = ctx.get('sidebarRight') as { mounted?: { subscribe?: (fn: () => void) => () => void } } | undefined
      if (typeof sr?.mounted?.subscribe === 'function') {
        disposers.push(sr.mounted.subscribe(update))
      }
    } catch {}
    try {
      const uw = ctx.get('uiWorkspace') as { selection?: { subscribe?: (fn: () => void) => () => void } } | undefined
      if (typeof uw?.selection?.subscribe === 'function') {
        disposers.push(uw.selection.subscribe(update))
      }
    } catch {}
    if (ctx.sessions?.list) {
      disposers.push(ctx.sessions.list.subscribe(update))
    }
    this.feedDisposer = () => {
      for (const d of disposers) d()
    }
    return () => {
      this.feedDisposer?.()
      this.sessionDisposer?.()
      this.chatDisposer?.()
      this.feedDisposer = undefined
      this.sessionDisposer = undefined
      this.chatDisposer = undefined
      // A pending late-bind retry would otherwise outlive the plugin and fire
      // into a cleared bridge.
      this.clearRetry()
      this.ctx = undefined
      activeSessions = undefined
      activeSessionId = undefined
      this.lastConversation = undefined
    }
  }

  /** Follow a (new) current session's conversation snapshot. */
  private rebind(): void {
    this.sessionDisposer?.()
    this.sessionDisposer = undefined
    this.chatDisposer?.()
    this.chatDisposer = undefined
    this.lastConversation = undefined
    this.baselineSeq = 0
    this.timelinesValue = new Map()
    this.persistDirValue = undefined
    this.orderValue = []
    this.localOverlay = []
    this.reportedValue = undefined
    this.runningStreamValue = undefined
    this.pendingValue = undefined
    this.needsViewReconcile = true
    this.zombieIds = new Set()
    this.streamFollowState = false
    this.scannedLength = -1
    this.scannedMinSeq = Number.MAX_SAFE_INTEGER
    this.cachedEntries = []
    this.clearRetry()
    this.retryAttempt = 0
    this.hostListFetched = false
    this.hostTimelines.clear()
    const sessions = activeSessions
    const id = activeSessionId
    if (sessions === undefined || id === undefined) {
      this.publish()
      return
    }
    // Panel state binds to the session: restore what THIS session had.
    // Session-scoped open state: a session left with the canvas open gets
    // its workbench tab focused again (the workbench isolates tabs per
    // session natively — nothing to close for the others).
    const restored = this.ui()
    if (restored.open) this.openSidebarTab()
    // Persist-independent: also remember we owe an open so attachSidebar can replay it
    this.needsSidebarReplay = restored.open
    // The session materializes asynchronously (cold load / just switched):
    // `sessions.binding(id)` AND `uiConversation.binding(id)` can both be
    // unavailable at first — a one-shot attempt would leave the canvas with an
    // EMPTY transcript (no picker cards) until some unrelated rebind. So the
    // attempt is retryable (bounded backoff) rather than one-shot.
    this.tryBind()
  }

  /**
   * One binding attempt for the current session: resolve the session binding
   * and then the transcript source, committing on success and scheduling a
   * bounded retry while either is still unavailable.
   *
   * TRANSCRIPT SOURCE, in preference order:
   * - current hosts publish the transcript on the `chat` Conversation view
   *   (`uiConversation.binding(id).target('chat')`), whose `legacy` slice
   *   carries `nodes`/`runningCalls`; the Session lifecycle snapshot
   *   (`session.getSnapshot()`) now holds ONLY lifecycle state, no nodes;
   * - older hosts exposed the transcript on the session snapshot itself.
   */
  private tryBind(): void {
    const sessions = activeSessions
    const id = activeSessionId
    if (sessions === undefined || id === undefined) return
    let binding: ReturnType<ISessions['binding']> | undefined
    try {
      binding = sessions.binding(id)
    } catch {
      binding = undefined
    }
    if (binding === undefined) {
      this.publish()
      this.scheduleRetry()
      return
    }
    const session = binding.session
    const chat = this.chatSource(id)
    if (chat !== undefined) {
      // Committed: stop retrying and swap the lifecycle subscription out.
      this.retryAttempt = 0
      this.clearRetry()
      this.sessionDisposer?.()
      this.sessionDisposer = undefined
      this.chatDisposer?.()
      this.chatDisposer = chat.subscribe(() => {
        this.ingest(transcriptOf(chat.getSnapshot()), false)
      })
      // baseline=true: a (re)bind must never auto-open for pre-existing history.
      this.ingest(transcriptOf(chat.getSnapshot()), true)
      return
    }
    // Fallback: the lifecycle snapshot keeps change notifications flowing (and
    // is the whole transcript on older hosts); retry for the chat view meanwhile.
    if (this.sessionDisposer === undefined) {
      this.sessionDisposer = session.subscribe(() => {
        this.ingest(session.getSnapshot(), false)
      })
      this.ingest(session.getSnapshot(), true)
    }
    this.scheduleRetry()
  }

  /** One link of the bounded (re)bind backoff chain. */
  private scheduleRetry(): void {
    this.clearRetry()
    if (this.retryAttempt >= 8) return
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.tryBind()
    }, 150 * this.retryAttempt)
  }

  /** Cancel a pending (re)bind retry. */
  private clearRetry(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  /** Resolve current active session id across DSH runtime surfaces. */
  resolveCurrentSessionId(): SessionId | undefined {
    if (this.ctx === undefined) return undefined
    try {
      const sr = this.ctx.get('sidebarRight') as { mounted?: { getSnapshot?: () => unknown } } | undefined
      const fromSr = sr?.mounted?.getSnapshot?.()
      if (typeof fromSr === 'string' && fromSr !== '') return fromSr as SessionId
    } catch {}
    try {
      const uw = this.ctx.get('uiWorkspace') as { selection?: { getSnapshot?: () => { sessionId?: unknown } } } | undefined
      const fromUw = uw?.selection?.getSnapshot?.()?.sessionId
      if (typeof fromUw === 'string' && fromUw !== '') return fromUw as SessionId
    } catch {}
    try {
      const fromList = (this.ctx.sessions?.list?.getSnapshot?.() as { current?: unknown } | undefined)?.current
      if (typeof fromList === 'string' && fromList !== '') return fromList as SessionId
    } catch {}
    return undefined
  }

  /**
   * Resolve the session's `chat` Conversation view source. The service is
   * injected, but this stays fully defensive: an older host has no
   * `uiConversation`, a session may not be bound yet, and `target()` hands
   * back a live source whose value is undefined until the chat view registers
   * (the subscription then fires on registration).
   * @param id - session id.
   * @returns the observable chat view, or undefined to fall back.
   */
  private chatSource(id: SessionId): ChatViewSource | undefined {
    if (this.ctx === undefined) return undefined
    try {
      const ui = this.ctx.get('uiConversation') as UiConversationFace | undefined
      if (ui === undefined || typeof ui.binding !== 'function') return undefined
      let sessionBinding: unknown
      try {
        sessionBinding = this.ctx.sessions?.binding(id)
      } catch {}
      const conv = sessionBinding !== undefined ? ui.binding(sessionBinding) : ui.binding(id)
      const target = conv?.target?.('chat')
      if (target !== undefined && typeof target.getSnapshot === 'function' && typeof target.subscribe === 'function') {
        return target
      }
    } catch { /* no such service / unknown session — fall back to the session snapshot */ }
    return undefined
  }

  /**
   * Fold one conversation snapshot into the published state.
   * @param conversation - the current conversation snapshot.
   * @param baseline - true on session (re)bind: record the seq watermark but
   *   never auto-open for pre-existing history.
   */
  private ingest(conversation: ConversationSnapshot, baseline: boolean): void {
    this.lastConversation = conversation
    const nodes = conversation.nodes ?? []
    const firstSeq = nodes.length > 0 ? (nodes[0] as { seq?: number }).seq ?? 0 : 0
    let entries: ReturnType<typeof scanArtifactEntries>
    if (baseline || nodes.length < this.scannedLength || firstSeq < this.scannedMinSeq) {
      // Full scan: fresh bind, history prepended (loadOlder), or shrink.
      entries = scanArtifactEntries(nodes)
      this.scannedLength = nodes.length
      this.scannedMinSeq = firstSeq
    } else if (nodes.length === this.scannedLength) {
      // Nothing new — reuse the cached scan (per-token snapshots often only
      // mutate streaming buffers, not the node list).
      entries = this.cachedEntries
    } else {
      // Append-only growth: scan just the new tail.
      const tail = scanArtifactEntries(nodes.slice(this.scannedLength))
      entries = [...this.cachedEntries, ...tail]
      this.scannedLength = nodes.length
    }
    this.cachedEntries = entries
    this.persistDirValue = scanPersistDir(nodes)
    this.timelinesValue = buildTimelines(this.localOverlay.length === 0 ? entries : [...entries, ...this.localOverlay])
    // The window scan is TRUNCATED (the web client loads a tail page), so any
    // artifact whose create/save fell out of the window is missing here. The
    // host index fills those in and MUST be re-applied after every rescan —
    // otherwise each ingest overwrites the merge and the picker empties again.
    this.applyHostTimelines()
    this.orderValue = [...this.timelinesValue.values()]
      .sort((a, b) => b.lastSeq - a.lastSeq)
      .map(timeline => timeline.id)

    const settledCalls = new Set(entries.map(entry => entry.callId).filter((id): id is string => id !== undefined))
    if (this.reportedValue !== undefined && settledCalls.has(this.reportedValue.callId)) {
      // The draft's call settled; the draft node may lag its unmount.
      this.reportedValue = undefined
    }

    // Zombie-call guard (disconnect/retry): the first attempt of a call stays
    // in conversation.runningCalls forever once the connection drops mid-
    // flight; the retried call lands and settles under a NEW callId, so the
    // settle-by-callId check above never retires the ghost and the panel
    // would latch on 正在修改/正在生成 indefinitely. The agent runs its calls
    // strictly sequentially, so a LATER settle on the same target (or, before
    // the id argument streams in, anywhere at all) can only mean the earlier
    // attempt died.
    const newestSettleById = new Map<string, number>()
    let newestSettle = 0
    for (const entry of entries) {
      if (entry.time > newestSettle) newestSettle = entry.time
      if (entry.time > (newestSettleById.get(entry.id) ?? 0)) newestSettleById.set(entry.id, entry.time)
    }
    const isZombie = (call: RunningToolCall, id: string): boolean => {
      const settledAfter = id === '' ? newestSettle : (newestSettleById.get(id) ?? 0)
      return settledAfter > call.time
    }

    // Announced-but-unsettled create calls carry complete args at announce.
    let running: StreamPreview | undefined
    let pending: PendingOp | undefined
    const zombies = new Set<string>()
    for (const call of conversation.runningCalls ?? []) {
      if (settledCalls.has(call.callId)) continue
      const opInfo = runningOpOf(call.argsRaw)
      if (opInfo !== null && isZombie(call, opInfo.id)) {
        zombies.add(call.callId)
        continue
      }
      if (opInfo === null && isZombie(call, '')) {
        zombies.add(call.callId)
        continue
      }
      const preview = streamOfCall(call)
      if (preview !== null) {
        running = preview
        continue
      }
      if (opInfo !== null && opInfo.op !== 'create') pending = { callId: call.callId, ...opInfo }
    }
    this.pendingValue = pending
    this.zombieIds = zombies

    const newestEntry = entries[entries.length - 1]
    if (baseline) {
      this.baselineSeq = newestEntry?.seq ?? 0
    }

    const state = this.ui()

    // AUTO-EVACUATE: if the selected artifact was deleted, hop to the newest
    // SURVIVING one (order is most-recently-touched first). Deleting the last
    // artifact leaves nothing to switch to — the destroyed banner still shows.
    if (state.selectedId !== undefined) {
      const sel = this.timelinesValue.get(state.selectedId)
      if (sel?.destroyed === true) {
        const survivor = this.orderValue
          .map(id => this.timelinesValue.get(id))
          .find(t => t !== undefined && t.destroyed !== true)
        if (survivor !== undefined) {
          state.selectedId = survivor.id
          const count = survivor.checkpoints.length
          state.viewIndex = count === 0 ? -1 : count - 1
        }
      }
    }

    // Auto-open on a NEW version event: past the bind watermark AND fresh in
    // wall-clock terms — replayed history carries old timestamps and never
    // pops the panel, no matter how the session loaded.
    const now = Date.now()
    const versionEvent = [...entries].reverse()
      .find(entry => (entry.op === 'create' || entry.op === 'save' || entry.op === 'revert')
        && entry.seq > this.baselineSeq
        && now - entry.time <= VERSION_EVENT_WINDOW_MS)
    if (versionEvent !== undefined) {
      this.baselineSeq = Math.max(this.baselineSeq, versionEvent.seq)
      if (!state.open || state.selectedId === undefined) {
        this.openUi(state, versionEvent.id,
          versionEvent.op === 'revert' ? versionEvent.version : undefined)
      } else if (state.selectedId === versionEvent.id) {
        // The viewed artifact just gained a version (save) or was reverted —
        // follow the RIGHT target: saves jump to the newest checkpoint, but a
        // revert must land on the checkpoint it reverted TO (otherwise the
        // badge says the newest version while content is the old one).
        const timeline = this.timelinesValue.get(state.selectedId)
        const count = timeline?.checkpoints.length ?? 0
        if (count > 0) {
          if (versionEvent.op === 'revert' && versionEvent.version !== undefined) {
            const idx = timeline?.checkpoints.findIndex(checkpoint => checkpoint.version === versionEvent.version) ?? -1
            state.viewIndex = idx >= 0 ? idx : count - 1
          } else {
            state.viewIndex = count - 1
          }
        }
      }
    }

    // Auto-open the placeholder during generation too.
    const streaming = this.reportedValue ?? running
    if (streaming !== undefined) {
      if (!state.open) {
        this.openUi(state)
        this.streamFollowState = true
      }
    } else {
      this.streamFollowState = false
    }
    this.runningStreamValue = running

    if (this.needsViewReconcile && state.selectedId !== undefined) {
      // Only consume the one-shot flag once the selected artifact's
      // timeline actually exists — the first ingest after (re)bind can land
      // with an EMPTY conversation (frames stream in later), and firing
      // early burns the reconcile on nothing.
      const t = this.timelinesValue.get(state.selectedId)
      if (t !== undefined && t.workingHtml !== undefined && t.checkpoints.length > 0) {
        this.needsViewReconcile = false
        const liveIdx = t.checkpoints.findIndex(checkpoint => checkpoint.html === t.workingHtml)
        const restored = t.checkpoints[state.viewIndex]
        if (liveIdx >= 0 && (restored === undefined || restored.html !== t.workingHtml)) {
          state.viewIndex = liveIdx
        }
      }
    }
    this.clampViewIndex(state)
    this.publish()
  }

  private openSidebarTab(): void {
    // NEVER let this throw into the caller. The native sidebar-right controller
    // throws `no session surface is mounted` until its rightbar seat has bound
    // (and `no tab type is registered` while the descriptor is still landing),
    // and callers include subscription callbacks (rebind → sessions list,
    // ingest → chat view). An escaping throw would abort the REST of rebind —
    // most importantly the transcript binding that follows it — leaving an
    // EMPTY canvas with no error surface at all.
    try {
      this.openSidebarTabUnsafe()
    } catch (error) {
      console.warn('[dsh-html-artifact] failed to open the canvas tab:', error)
    }
  }

  /** The raw open attempt (see openSidebarTab for the guard). */
  private openSidebarTabUnsafe(): void {
    const scope = activeSessionId === undefined ? undefined : { sessionId: activeSessionId }
    // NOTE: do NOT pass `path` here. dsh-better-sidebar ≥0.19 routes a
    // `openTab` seed carrying a `path` to `surface.openResource()` (a FILE
    // open, resolved against the session workspace) instead of the registered
    // tab component — the tab then renders a file-viewer ENOENT error. The
    // plain type-only seed is the custom-tab channel; the right panel still
    // expands for it (surface.openTab → sidebarRight.openTab).
    this.sidebar?.openTab({ type: CANVAS_TAB_TYPE, title: '画布' }, scope)
  }

  /** Open a session's panel: focus/open the workbench tab.
   * @param targetVersion - when set, land on that checkpoint instead of the
   *   newest one (a revert auto-open must show the REVERTED version, not the
   *   latest — otherwise the badge reads the newest version while the body
   *   shows old content). */
  private openUi(state: SessionUi, id?: string, targetVersion?: number): void {
    state.open = true
    if (id !== undefined) {
      state.selectedId = id
      const timeline = this.timelinesValue.get(id)
      const count = timeline?.checkpoints.length ?? 0
      if (count === 0) {
        state.viewIndex = -1
      } else if (targetVersion !== undefined) {
        const idx = timeline?.checkpoints.findIndex(checkpoint => checkpoint.version === targetVersion) ?? -1
        state.viewIndex = idx >= 0 ? idx : count - 1
      } else {
        state.viewIndex = timeline === undefined ? count - 1 : currentCheckpointIndex(timeline)
      }
    } else if (state.selectedId === undefined) {
      // First open with no explicit artifact: when the session has exactly one
      // artifact, open it directly (the model just created it — the user wants
      // the canvas, not a picker). With multiple artifacts, show the picker.
      const alive = this.orderValue.filter(x => this.timelinesValue.get(x)?.destroyed !== true)
      const only = alive[0]
      if (alive.length === 1 && only !== undefined) {
        state.selectedId = only
        const timeline = this.timelinesValue.get(only)
        state.viewIndex = timeline === undefined || timeline.checkpoints.length === 0 ? -1 : currentCheckpointIndex(timeline)
      }
    }
    this.openSidebarTab()
    this.refreshHostList()
  }

  /**
   * Pull the session's FULL artifact index from the host (the
   * `/artifact/api/list` route the plugin's host half registers in the web
   * deployment) and merge it into the picker. The window scan only covers the
   * loaded conversation tail; the host replays the whole log, so artifacts
   * whose create op scrolled out of the window still show up as cards. The
   * merge is title/identity only — a card picked from the host list has no
   * HTML in the window yet, so the body keeps the picker ("选择要查看…")
   * until the user scrolls the chat far enough for the window to reach it
   * (the picker's own hint says as much).
   */
  private hostListFetched = false
  /** Artifact data supplied by the host route, keyed by id. Kept apart from
   *  `timelinesValue` because the window rescan rebuilds that map wholesale. */
  private hostTimelines = new Map<string, {
    title?: string
    html?: string
    savedVersion?: number
    interactive?: boolean
    versions?: readonly { version: number; html: string; time: number }[]
  }>()
  /** Public: the canvas tab body mounted — make sure the host index is loaded
   *  even when the tab was opened without going through `openUi` (the "+" guide
   *  menu), because mount IS open on native hosts. */
  ensureHostIndex(): void {
    this.refreshHostList()
  }

  private refreshHostList(): void {
    const id = activeSessionId
    if (id === undefined || this.hostListFetched) return
    this.hostListFetched = true
    void fetch(`/artifact/api/list?sessionId=${encodeURIComponent(id)}`)
      .then(response => response.ok ? response.json() : undefined)
      .then(body => {
        // A failed attempt must stay RETRYABLE: the route 403s until the host
        // half is loaded, and a stale bundle / momentary failure would
        // otherwise disable the index for the rest of the session, silently
        // reverting the picker to the truncated window (the exact bug this
        // index exists to fix). Only a SUCCESSFUL, non-empty read latches.
        if (!Array.isArray((body as { artifacts?: unknown[] } | undefined)?.artifacts)) {
          this.hostListFetched = false
          return
        }
        const artifacts = (body as { ok?: boolean; artifacts?: unknown[] } | undefined)?.artifacts
        if (!Array.isArray(artifacts)) return
        for (const raw of artifacts) {
          if (raw === null || typeof raw !== 'object') continue
          const entry = raw as {
            id?: unknown; title?: unknown; savedVersion?: unknown
            html?: unknown; interactive?: unknown; versions?: unknown
          }
          if (typeof entry.id !== 'string') continue
          const versions = Array.isArray(entry.versions)
            ? (entry.versions as unknown[]).flatMap((raw) => {
                if (raw === null || typeof raw !== 'object') return []
                const item = raw as { version?: unknown; html?: unknown; time?: unknown }
                if (typeof item.version !== 'number' || typeof item.html !== 'string') return []
                return [{ version: item.version, html: item.html, time: typeof item.time === 'number' ? item.time : 0 }]
              }).sort((a, b) => a.version - b.version)
            : undefined
          this.hostTimelines.set(entry.id, {
            ...typeof entry.title === 'string' ? { title: entry.title } : {},
            ...typeof entry.html === 'string' ? { html: entry.html } : {},
            ...typeof entry.savedVersion === 'number' ? { savedVersion: entry.savedVersion } : {},
            ...typeof entry.interactive === 'boolean' ? { interactive: entry.interactive } : {},
            ...versions === undefined || versions.length === 0 ? {} : { versions },
          })
        }
        if (this.hostTimelines.size === 0) {
          // A legitimately empty session is fine to re-ask (cheap), so a later
          // artifact — or a route that came up late — still gets picked up.
          this.hostListFetched = false
          return
        }
        this.applyHostTimelines()
        this.orderValue = [...this.timelinesValue.values()]
          .sort((a, b) => b.lastSeq - a.lastSeq || b.lastTime - a.lastTime || (a.title ?? a.id).localeCompare(b.title ?? b.id))
          .map(timeline => timeline.id)
        this.publish()
      })
      .catch(() => {
        // offline / headless / route not yet registered — allow a later retry.
        this.hostListFetched = false
      })
  }

  /**
   * Fold the host's artifact index into the window-scanned timelines. The
   * window is TRUNCATED (the web client loads a tail page of the session log),
   * so an artifact whose create/save scrolled out of it has no title, no
   * checkpoint and sometimes no entry at all — that is what made the canvas
   * show ids instead of titles, hide the version controls, and list nothing
   * for older sessions. The host reads the whole log / disk cache, so it
   * supplies:
   * - entries the window never saw (synthesized as a single "current" checkpoint
   *   holding the working copy, which is enough to render, download and navigate);
   * - field-level gaps on entries the window did see (title, interaction flag,
   *   and a checkpoint when none survived truncation).
   * Re-applied after EVERY rescan, because the rescan rebuilds `timelinesValue`
   * wholesale and would otherwise drop the merge.
   */
  private applyHostTimelines(): void {
    for (const [id, host] of this.hostTimelines) {
      const existing = this.timelinesValue.get(id)
      // The host's full saved-version history, or a lone newest version as the
      // fallback when no history was reported.
      const hostCheckpoints = (host.versions !== undefined && host.versions.length > 0
        ? host.versions
        : host.savedVersion === undefined || host.html === undefined
          ? []
          : [{ version: host.savedVersion, html: host.html, time: 0 }]
      ).map(entry => ({ version: entry.version, html: entry.html, title: host.title, seq: 0, time: entry.time }))

      if (existing === undefined) {
        this.timelinesValue.set(id, {
          id,
          title: host.title,
          interactive: host.interactive,
          checkpoints: hostCheckpoints,
          workingHtml: host.html,
          workingDirty: false,
          destroyed: false,
          lastSeq: 0,
          lastTime: 0,
        })
        continue
      }

      // MERGE, do not mutate. The host index covers artifacts the truncated
      // conversation window lost, and it carries the FULL version history — the
      // window scan only sees the ops still loaded. The previous rule adopted
      // the host history only when the window produced ZERO checkpoints, so a
      // long session that had scrolled past its early `save` ops showed an
      // incomplete version list even though the host had sent every version
      // (and the wire had already paid for all of them).
      //
      // The window is authoritative for VERSIONS IT SAW (it has real seq/time,
      // which drive ordering and the "last updated" sort); the host fills in
      // versions the window lacks. Keyed by version number.
      const byVersion = new Map<number, ArtifactCheckpoint>()
      for (const checkpoint of hostCheckpoints) byVersion.set(checkpoint.version, checkpoint)
      for (const checkpoint of existing.checkpoints) byVersion.set(checkpoint.version, checkpoint)
      const merged = [...byVersion.values()].sort((a, b) => a.version - b.version)

      this.timelinesValue.set(id, {
        ...existing,
        title: existing.title ?? host.title,
        interactive: existing.interactive ?? host.interactive,
        workingHtml: existing.workingHtml ?? host.html,
        checkpoints: merged,
      })
    }
  }

  /** Attach the better-sidebar workbench host (tab mode). */
  attachSidebar(face: SidebarFace): void {
    this.sidebar = face
    // A cold reload binds sessions BEFORE the sidebar plugin loads; openTab
    // then would have been a no-op — replay the pending open now.
    if (this.needsSidebarReplay) {
      this.needsSidebarReplay = false
      this.openSidebarTab()
    }
  }

  /**
   * The canvas tab body UNMOUNTED. dockkit renders the ACTIVE tab's body
   * alone, so this fires on a real tab close AND on every switch-away (another
   * tab in the pane, or the per-session isolation of a session switch) — it is
   * NOT a close-only signal, and it must never destroy per-session state.
   *
   * It therefore only clears `open` — the flag that gates auto-open and the
   * rebind restore — while `selectedId`/`viewIndex` SURVIVE, so switching back
   * (tab or session) lands straight on the same artifact. The tab body's
   * render no longer reads `open` at all (mount = open), so nothing the user
   * sees changes on a mere switch; a REAL close keeps working because the
   * native tab is gone and a later auto-open simply re-creates it (and a
   * rebind no longer resurrects a tab the user closed, since open=false).
   *
   * better-sidebar ≥0.19's native adapter wires NO lifecycle callbacks (the
   * descriptor's `onClose` never fires), so this body-lifecycle hook is the
   * only per-tab signal that exists.
   * @param sessionId - the session the unmounting tab body belonged to.
   */
  onTabUnmount(sessionId: SessionId): void {
    const state = this.sessionUi.get(sessionId)
    if (state === undefined || !state.open) return
    state.open = false
    if (activeSessionId === sessionId) this.streamFollowState = false
    this.publish()
  }

  /** Clamp the viewed checkpoint against the selected timeline. */
  private clampViewIndex(state: SessionUi): void {
    const timeline = state.selectedId === undefined ? undefined : this.timelinesValue.get(state.selectedId)
    const count = timeline?.checkpoints.length ?? 0
    if (count === 0) {
      state.viewIndex = -1
      return
    }
    if (state.viewIndex < 0 || state.viewIndex >= count) {
      const timeline = state.selectedId === undefined ? undefined : this.timelinesValue.get(state.selectedId)
      state.viewIndex = timeline === undefined ? count - 1 : currentCheckpointIndex(timeline)
    }
  }

  private publish(): void {
    const state = this.ui()
    this.rev += 1
    // IMMUTABLE SNAPSHOT. `getSnapshot` must return a value that changes
    // identity exactly when the store changes — that is how
    // useSyncExternalStore decides to re-render. The previous version reused a
    // single `timelinesValue` Map reference and mutated it in place
    // (applyHostTimelines wrote into existing entries), so a change that only
    // altered a timeline's contents left the reference identical and React
    // could skip the update entirely: the panel showed stale versions until
    // something else happened to force a render.
    //
    // The maps are copied one level deep (entries are not cloned — they are
    // treated as read-only by the UI, and cloning a 149 KB html per publish
    // would be the real cost). `applyHostTimelines` below therefore REPLACES
    // entries instead of mutating them.
    this.snapshotValue = {
      rev: this.rev,
      open: state.open,
      selectedId: state.selectedId,
      viewIndex: state.viewIndex,
      streamFollow: this.streamFollowState,
      reportedStream: this.reportedValue,
      runningStream: this.runningStreamValue,
      pending: this.pendingValue,
      timelines: new Map(this.timelinesValue),
      persistDir: this.persistDirValue,
      order: this.orderValue,
    }
    if (activeSessionId !== undefined) persistUi(activeSessionId, this.ui())
    for (const listener of this.listeners) listener()
  }

  // ---------------------------------------------------------------- actions

  /** Open the panel, optionally selecting an artifact. */
  open(id?: string): void {
    if (activeSessionId === undefined && this.ctx !== undefined) {
      const next = this.resolveCurrentSessionId()
      if (next !== undefined) {
        activeSessionId = next
        this.rebind()
      }
    }
    // publish() MUST run even when the workbench host throws mid-open
    // (a throwing openTab once left SessionUi mutated but unpublished —
    // the panel stayed 画布未打开 while the bridge believed it open).
    try {
      this.openUi(this.ui(), id)
    } catch (error) {
      console.warn('[dsh-html-artifact] failed to open the workbench tab:', error)
    }
    this.publish()
  }

  /**
   * Open the VIEWED artifact's on-disk working copy in the better-sidebar
   * editor (its shiki-highlighted code view — the highlighter we cannot
   * value-import, reused through its public openFile API). No-op when
   * persistence is off (no dir), the host lacks openFile, or nothing is
   * selected.
   * @returns whether the file was handed to the editor.
   */
  openInEditor(): boolean {
    const state = this.ui()
    const dir = this.persistDirValue
    if (state.selectedId === undefined || dir === undefined) return false
    const sidebar = this.sidebar
    if (sidebar?.openFile === undefined) return false
    const scope = activeSessionId === undefined ? undefined : { sessionId: activeSessionId }
    if (scope === undefined) return false
    const timeline = this.timelinesValue.get(state.selectedId)
    const base = timeline?.title ?? state.selectedId
    // Open the VIEWED content: a browsed-old checkpoint maps to its frozen
    // version file; the newest view maps to the working copy file.
    const count = timeline?.checkpoints.length ?? 0
    const viewingOld = timeline !== undefined && count > 0 && state.viewIndex >= 0 && state.viewIndex < count - 1
    const version = viewingOld ? timeline?.checkpoints[state.viewIndex]?.version : undefined
    const file = version !== undefined
      ? `${dir}/${state.selectedId}.v${version}.html`
      : `${dir}/${state.selectedId}.html`
    const label = version !== undefined ? `${base} · 版本 ${version}` : `${base} · 工作副本`
    try {
      sidebar.openFile(scope, file, label)
      return true
    } catch (error) {
      console.warn('[dsh-html-artifact] openFile failed:', error)
      return false
    }
  }

  /**
   * Register a USER-side revert the client just performed via
   * /artifact-revert: the command lands in the session log WITHOUT a
   * presentation card, so the canvas would keep rendering the stale working
   * copy until the model's next op. Patch the local overlay so the canvas
   * shows the reverted version NOW; the next real patch/save supersedes it.
   * @param id - the reverted artifact.
   * @param version - the version reverted to.
   */
  applyLocalRevert(id: string, version: number): void {
    const timeline = this.timelinesValue.get(id)
    const checkpoint = timeline?.checkpoints.find(entry => entry.version === version)
    if (checkpoint === undefined) return
    const lastSeq = Math.max(
      this.cachedEntries[this.cachedEntries.length - 1]?.seq ?? 0,
      this.localOverlay[this.localOverlay.length - 1]?.seq ?? 0,
    )
    this.localOverlay.push({
      seq: lastSeq + 1,
      time: Date.now(),
      callId: undefined,
      op: 'revert',
      id,
      version,
      html: checkpoint.html,
      title: checkpoint.title,
      interactive: undefined,
      isError: false,
    })
    // Jump the viewer to the version we just reverted to.
    const ui = this.ui()
    if (ui.selectedId === id) {
      const idx = timeline?.checkpoints.findIndex(entry => entry.version === version) ?? -1
      if (idx >= 0) ui.viewIndex = idx
    }
    if (this.lastConversation !== undefined) this.ingest(this.lastConversation, false)
  }

  /** Close the panel. */
  /**
   * Mark the canvas closed and let the host drop its tab.
   *
   * NOTE: the native surface keys its tabs by the NATIVE tab id minted by
   * DSH/dockkit, while `CANVAS_TAB_TYPE` is the descriptor id — so
   * better-sidebar's native `close` looks the record up by an id it never
   * saw and is a strict no-op. There is no in-plugin close control any more
   * (the native panel chrome owns it), so nothing user-visible depends on
   * this; it exists for programmatic/close-path callers and for tests. If a
   * close control ever returns, capture the real tab id from a completed
   * `openTab`/`getTabs()` first.
   */
  close(): void {
    const state = this.ui()
    state.open = false
    this.streamFollowState = false
    const scope = activeSessionId === undefined ? undefined : { sessionId: activeSessionId }
    this.sidebar?.closeTab(CANVAS_TAB_TYPE, scope)
    this.publish()
  }

  /** Select an artifact and jump to its newest checkpoint. */
  select(id: string): void {
    const state = this.ui()
    state.selectedId = id
    // Selection happens from the mounted tab body (a picker click) or the
    // single-artifact auto-select, so the canvas IS open — keep the flag in
    // step or a later rebind/session switch would treat it as closed.
    state.open = true
    this.streamFollowState = false
    const timeline = this.timelinesValue.get(id)
    const count = timeline?.checkpoints.length ?? 0
    state.viewIndex = count === 0 ? -1 : count - 1
    this.publish()
  }

  /** Move the viewed checkpoint by `delta` (clamped). */
  navigate(delta: number): void {
    const state = this.ui()
    const timeline = state.selectedId === undefined ? undefined : this.timelinesValue.get(state.selectedId)
    const count = timeline?.checkpoints.length ?? 0
    if (count === 0) return
    const next = Math.min(count - 1, Math.max(0, state.viewIndex + delta))
    if (next !== state.viewIndex) {
      state.viewIndex = next
      this.publish()
    }
  }

  /** Jump to the newest checkpoint. */
  /** Jump to the CURRENT state: after a revert that is the reverted-to
   *  checkpoint (equal to the working copy), not blindly the newest save. */
  jumpCurrent(): void {
    const state = this.ui()
    const timeline = state.selectedId === undefined ? undefined : this.timelinesValue.get(state.selectedId)
    if (timeline === undefined || timeline.checkpoints.length === 0) return
    const current = currentCheckpointIndex(timeline)
    if (state.viewIndex !== current) {
      state.viewIndex = current
      this.publish()
    }
  }

  /**
   * Report the draft chat node's delta-phase preview (called on every draft
   * publication; `undefined` clears it).
   */
  reportStream(preview: StreamPreview | undefined): void {
    if (preview === undefined && this.reportedValue === undefined) return
    this.reportedValue = preview
    if (this.lastConversation !== undefined) this.ingest(this.lastConversation, false)
  }

  /**
   * Whether a running tool call the chat is about to draw is a KNOWN dead
   * attempt — a disconnect stranded the call while a retried one settled (or
   * the in-flight stream died with the step). Chat rows check this before
   * painting their 正在修改/正在生成 row; a zombie row hides instead.
   * @param callId - the running call's id.
   * @returns true when the call is confirmed dead.
   */
  isZombieCall(callId: string): boolean {
    return this.zombieIds.has(callId)
  }

  // -------------------------------------------------------------- snapshots

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): CanvasSnapshot => this.snapshotValue

  /** Test-only: detach everything and clear all transient singleton state. */
  resetForTests(): void {
    this.feedDisposer?.()
    this.sessionDisposer?.()
    this.chatDisposer?.()
    this.feedDisposer = undefined
    this.sessionDisposer = undefined
    this.chatDisposer = undefined
    this.clearRetry()
    this.retryAttempt = 0
    this.hostListFetched = false
    this.hostTimelines.clear()
    activeSessions = undefined
    activeSessionId = undefined
    this.lastConversation = undefined
    this.reportedValue = undefined
    this.runningStreamValue = undefined
    this.pendingValue = undefined
    this.zombieIds = new Set()
    this.timelinesValue = new Map()
    this.persistDirValue = undefined
    this.orderValue = []
    this.localOverlay = []
    this.sessionUi.clear()
    this.needsSidebarReplay = false
    try {
      const keysToDelete: string[] = []
      for (let i = 0; i < (globalThis.localStorage?.length ?? 0); i += 1) {
        const key = globalThis.localStorage?.key(i)
        if (typeof key === 'string' && key.startsWith(UI_STORAGE_PREFIX)) keysToDelete.push(key)
      }
      for (const key of keysToDelete) globalThis.localStorage?.removeItem(key)
    } catch { /* no-op */ }
    this.streamFollowState = false
    this.baselineSeq = 0
    this.scannedLength = -1
    this.scannedMinSeq = Number.MAX_SAFE_INTEGER
    this.cachedEntries = []
    this.publish()
  }
}

/** The process-wide canvas bridge singleton. */
export const canvasBridge = new CanvasBridge()

/**
 * React hook over the canvas bridge state.
 * @returns the current canvas snapshot.
 */
export function useCanvasState(): CanvasSnapshot {
  return useSyncExternalStore(canvasBridge.subscribe, canvasBridge.getSnapshot)
}

// ------------------------------------------------------------ submissions

function formatSubmissionCommand(artifactId: string, title: string | undefined, data: unknown): string {
  return `/artifact-submit ${JSON.stringify({
    id: artifactId,
    ...title === undefined ? {} : { title },
    data,
  })}`
}

async function runCommand(line: string): Promise<boolean> {
  const sessions = activeSessions
  const id = activeSessionId
  if (sessions === undefined || id === undefined) return false
  let binding: ReturnType<ISessions['binding']> | undefined
  try {
    binding = sessions.binding(id)
  } catch {
    return false
  }
  if (binding === undefined) return false
  const result = await binding.session.command(line)
  return result.ok === true && result.value.matched === true
}

/**
 * Deliver one interaction submission to the current session.
 * @param artifactId - the artifact id.
 * @param title - optional artifact display title.
 * @param data - the collected interaction payload.
 * @returns whether the command matched and executed.
 */
export function submitInteraction(artifactId: string, title: string | undefined, data: unknown): Promise<boolean> {
  return runCommand(formatSubmissionCommand(artifactId, title, data))
}

/**
 * Revert the working copy of one artifact to a saved version through the
 * `/artifact-revert` command (the host mutates its store and wakes the model).
 * @param artifactId - the artifact id.
 * @param version - the saved version to restore.
 * @param title - optional artifact display title.
 * @returns whether the command matched and executed.
 */
export function submitRevert(artifactId: string, version: number, title: string | undefined): Promise<boolean> {
  return runCommand(`/artifact-revert ${JSON.stringify({
    id: artifactId,
    version,
    ...title === undefined ? {} : { title },
  })}`)
}

/** One importable artifact in the cross-session library, as the route reports it. */
export interface LibraryArtifact {
  artifactId: string
  title?: string
  interactive?: boolean
  /** How many saved versions the source has (the chooser's upper bound). */
  versions: number
  bytes: number
  origin?: { sessionId: string; artifactId: string }
}

/** One source session and its importable artifacts. */
export interface LibrarySession {
  sessionId: string
  title?: string
  artifacts: LibraryArtifact[]
}

/** One saved version of a source artifact, for the version chooser. */
export interface LibraryVersion {
  version: number
  time: number
  bytes: number
}

/** The library listing, or a reason it is unavailable. */
export type LibraryListing =
  | { ok: true; sessions: LibrarySession[] }
  | { ok: false; reason: string }

/**
 * The host's saved-version cap, mirrored for the picker.
 *
 * MUST equal the host's `MAX_VERSIONS`; tests/contracts.spec.ts asserts it. The
 * host trims a source artifact's history when an import carries more versions
 * than it can keep, so the picker must not offer a selection the store will
 * silently truncate.
 */
export const MAX_IMPORT_VERSIONS = 20

/**
 * Read the cross-session artifact library.
 *
 * Returns a discriminated result rather than throwing, because the picker's
 * only job on failure is to show the reason: the route is fenced, so a 403
 * means the host half is not loaded or the page is cross-origin, and that is
 * worth saying out loud instead of rendering an empty list the user would read
 * as "you have no other artifacts".
 * @param currentSessionId - excluded from the listing (already in the store).
 * @returns the listing, or a reason it could not be read.
 */
export async function fetchLibrary(currentSessionId: string | undefined): Promise<LibraryListing> {
  const query = currentSessionId === undefined ? '' : `?currentSessionId=${encodeURIComponent(currentSessionId)}`
  try {
    const response = await fetch(`/artifact/api/library${query}`)
    if (!response.ok) return { ok: false, reason: `库读取失败（HTTP ${response.status}）` }
    const body = await response.json() as { ok?: unknown; sessions?: unknown }
    if (body.ok !== true || !Array.isArray(body.sessions)) return { ok: false, reason: '库返回了意外的数据' }
    const sessions: LibrarySession[] = []
    for (const raw of body.sessions) {
      if (raw === null || typeof raw !== 'object') continue
      const entry = raw as { sessionId?: unknown; title?: unknown; artifacts?: unknown }
      if (typeof entry.sessionId !== 'string' || !Array.isArray(entry.artifacts)) continue
      const artifacts: LibraryArtifact[] = []
      for (const item of entry.artifacts) {
        if (item === null || typeof item !== 'object') continue
        const a = item as Record<string, unknown>
        if (typeof a.artifactId !== 'string') continue
        const originRaw = a.origin as { sessionId?: unknown; artifactId?: unknown } | undefined
        const origin = originRaw !== undefined
          && typeof originRaw.sessionId === 'string' && typeof originRaw.artifactId === 'string'
          ? { sessionId: originRaw.sessionId, artifactId: originRaw.artifactId }
          : undefined
        artifacts.push({
          artifactId: a.artifactId,
          ...typeof a.title === 'string' ? { title: a.title } : {},
          ...a.interactive === true ? { interactive: true } : {},
          versions: typeof a.versions === 'number' ? a.versions : 1,
          bytes: typeof a.bytes === 'number' ? a.bytes : 0,
          ...origin === undefined ? {} : { origin },
        })
      }
      if (artifacts.length === 0) continue
      sessions.push({
        sessionId: entry.sessionId,
        ...typeof entry.title === 'string' ? { title: entry.title } : {},
        artifacts,
      })
    }
    return { ok: true, sessions }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read one source artifact's saved versions, for the import version chooser.
 * @param sessionId - the source session.
 * @param artifactId - the source artifact.
 * @returns the version list, or a reason it could not be read.
 */
export async function fetchLibraryVersions(
  sessionId: string,
  artifactId: string,
): Promise<{ ok: true; versions: LibraryVersion[] } | { ok: false; reason: string }> {
  try {
    const response = await fetch(`/artifact/api/library?sessionId=${encodeURIComponent(sessionId)}&artifactId=${encodeURIComponent(artifactId)}`)
    if (!response.ok) return { ok: false, reason: `版本读取失败（HTTP ${response.status}）` }
    const body = await response.json() as { ok?: unknown; artifact?: { versions?: unknown } }
    if (body.ok !== true || !Array.isArray(body.artifact?.versions)) {
      return { ok: false, reason: '版本列表返回了意外的数据' }
    }
    const versions: LibraryVersion[] = []
    for (const raw of body.artifact.versions) {
      if (raw === null || typeof raw !== 'object') continue
      const entry = raw as { version?: unknown; time?: unknown; bytes?: unknown }
      if (typeof entry.version !== 'number') continue
      versions.push({
        version: entry.version,
        time: typeof entry.time === 'number' ? entry.time : 0,
        bytes: typeof entry.bytes === 'number' ? entry.bytes : 0,
      })
    }
    return { ok: true, versions }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Run a cross-session import through the `/artifact-import` command.
 *
 * `versions` is omitted for the default (working copy only). Passing an array
 * carries exactly those saved versions.
 * @param sessionId - the source session.
 * @param artifactId - the source artifact.
 * @param versions - source versions to carry over; omit for the working copy.
 * @returns whether the command matched and executed.
 */
export function submitImport(
  sessionId: string,
  artifactId: string,
  versions: number[] | undefined,
): Promise<boolean> {
  return runCommand(`/artifact-import ${JSON.stringify({
    sessionId,
    artifactId,
    ...versions === undefined || versions.length === 0 ? {} : { versions },
  })}`)
}
