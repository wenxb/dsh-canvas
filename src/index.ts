/**
 * dsh-html-artifact host plugin: registers the `artifact` tool — create,
 * patch, save, revert, read, destroy, list — over a per-session in-memory
 * store with EXPLICIT versioning: `create` saves 版本 1; `patch` mutates the
 * working copy WITHOUT creating a version (the model batches its edits and
 * calls `save` when the artifact reaches a state worth keeping); `revert`
 * resets the working copy to a previously saved version. Every mutation op
 * projects the full current HTML through `output.presentationMeta`, so the
 * GUI renders a live sandboxed preview and the session log replays it without
 * this process state. The `card: 'artifact'` render intent is plugin-owned:
 * `presentationMeta` is what actually reaches the browser half (it rides the
 * tool-result EVENT as `data.meta`, which the client's `tool.call.toolview`
 * reads). `presentResult` below feeds only a hypothetical HOST consumer: DSH
 * states that presentCall/presentResult values never enter the Client, so the
 * browser never sees `card: 'artifact'` — the client discriminates on the raw
 * `op` vocabulary instead. Kept for host-side consumers; not the render path.
 * The core `ToolResultView` union does not know the card, so the return is a
 * deliberate cast — runtime validation is the client's documented
 * generic-card fallback.
 *
 * User-side escape hatches ride slash commands that inject a plugin notice
 * into the agent's next request context: `/artifact-submit` (interaction
 * data) and `/artifact-revert` (roll the working copy back to a saved
 * version).
 * @module @dsh-external/dsh-html-artifact
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolResultView } from '@deepseek-ai/dsh-tools'
type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[]
import {
  parseRevertRequest,
  parseSubmissionPayload,
  renderInteractionSubmission,
  renderSubmissionSummary,
} from './interaction.ts'
import { ArtifactStore, rebuildFromMetas, truncateHtml, type ArtifactMetaLike } from './registry.ts'
import { DEFAULT_PERSIST_ROOT, makePersister, persistDirFor, type ArtifactPersistence } from './persistence.ts'
import { join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-html-artifact'
/** Required capabilities: the tool registry and the slash-command registry
 *  (artifact interaction submission and user-side revert), plus `webServer`
 *  for the canvas picker's full-history artifact index route
 *  (`/artifact/api/list`). Declaring webServer in `inject` is what guarantees
 *  the service exists when `apply` runs — a soft `ctx.get('webServer')` during
 *  apply can miss it (the service mounts asynchronously) and the route would
 *  silently never register. */
export const inject = ['tools', 'commands', 'webServer']

/** Default cap on one stored artifact's HTML source. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024
/** Default cap on the HTML a `read` op returns to the model. */
export const DEFAULT_MAX_READ_BYTES = 64 * 1024

/** Model-facing artifact tool configuration. */
export interface Config {
  /** Maximum UTF-8 bytes of one artifact's stored HTML source. */
  maxArtifactBytes?: number
  /** Maximum UTF-8 bytes of HTML a `read` op returns (capped with a notice). */
  maxReadBytes?: number
  /** Root directory of the write-through disk cache; default `~/.dsh/artifacts`.
   *  Pass the literal `'off'` to disable persistence entirely. */
  persistRoot?: string
}

/** Schemastery configuration for the artifact tool consumer. */
export const Config = z.object({
  maxArtifactBytes: z.number().min(1).default(DEFAULT_MAX_ARTIFACT_BYTES),
  maxReadBytes: z.number().min(1).default(DEFAULT_MAX_READ_BYTES),
  persistRoot: z.string().default(''),
})

/** The tool's op vocabulary, one per lifecycle stage. */
type ArtifactOp = 'create' | 'patch' | 'save' | 'revert' | 'interactive' | 'read' | 'destroy' | 'list'

const ARTIFACT_OPS: readonly ArtifactOp[] = ['create', 'patch', 'save', 'revert', 'interactive', 'read', 'destroy', 'list']

interface CreateArgs { op: 'create'; title?: string; html?: string; interactive?: boolean }
interface PatchArgs { op: 'patch'; id: string; old_string: string; new_string: string; replace_all?: boolean }
interface SaveArgs { op: 'save'; id: string }
interface RevertArgs { op: 'revert'; id: string; version: number }
interface InteractiveArgs { op: 'interactive'; id: string; value: boolean }
interface ReadArgs { op: 'read'; id: string }
interface DestroyArgs { op: 'destroy'; id: string }
interface ListArgs { op: 'list' }

type ArtifactArgs = CreateArgs | PatchArgs | SaveArgs | RevertArgs | InteractiveArgs | ReadArgs | DestroyArgs | ListArgs

/** Canonical per-op output values (the loose output schema's valid subsets). */
interface CreateValue { op: 'create'; id: string; version: number; title?: string; html: string; interactive?: boolean; path?: string }
interface PatchValue { op: 'patch'; id: string; version: number; html: string; applied: number }
interface SaveValue { op: 'save'; id: string; version: number; html: string; title?: string; unchanged: boolean }
interface RevertValue { op: 'revert'; id: string; version: number; html: string; title?: string }
interface InteractiveValue { op: 'interactive'; id: string; version: number; interactive: boolean; title?: string }
interface ReadValue { op: 'read'; id: string; version: number; html: string; truncated: boolean }
interface DestroyValue { op: 'destroy'; id: string; removed: true }
interface ListValue { op: 'list'; dir?: string; artifacts: { id: string; version: number; bytes: number; title?: string }[] }

type ArtifactValue = CreateValue | PatchValue | SaveValue | RevertValue | InteractiveValue | ReadValue | DestroyValue | ListValue

/** One listable artifact summary as the model-facing result carries it. */
interface ArtifactSummaryWire { id: string; version: number; bytes: number; title?: string }

function isArtifactValue(value: unknown): value is ArtifactValue {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.op === 'string' && ARTIFACT_OPS.includes(candidate.op as ArtifactOp)
}

function bytesOf(html: string): number {
  return new TextEncoder().encode(html).byteLength
}

function headerOf(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
}

/** Same-origin browser fence for the /artifact/api routes (loopback or a
 *  trusted deployment host, and no cross-site fetch markers). Mirrors the
 *  other web plugins' route fence. */
function isTrustedRequest(req: { headers?: Record<string, string | string[] | undefined> }, trustedHosts: unknown): boolean {
  const headers = req.headers ?? {}
  const host = headerOf(headers, 'host')
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  // `new URL('http://[::1]:3080').hostname` is the BRACKETED '[::1]' — a bare
  // '::1' literal never matches (DSH's own checker uses the bracketed form).
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    || hostname.startsWith('127.') || hostname.endsWith('.localhost')
  // trustedHosts entries are BARE authorities (a LAN IP or a configured host,
  // usually without a port) while the Host header always carries the port, so
  // a naive `.includes(host)` never matches a LAN deployment and the route
  // 403s. Compare authority-shaped, exactly like DSH's own fence: an entry
  // with a port must equal `host`, a portless entry must equal `hostname`.
  const trusted = Array.isArray(trustedHosts) && trustedHosts.some((entry) => {
    if (typeof entry !== 'string' || entry === '') return false
    let parsed: URL
    try {
      parsed = new URL(`http://${entry}`)
    } catch {
      return false
    }
    return parsed.port === '' ? parsed.hostname === hostname : parsed.host === host
  })
  if (!loopback && !trusted) return false
  if (headerOf(headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerOf(headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostname
  } catch {
    return false
  }
}

function requireString(args: Record<string, unknown>, key: string, label: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`artifact ${label}: \`${key}\` must be a non-empty string`)
  }
  return value
}

/** The artifact store of one owning agent (created lazily, held weakly). */
const stores = new WeakMap<Agent, ArtifactStore>()
/** Highest session log length already replayed into that agent's store. */
const replayedThrough = new WeakMap<Agent, number>()
/** The persister of one owning agent (undefined = unbound or disabled). */
const persisters = new WeakMap<Agent, ArtifactPersistence | undefined>()

/** The owning session's id, probed defensively across agent shapes. */
function sessionIdOf(agent: Agent): string | undefined {
  const candidate = (agent.session as unknown as { id?: unknown } | undefined)?.id
    ?? (agent as unknown as { sessionId?: unknown }).sessionId
  return typeof candidate === 'string' && candidate !== '' ? candidate : undefined
}

function storeFor(agent: Agent | undefined, persistRoot: string | undefined): ArtifactStore {
  if (agent === undefined) throw new Error('artifact requires an owning agent session')
  let store = stores.get(agent)
  if (store === undefined) {
    let persistence: ArtifactPersistence | undefined
    const sessionId = sessionIdOf(agent)
    if (persistRoot !== undefined && persistRoot !== '' && sessionId !== undefined) {
      persistence = makePersister(persistRoot, sessionId)
    }
    store = new ArtifactStore(persistence)
    persisters.set(agent, persistence)
    stores.set(agent, store)
    // Disk-first boot: everything this session persisted (working copies AND
    // saved versions) is restored before any log replay — the log replay only
    // heals ids the disk cache lacks (e.g. after the directory was cleaned).
    // `restore` deliberately writes nothing, so booting a session is read-only.
    if (persistence !== undefined) {
      for (const snapshot of persistence.loadAll()) {
        if (!store.has(snapshot.id)) {
          store.restore(snapshot.id, {
            html: snapshot.html,
            ...snapshot.title === undefined ? {} : { title: snapshot.title },
            ...snapshot.interactive === undefined ? {} : { interactive: snapshot.interactive },
            deleted: snapshot.deleted === true,
            versions: snapshot.versions,
          })
        }
      }
    }
  }
  return store
}

/**
 * Rebuild this session's artifacts from the durable log when the in-memory
 * store lost them (server restart / agent respawn). The session log is the
 * durable source of truth: every artifact op projects its full result meta
 * into it, so the store is always reconstructible.
 */
function ensureFromLog(agent: Agent, store: ArtifactStore, id: string | undefined, all: boolean): void {
  const sessionProbe = agent.session as unknown as { seq?: number }
  const logLength = typeof sessionProbe.seq === 'number' ? sessionProbe.seq : -1
  if (all) {
    // A full replay walks every event of the session; skip it while the log
    // has not grown since the last replay that already populated this store
    // (`list` is called often, and sessions reach tens of thousands of events).
    const seen = replayedThrough.get(agent)
    if (seen === logLength && logLength >= 0 && store.list().length > 0) return
  } else if (id === undefined || store.has(id)) {
    return
  }
  const metas: ArtifactMetaLike[] = []
  // The host Session exposes `snapshotEvents()` / `ownEvents()` — NOT an
  // `events` iterable (that name belongs to unrelated shapes, so a fresh
  // agent's log replay silently found nothing and the store stayed empty:
  // "the model cannot read back an artifact that exists on disk").
  const sessionAny = agent.session as unknown as {
    snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly { type: string; data?: unknown }[]
    ownEvents?: () => readonly { type: string; data?: unknown }[]
    events?: Iterable<{ type: string; data?: unknown }>
  }
  const events = typeof sessionAny.snapshotEvents === 'function'
    ? sessionAny.snapshotEvents()
    : typeof sessionAny.ownEvents === 'function'
      ? sessionAny.ownEvents()
      : sessionAny.events ?? []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    // The presentation meta rides at the EVENT level (`data.meta`); older
    // shapes may nest it under the message — accept both.
    const data = event.data as { meta?: unknown; message?: { meta?: unknown } } | undefined
    const meta = data?.meta ?? data?.message?.meta
    if (meta === null || typeof meta !== 'object') continue
    const candidate = meta as Record<string, unknown>
    if (typeof candidate.op !== 'string' || !ARTIFACT_OPS.includes(candidate.op as ArtifactOp)) continue
    if (typeof candidate.id !== 'string') continue
    metas.push(candidate as unknown as ArtifactMetaLike)
  }
  for (const [rebuiltId, snapshot] of rebuildFromMetas(metas)) {
    if (!all && rebuiltId !== id) continue
    // `has` (not `isLive`): a soft-deleted artifact is ALREADY present as a
    // tombstone, and re-restoring it would both overwrite that state and — in
    // the old code, where every restore wrote to disk — rewrite its files on
    // every single replay.
    if (!store.has(rebuiltId)) store.restore(rebuiltId, snapshot)
  }
  if (all && logLength >= 0) replayedThrough.set(agent, logLength)
}

/** Register the `artifact` tool. */
export function apply(ctx: Context, config: Config = {}): void {
  // Session GC DISABLED. The old behavior purged every artifact directory
  // whose session id was absent from the sessionPersistence index — but that
  // index is not a reliable liveness oracle (archived sessions, index write
  // lag, and resumed sessions with a fresh id all look "orphaned"), and one
  // restart wiped live sessions' canvases. The canvas picker now reads these
  // same directories for old sessions, so deleting them is worse than
  // useless. Artifact files stay until the user deletes the artifact via the
  // `artifact destroy` op (which removes its own files); disk usage grows
  // slowly and can be cleaned manually under ~/.dsh/artifacts/.

  const maxArtifactBytes = config.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
  const maxReadBytes = config.maxReadBytes ?? DEFAULT_MAX_READ_BYTES
  // Disk write-through cache: <persistRoot>/<sessionId>/<id>.html + manifest
  // + per-version files. The literal 'off' disables persistence entirely.
  const persistRoot = config.persistRoot === 'off' ? '' : (config.persistRoot === undefined || config.persistRoot === '' ? DEFAULT_PERSIST_ROOT() : config.persistRoot)

  // FULL-HISTORY artifact index for the canvas picker. The client-side canvas
  // only ever sees the LOADED conversation window (a tail page), so after a
  // refresh any artifact whose create op fell out of the window is invisible
  // to the picker even though the session log still carries it. The host has
  // the whole log + the store — expose the authoritative list over one small
  // route (same-origin browser requests only, same fence as other web plugins).
  // `webServer` is declared in `inject`, so it is guaranteed present here.
  const webServer = (ctx as unknown as {
    webServer: { register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }): () => void }
  }).webServer
  const webRuntime = (ctx as unknown as { get(name: string, strict?: boolean): unknown }).get('webRuntime', false) as
    | { trustedHosts?: unknown } | undefined
  const trustedHosts = webRuntime?.trustedHosts
  const agentsService = (ctx as unknown as { get(name: string, strict?: boolean): unknown }).get('agents', false) as
    | { get(id: string): Agent | undefined } | undefined
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact/api/list',
    handler: async (req: unknown, res: unknown) => {
      const reply = (status: number, body: unknown): void => {
        const response = res as { writeHead(s: number, h?: Record<string, string>): unknown; end(b: string): unknown }
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(body))
      }
      // Browser-trust fence (same-origin only, loopback/trusted hosts).
      if (!isTrustedRequest(req as { headers?: Record<string, string | string[] | undefined> }, trustedHosts)) {
        reply(403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      const request = req as { method?: string; url?: string }
      if (request.method !== 'GET' && request.method !== 'POST') {
        reply(405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      let sessionId: string | undefined
      if (request.method === 'GET') {
        sessionId = new URL(request.url ?? '/', 'http://dsh.internal').searchParams.get('sessionId') ?? undefined
      } else {
        try {
          const chunks: Buffer[] = []
          const stream = req as unknown as AsyncIterable<Buffer>
          for await (const chunk of stream) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { sessionId?: unknown }
          if (typeof body.sessionId === 'string') sessionId = body.sessionId
        } catch { /* malformed body — sessionId stays undefined */ }
      }
      if (sessionId === undefined || sessionId === '') {
        reply(400, { ok: false, error: { code: 'bad-request', message: 'sessionId required' } })
        return
      }
      try {
        // DISK FIRST: the write-through cache (~/.dsh/artifacts/<sessionId>/)
        // survives restarts and covers OLD sessions whose agent is not live —
        // a live-agent lookup (ctx.agents) returns an empty body for exactly
        // the sessions that need this route most. Each persisted snapshot
        // already carries id/title/interactive/working html/versions, which is
        // everything the client's canvas needs (the manifest's version list
        // becomes the checkpoint history; the working copy is the current
        // content). Sessions with persistence disabled or pre-persistence
        // logs fall back to the live agent's log replay.
        let artifacts = makePersister(persistRoot, sessionId).loadAll()
          .filter(snapshot => snapshot.deleted !== true)
          .map(snapshot => ({
            id: snapshot.id,
            version: snapshot.versions[snapshot.versions.length - 1]?.version ?? 1,
            bytes: bytesOf(snapshot.html),
            html: snapshot.html,
            savedVersion: snapshot.versions[snapshot.versions.length - 1]?.version ?? 1,
            // EVERY saved version's frozen source, not just the newest: the
            // client's version navigation (前后盘点 + 回退此版本) is dead
            // without the history, and the window cannot supply it when the
            // create/save ops were truncated away.
            versions: snapshot.versions.map(entry => ({ version: entry.version, html: entry.html, time: entry.time })),
            ...snapshot.title === undefined ? {} : { title: snapshot.title },
            ...snapshot.interactive === undefined ? {} : { interactive: snapshot.interactive },
          }))
        if (artifacts.length === 0) {
          const agent = agentsService?.get(sessionId)
          if (agent !== undefined) {
            const store = storeFor(agent, persistRoot)
            ensureFromLog(agent, store, undefined, true)
            artifacts = store.list().map((summary) => {
              const state = store.get(summary.id)
              return {
                ...summary,
                html: state.html,
                savedVersion: state.version,
                // Same completeness as the disk branch: without the version
                // history the client falls back to a single checkpoint and the
                // version navigation / revert controls go dead.
                versions: store.versionsOf(summary.id).map(entry => ({
                  version: entry.version,
                  html: entry.html,
                  time: entry.time,
                })),
                ...state.title === undefined ? {} : { title: state.title },
                ...state.interactive === undefined ? {} : { interactive: state.interactive },
              }
            })
          }
        }
        reply(200, { ok: true, artifacts })
      } catch (error) {
        reply(500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
      }
    },
  }), 'dsh-html-artifact: /artifact/api/list route')

  // Interaction submission: the browser half records user interaction data
  // from a sandboxed artifact surface through this slash command (host-side,
  // never sent to the model as a chat message). The submission is delivered
  // as a plugin-source context message via Agent.followup — an immediate
  // wake: the agent reads the submitted data and answers right away.
  ctx.commands.register({
    name: 'artifact-submit',
    description: 'Record user interaction data submitted from an HTML artifact preview.',
    recordInput: false,
    handler: (invocation) => {
      const parsed = parseSubmissionPayload(invocation.rawInput)
      if (!parsed.ok) return { kind: 'error', text: parsed.error }
      const message = createUserMessage({
        content: [{ type: 'text', text: renderInteractionSubmission(parsed.value) }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: renderSubmissionSummary(parsed.value),
        },
      })
      invocation.agent.followup(message)
      return { kind: 'success', text: `recorded interaction data for artifact ${parsed.value.id}` }
    },
  })

  // User-side revert: the canvas panel's 回退 button runs this command.
  // PHYSICAL revert only — the store resets the working copy; the model is
  // NOT woken (the user drives the conversation; the model re-reads the
  // source on its own when its memory and the working copy diverge).
  ctx.commands.register({
    name: 'artifact-revert',
    description: 'Revert an HTML artifact\'s working copy to one of its saved versions.',
    recordInput: false,
    handler: (invocation) => {
      const parsed = parseRevertRequest(invocation.rawInput)
      if (!parsed.ok) return { kind: 'error', text: parsed.error }
      try {
        const store = storeFor(invocation.agent, persistRoot)
        if (invocation.agent !== undefined) {
          ensureFromLog(invocation.agent, store, parsed.value.id, false)
        }
        store.revertTo(parsed.value.id, parsed.value.version)
        return { kind: 'success', text: `已回退 artifact ${parsed.value.id} 到 版本 ${parsed.value.version}（仅本地回退）` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  ctx.tools.register(defineTool({
    name: 'artifact',
    description:
      'Create and iteratively refine an interactive HTML artifact that renders LIVE in the GUI inside a sandboxed iframe. '
      + 'VERSIONING IS EXPLICIT: `create` starts an artifact and saves it as 版本 1; `patch` applies an edit-style string '
      + 'replacement (`old_string`/`new_string`, same semantics as the file `edit` tool) to the WORKING COPY by id — patches '
      + 'do NOT create versions, so batch related edits freely. WORKFLOW RULE: call `save` once per COMPLETED round of '
      + 'changes — when a whole round of overall modification is done (not after each individual patch), save immediately; '
      + 'the user gets a restore point per round and can revert to any of them. `revert` resets the working copy to a saved '
      + 'version by number. '
      + '`read` returns the current source; `destroy` closes an artifact; `list` enumerates the session\'s artifacts. '
      + 'Track every artifact id and destroy artifacts that no longer matter. Keep artifacts self-contained and reasonably '
      + 'small (inline styles/scripts; external https: images/fonts/styles allowed; network fetches allowed). '
      + 'PERSISTENCE: every artifact is also written through to disk under `~/.dsh/artifacts/<sessionId>/` '
      + '(`<id>.html` = working copy, `<id>.v<N>.html` = each saved version, `<id>.json` = manifest) — the files '
      + 'survive server restarts and can be opened/inspected directly, but they are a CACHE of the store. '
      + 'FILES ARE READ-ONLY TO YOU: NEVER modify them directly (edit/write/sed/echo/redirect — anything bypassing '
      + 'this tool). The store never sees such edits, the GUI never updates, and the next artifact op overwrites '
      + 'them wholesale. EVERY mutation — however small — MUST go through this tool (patch/save/revert). Tell the '
      + 'user this path when they ask where an artifact lives. '
      + 'FINAL-DELIVERABLE ASSERTION: a successful `create`, `save` or final `patch` renders the artifact live in the GUI — '
      + 'that rendering IS the answer to the user, not a summary of it. After finishing an artifact, do NOT write '
      + 'explanatory prose describing what you made; end the turn with at most a single short closing line (or nothing) '
      + 'unless the user explicitly asked for an explanation. Only `read`/`list` results (which return source text) '
      + 'may warrant a brief prose response. '
      + 'INTERACTION-DATA PROTOCOL: when the artifact has internal state the user will interact with (game score, '
      + 'counters, selections, results), expose it as `window.__dshArtifactData = { ... }` — a JSON value the artifact '
      + 'updates as the state changes. Decide AT CREATE TIME whether interaction data matters: pass `interactive: true` '
      + 'when you genuinely need to receive the user\'s data back (the canvas then shows a 提交交互 button); omit it for '
      + 'purely presentational artifacts so no unnecessary button shows. Toggle it any time later with the `interactive` op. '
      + 'SUBMISSION IS EXPLICIT — data reaches you ONLY through three deliberate user actions: (1) the user clicks the '
      + 'canvas header\'s 提交交互 button; (2) the user clicks an in-page element YOU marked with `data-artifact-submit` '
      + '(add that attribute only to real submit-style controls, e.g. a "提交答案/保存成绩" button); (3) a real <form> in '
      + 'the page submits (navigation is auto-suppressed, so plain forms work). EVERY OTHER control — game buttons, '
      + 'on-screen direction pads, keyboard/arrow-key handlers, sliders, tabs, ordinary links — NEVER submits regardless '
      + 'of how often it is used: design on-page controls freely and reserve `data-artifact-submit` for the exact points '
      + 'that mean "send my data to the AI".',
    parameters: {
      op: {
        type: 'string', required: true,
        enum: ['create', 'patch', 'save', 'revert', 'interactive', 'read', 'destroy', 'list'],
        description: 'The operation: create | patch | save | revert | interactive | read | destroy | list.',
      },
      title: { type: 'string', description: 'create: optional display title for the artifact.' },
      interactive: { type: 'boolean', description: 'create: true when you need the user\'s interaction data back (canvas shows 提交交互; in-page data reaches you ONLY via the 提交交互 button, [data-artifact-submit] element clicks, or real form submits — ordinary controls never submit). Omit for presentational artifacts.' },
      value: { type: 'boolean', description: 'interactive: the new flag value (true = collect interaction data).' },
      html: { type: 'string', description: 'create: the initial HTML source (may be empty).' },
      id: { type: 'string', description: 'patch/save/revert/read/destroy: the artifact id returned by create or list.' },
      old_string: { type: 'string', description: 'patch: the exact substring to find in the artifact\'s HTML source.' },
      new_string: { type: 'string', description: 'patch: the replacement text.' },
      replace_all: { type: 'boolean', description: 'patch: replace every occurrence instead of only the first (default false).' },
      version: { type: 'number', description: 'revert: the saved version number to restore (see earlier save results).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', required: true, enum: ['create', 'patch', 'save', 'revert', 'interactive', 'read', 'destroy', 'list'] },
          id: { type: 'string' },
          version: { type: 'integer' },
          title: { type: 'string' },
          html: { type: 'string' },
          applied: { type: 'integer' },
          removed: { type: 'boolean' },
          truncated: { type: 'boolean' },
          unchanged: { type: 'boolean' },
          interactive: { type: 'boolean' },
          path: { type: 'string' },
          dir: { type: 'string' },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                version: { type: 'integer', required: true },
                bytes: { type: 'integer', required: true },
                title: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!isArtifactValue(value)) return [{ type: 'text', text: 'artifact: unexpected result' }]
        switch (value.op) {
          case 'create': {
            const bytes = bytesOf(value.html)
            return [{
              type: 'text',
              text: `Created HTML artifact ${value.id} (${bytes} bytes), saved as 版本 1.`
                + ' A live preview renders in the GUI; refine it with `artifact patch` (working copy only, no new version)'
                + ' and call `save` when it reaches a state worth keeping.'
                + (value.path === undefined ? '' : ` File on disk (read-only cache — never edit directly, mutate via this tool): ${value.path} (版本 files alongside as ${value.id}.v<N>.html).`)
                + ' This rendering IS the deliverable — do not write prose describing it in your reply.',
            }]
          }
          case 'patch':
            return [{
              type: 'text',
              text: `Patched artifact ${value.id}: replaced ${value.applied} occurrence(s); the working copy is at 版本 ${value.version}`
                + ' plus unsaved edits. When this round of changes is complete, call `save` to keep it as a new version.'
                + ' The live preview updated in place — this rendering IS the deliverable, do not write prose describing it in your reply.',
            }]
          case 'save':
            return [{
              type: 'text',
              text: value.unchanged
                ? `Artifact ${value.id} already matches 版本 ${value.version}; nothing new was saved.`
                : `Saved artifact ${value.id} as 版本 ${value.version}.`,
            }]
          case 'revert':
            return [{
              type: 'text',
              text: `Reverted artifact ${value.id}'s working copy to 版本 ${value.version}.`,
            }]
          case 'interactive':
            return [{
              type: 'text',
              text: `Interaction data for artifact ${value.id} is now ${value.interactive ? 'ON — the user can 提交交互 from the canvas' : 'OFF — the 提交交互 button is hidden'}.`,
            }]
          case 'read':
            return [{
              type: 'text',
              text: `Artifact ${value.id} (working copy; newest saved 版本 ${value.version}):`
                + `${value.truncated ? `\n[truncated to ${maxReadBytes} bytes; the stored artifact is larger]` : ''}\n${value.html}`,
            }]
          case 'destroy':
            return [{ type: 'text', text: `Destroyed artifact ${value.id}.` }]
          case 'list': {
            if (value.artifacts.length === 0) return [{ type: 'text', text: '(no HTML artifacts in this session)' }]
            const lines = value.artifacts.map((summary) => {
              const label = summary.title === undefined ? '' : ` (${summary.title})`
              return `- ${summary.id}${label} 版本 ${summary.version}, ${summary.bytes} bytes`
            })
            const dir = value.dir
            return [{ type: 'text', text: `HTML artifacts (${value.artifacts.length}):\n${lines.join('\n')}${dir === undefined ? '' : `\n落盘目录（只读缓存，禁止直接改文件——一律用 artifact 工具修改）: ${dir}`}` }]
          }
        }
      },
      presentationMeta: (_args, value): JsonValue => {
        if (!isArtifactValue(value)) return null
        switch (value.op) {
          case 'create':
            return { op: 'create', id: value.id, version: value.version, html: value.html, ...value.title === undefined ? {} : { title: value.title }, ...value.interactive === undefined ? {} : { interactive: value.interactive } }
          case 'patch':
            return { op: 'patch', id: value.id, version: value.version, html: value.html, applied: value.applied }
          case 'save':
            return { op: 'save', id: value.id, version: value.version, html: value.html, unchanged: value.unchanged, ...value.title === undefined ? {} : { title: value.title } }
          case 'revert':
            return { op: 'revert', id: value.id, version: value.version, html: value.html, ...value.title === undefined ? {} : { title: value.title } }
          case 'interactive':
            return { op: 'interactive', id: value.id, version: value.version, interactive: value.interactive, ...value.title === undefined ? {} : { title: value.title } }
          case 'read':
            return { op: 'read', id: value.id, version: value.version, html: value.html, truncated: value.truncated }
          case 'destroy':
            return { op: 'destroy', id: value.id }
          case 'list':
            return { op: 'list', ...value.dir === undefined ? {} : { dir: value.dir }, artifacts: value.artifacts }
        }
      },
    },
    execute(args, exec) {
      const store = storeFor(exec.agent, persistRoot)
      const op = (args as Record<string, unknown>).op
      const rawId = (args as Record<string, unknown>).id
      if (exec.agent !== undefined) {
        ensureFromLog(exec.agent, store, typeof rawId === 'string' ? rawId : undefined, op === 'list')
      }
      switch (op) {
        case 'create': {
          const raw = args as Record<string, unknown>
          const html = typeof raw.html === 'string' ? raw.html : ''
          const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : undefined
          const interactive = typeof raw.interactive === 'boolean' ? raw.interactive : undefined
          const id = store.create(html, title, maxArtifactBytes, interactive)
          const state = store.get(id)
          const dir = exec.agent !== undefined && persistRoot !== '' ? persistDirFor(persistRoot, sessionIdOf(exec.agent) ?? 'unknown') : undefined
          return Promise.resolve({
            op: 'create', id, version: state.version, html: state.html,
            ...title === undefined ? {} : { title },
            ...interactive === undefined ? {} : { interactive },
            ...dir === undefined ? {} : { path: join(dir, `${id}.html`) },
          })
        }
        case 'interactive': {
          const raw = args as Record<string, unknown>
          const id = requireString(raw, 'id', 'interactive')
          const value = raw.value
          if (typeof value !== 'boolean') throw new Error('artifact interactive: `value` must be a boolean')
          const state = store.setInteractive(id, value)
          return Promise.resolve({
            op: 'interactive', id, version: state.version, interactive: value,
            ...state.title === undefined ? {} : { title: state.title },
          })
        }
        case 'patch': {
          const raw = args as Record<string, unknown>
          const id = requireString(raw, 'id', 'patch')
          const oldString = requireString(raw, 'old_string', 'patch')
          const newString = requireString(raw, 'new_string', 'patch')
          const replaceAll = raw.replace_all === true
          const { state, count } = store.patch(id, oldString, newString, replaceAll, maxArtifactBytes)
          return Promise.resolve({ op: 'patch', id, version: state.version, html: state.html, applied: count })
        }
        case 'save': {
          const id = requireString(args as Record<string, unknown>, 'id', 'save')
          const { state, unchanged } = store.save(id)
          return Promise.resolve({
            op: 'save', id, version: state.version, html: state.html, unchanged,
            ...state.title === undefined ? {} : { title: state.title },
          })
        }
        case 'revert': {
          const raw = args as Record<string, unknown>
          const id = requireString(raw, 'id', 'revert')
          const version = raw.version
          if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
            throw new Error('artifact revert: `version` must be a positive integer')
          }
          const state = store.revertTo(id, version)
          return Promise.resolve({
            op: 'revert', id, version, html: state.html,
            ...state.title === undefined ? {} : { title: state.title },
          })
        }
        case 'read': {
          const id = requireString(args as Record<string, unknown>, 'id', 'read')
          const state = store.get(id)
          const capped = truncateHtml(state.html, maxReadBytes)
          return Promise.resolve({
            op: 'read', id, version: state.version, html: capped.html, truncated: capped.truncated,
          })
        }
        case 'destroy': {
          const id = requireString(args as Record<string, unknown>, 'id', 'destroy')
          store.destroy(id)
          return Promise.resolve({ op: 'destroy', id, removed: true as const })
        }
        case 'list': {
          const dir = exec.agent !== undefined && persistRoot !== '' ? persistDirFor(persistRoot, sessionIdOf(exec.agent) ?? 'unknown') : undefined
          return Promise.resolve({ op: 'list', ...dir === undefined ? {} : { dir }, artifacts: store.list() })
        }
        default:
          throw new Error(`artifact: unknown op ${String(op)}`)
      }
    },
    presentCall(args) {
      // The artifact card is result-only: a running call has no id/html to
      // draw, so every pending state is a plain generic card by op. Titles
      // are user-facing → Chinese.
      const record = args as Record<string, unknown>
      const op = record.op
      const id = record.id
      switch (op) {
        case 'create': return { card: 'generic', title: '创建 HTML artifact', kind: 'other' }
        case 'patch': return { card: 'generic', title: `修改 artifact ${String(id)}`, kind: 'edit', rawInput: record.old_string }
        case 'save': return { card: 'generic', title: `保存版本 ${String(id)}`, kind: 'other' }
        case 'revert': return { card: 'generic', title: `回退 artifact ${String(id)} 到 版本 ${String(record.version ?? '')}`, kind: 'other' }
        case 'interactive': return { card: 'generic', title: `更新交互开关 artifact ${String(id)}`, kind: 'other' }
        case 'read': return { card: 'generic', title: `读取 artifact ${String(id)}`, kind: 'read' }
        case 'destroy': return { card: 'generic', title: `删除 artifact ${String(id)}`, kind: 'delete' }
        case 'list': return { card: 'generic', title: '列出 HTML artifacts', kind: 'read' }
        default: return undefined
      }
    },
    // NOTE: not the browser render path — see the module doc. The client reads
    // the raw `meta` (via presentationMeta → event data.meta) and does its own
    // op-based discrimination; this view is for host-side consumers only.
    presentResult(_args, result): ToolResultView | undefined {
      if (result.isError) return undefined
      const meta = result.meta
      if (meta === null || typeof meta !== 'object') return undefined
      const candidate = meta as Record<string, unknown>
      if (typeof candidate.op !== 'string') return undefined
      switch (candidate.op) {
        case 'create':
        case 'patch':
        case 'save':
        case 'revert':
        case 'read': {
          const { id, version, html, title, applied, truncated, unchanged, interactive } = candidate
          if (typeof id !== 'string' || typeof version !== 'number' || typeof html !== 'string') return undefined
          return {
            card: 'artifact', op: candidate.op, id, version, html,
            ...typeof title === 'string' ? { title } : {},
            ...typeof applied === 'number' ? { applied } : {},
            ...typeof truncated === 'boolean' ? { truncated } : {},
            ...typeof unchanged === 'boolean' ? { unchanged } : {},
            ...typeof interactive === 'boolean' ? { interactive } : {},
          } as unknown as ToolResultView
        }
        case 'interactive': {
          const { id, version, interactive, title } = candidate
          if (typeof id !== 'string' || typeof interactive !== 'boolean') return undefined
          return {
            card: 'artifact', op: 'interactive', id,
            ...typeof version === 'number' ? { version } : {},
            interactive,
            ...typeof title === 'string' ? { title } : {},
          } as unknown as ToolResultView
        }
        case 'destroy': {
          if (typeof candidate.id !== 'string') return undefined
          return { card: 'artifact', op: 'destroy', id: candidate.id } as unknown as ToolResultView
        }
        case 'list': {
          if (!Array.isArray(candidate.artifacts)) return undefined
          const artifacts: ArtifactSummaryWire[] = []
          for (const entry of candidate.artifacts) {
            if (entry === null || typeof entry !== 'object') return undefined
            const { id, version, bytes, title } = entry as Record<string, unknown>
            if (typeof id !== 'string' || typeof version !== 'number' || typeof bytes !== 'number') return undefined
            artifacts.push({ id, version, bytes, ...typeof title === 'string' ? { title } : {} })
          }
          return {
            card: 'artifact', op: 'list',
            ...typeof candidate.dir === 'string' && candidate.dir !== '' ? { dir: candidate.dir } : {},
            artifacts,
          } as unknown as ToolResultView
        }
        default:
          return undefined
      }
    },
  }))
}
