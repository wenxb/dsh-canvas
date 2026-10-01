/**
 * dsh-html-artifact host plugin: registers the `artifact` tool — create,
 * patch, save, revert, read, destroy, list — over a per-session in-memory
 * store with EXPLICIT versioning: `create` saves 版本 1; `patch` mutates the
 * working copy WITHOUT creating a version (the model batches its edits and
 * calls `save` when the artifact reaches a state worth keeping); `revert`
 * resets the working copy to a previously saved version. Every mutation op
 * projects the full current HTML through `output.presentationMeta`, so the
 * GUI renders a live sandboxed preview and the session log replays it without
 * this process state. `presentationMeta` is the ONLY render path: it rides the
 * tool-result EVENT as `data.meta`, which the client's `tool.call.toolview`
 * reads and discriminates by the raw `op` vocabulary. There is deliberately no
 * `presentResult` — DSH keeps host `presentCall`/`presentResult` values off the
 * Client, so such a view would have no consumer this side of the boundary.
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
// Type-only: activates the `ctx.skills` Context augmentation without emitting an
// import at runtime (the service is resolved through `ctx.inject`, so a profile
// without the skill registry still loads this plugin).
import type {} from '@deepseek-ai/dsh-skill'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[]
import {
  parseRevertRequest,
  parseSubmissionPayload,
  renderInteractionSubmission,
  renderSubmissionSummary,
} from './interaction.ts'
import { ArtifactStore, UnknownVersionError, rebuildFromMetas, truncateHtml, type ArtifactMetaLike } from './registry.ts'
import { DEFAULT_PERSIST_ROOT, makePersister, persistDirFor, type ArtifactPersistence } from './persistence.ts'
import { LIBRARY_MAX_ARTIFACTS, librarySessionIds, readLibraryArtifact, scanLibrary } from './library.ts'
import {
  ARTIFACT_SKILL_BODY,
  ARTIFACT_SKILL_DESCRIPTION,
  ARTIFACT_SKILL_NAME,
  ARTIFACT_SKILL_SOURCE,
  ARTIFACT_SKILL_WHEN_TO_USE,
} from './skill.ts'
import { join, dirname, resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

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
type ArtifactOp = 'create' | 'patch' | 'save' | 'revert' | 'interactive' | 'read' | 'destroy' | 'list' | 'library' | 'history' | 'import' | 'export'

/**
 * The ONE op list. Every other surface that enumerates ops — the tool's input
 * enum, its output enum, and the presentation switch — MUST derive from this,
 * never re-type the list. They previously drifted: `library`/`history`/`import`
 * were added to the handler and the output schema but NOT to the input enum,
 * which silently made the whole cross-session feature uncallable by the model
 * (an unknown enum member is rejected before `execute` ever runs). The
 * `contracts.spec.ts` test now pins them together.
 */
export const ARTIFACT_OPS: readonly ArtifactOp[] = ['create', 'patch', 'save', 'revert', 'interactive', 'read', 'destroy', 'list', 'library', 'history', 'import', 'export']

interface CreateArgs { op: 'create'; title?: string; html?: string; interactive?: boolean }
interface PatchArgs { op: 'patch'; id: string; old_string: string; new_string: string; replace_all?: boolean }
interface SaveArgs { op: 'save'; id: string }
interface RevertArgs { op: 'revert'; id: string; version: number }
interface InteractiveArgs { op: 'interactive'; id: string; value: boolean }
interface ReadArgs { op: 'read'; id: string }
interface DestroyArgs { op: 'destroy'; id: string }
interface ListArgs { op: 'list' }
interface ExportArgs { op: 'export'; id: string; path?: string; version?: number }

type ArtifactArgs = CreateArgs | PatchArgs | SaveArgs | RevertArgs | InteractiveArgs | ReadArgs | DestroyArgs | ListArgs | ExportArgs

/** Canonical per-op output values (the loose output schema's valid subsets). */
interface CreateValue { op: 'create'; id: string; version: number; title?: string; html: string; interactive?: boolean; path?: string }
interface PatchValue { op: 'patch'; id: string; version: number; html: string; applied: number }
interface SaveValue { op: 'save'; id: string; version: number; html: string; title?: string; unchanged: boolean }
interface RevertValue { op: 'revert'; id: string; version: number; html: string; title?: string }
interface InteractiveValue { op: 'interactive'; id: string; version: number; interactive: boolean; title?: string }
interface ReadValue { op: 'read'; id: string; version: number; html: string; truncated: boolean }
interface DestroyValue { op: 'destroy'; id: string; removed: true }
interface ListValue { op: 'list'; dir?: string; artifacts: { id: string; version: number; bytes: number; title?: string; origin?: { sessionId: string; artifactId: string } }[] }

/** One importable artifact, as `library` reports it (metadata + short preview). */
interface LibraryArtifactValue {
  artifactId: string
  title?: string
  versions: number
  bytes: number
  preview?: string
}
/** One source session in the library listing. */
interface LibrarySessionValue {
  sessionId: string
  title?: string
  artifacts: LibraryArtifactValue[]
}
interface LibraryValue { op: 'library'; sessions: LibrarySessionValue[] }

/** One saved version of an artifact somewhere else, as `history` reports it. */
interface HistoryValue {
  op: 'history'
  sessionId: string
  artifactId: string
  title?: string
  versions: { version: number; time: number; bytes: number }[]
}

/** The result of importing another session's artifact into this one. */
interface ImportValue {
  op: 'import'
  id: string
  version: number
  title?: string
  html: string
  versions: number
  origin: string
}

/** A standalone HTML file written into the workspace. */
interface ExportValue {
  op: 'export'
  id: string
  version: number
  title?: string
  /** Absolute path of the written file. */
  path: string
  bytes: number
}

type ArtifactValue = CreateValue | PatchValue | SaveValue | RevertValue | InteractiveValue | ReadValue | DestroyValue | ListValue | LibraryValue | HistoryValue | ImportValue | ExportValue

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

/** The owning session's validated absolute cwd, probed defensively. */
function cwdOf(agent: Agent): string | undefined {
  const session = agent.session as unknown as { header?: { cwd?: unknown }; meta?: { cwd?: unknown }; cwd?: unknown } | undefined
  const candidate = session?.header?.cwd ?? session?.meta?.cwd ?? session?.cwd
  return typeof candidate === 'string' && candidate !== '' ? candidate : undefined
}

/** Characters that are never safe in a filename on the platforms DSH runs on. */
const UNSAFE_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * Build the default export filename stem from an artifact's title.
 *
 * Titles are user prose and often CJK. An earlier version of this translated
 * the title to ASCII, which turned `鹈鹕骑自行车 · SVG 动画` into just `SVG` — a
 * name that identifies nothing. Non-ASCII letters are legal in filenames on
 * every platform DSH runs on, so they are KEPT and only genuinely unsafe
 * characters (path separators, control codes, Windows-reserved punctuation) are
 * removed. A title yielding no letters or digits at all falls back to the
 * artifact id, which is stable and greppable back to `list`/`read`.
 * @param title - the artifact's display title, when it has one.
 * @param id - the artifact id, used as the fallback stem.
 * @param version - the exported version, appended when a version was named.
 * @returns a filename stem with no extension or path separators.
 */
export function exportFileName(title: string | undefined, id: string, version: number | undefined): string {
  const base = slugifyTitle(title) || id
  return version === undefined ? base : `${base}-v${version}`
}

/** Filename-safe stem from a title, or '' when it carries no letters/digits. */
export function slugifyTitle(title: string | undefined): string {
  if (title === undefined) return ''
  const slug = title
    .replace(UNSAFE_FILENAME, ' ')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  // Require a real letter or digit (Unicode-aware), so a title of only
  // punctuation or separators is not mistaken for a name.
  return /[\p{L}\p{N}]/u.test(slug) ? slug.slice(0, 80) : ''
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
 * Human titles for source sessions, keyed by the SANITIZED directory name the
 * library reports.
 *
 * WHY THIS IS LABELING ONLY: the artifacts root on disk is the source of truth
 * for what EXISTS, while `sessionQuery` is a convenience for putting a readable
 * name on a session. A session whose log is pruned, archived or gone entirely
 * still has artifacts, and the library must list them — so a failed or empty
 * title lookup degrades to "show the id", never to "hide the artifact".
 *
 * The host keys titles by the REAL session id, while our directories hold the
 * SANITIZED id; for every id this plugin produces the two are identical (see the
 * round-trip contract test), so a direct lookup works and a miss is harmless.
 * @param ctx - the plugin context (sessionQuery is optional).
 * @param only - restrict the read to one session id.
 */
async function readSessionTitles(ctx: Context, only?: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const query = (ctx as unknown as {
    sessionQuery?: { readTitleSnapshots(ids: readonly string[]): Promise<readonly { sessionId: string; status: string; value?: { title?: { title?: string } } }[]> }
  }).sessionQuery
  if (query === undefined) return titles
  try {
    const results = await query.readTitleSnapshots(only ?? librarySessionIds(DEFAULT_PERSIST_ROOT()))
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      const title = result.value?.title?.title
      if (typeof title === 'string' && title !== '') titles.set(result.sessionId, title)
    }
  } catch (error) {
    console.warn('[dsh-html-artifact] session titles unavailable:', error)
  }
  return titles
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
    //
    // `store.size()`, NOT `store.list().length`: list() hides tombstones, so a
    // session whose artifacts were all destroyed re-ran the full walk on every
    // single `list` call. Tying the watermark to the log length AND a populated
    // store is still correct because a store rebuilt from log content cannot
    // have entries the log lacks — the disk cache populates it before this
    // runs, and the watermark is only recorded after a walk over that log.
    const seen = replayedThrough.get(agent)
    if (seen === logLength && logLength >= 0 && store.size() > 0) return
  } else if (id === undefined) {
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
    // adoptReplay (not a bare `if (!has) restore`): the log is authoritative
    // for CONTENT, so an artifact already present from the disk cache must
    // still be updated when the log is newer. Skipping it kept the store on
    // stale html and the next patch then edited pre-patch text.
    store.adoptReplay(rebuiltId, snapshot)
  }
  if (all && logLength >= 0) replayedThrough.set(agent, logLength)
}

/** Register the `artifact` tool. */
/**
 * The pending-call card for one `artifact` invocation.
 *
 * The artifact card is result-only: a running call has no id/html to draw, so
 * every pending state is a plain generic card chosen BY OP. Titles are
 * user-facing → Chinese.
 *
 * EXTRACTED FROM THE TOOL DEFINITION so a test can assert every op in
 * {@link ARTIFACT_OPS} has a card: an op missing here renders no pending card
 * at all, which is exactly the class of drift that made `library`/`history`/
 * `import` uncallable. The `switch` deliberately has no `default` fallback that
 * hides the gap — a new op must be added here.
 * @param args - the raw tool arguments.
 * @returns the generic card, or undefined for a non-artifact shape.
 */
export function presentCallForArtifact(args: unknown): { card: 'generic'; title: string; kind: 'read' | 'edit' | 'delete' | 'other'; rawInput?: unknown } | undefined {
  const record = (args ?? {}) as Record<string, unknown>
  const id = record.id
  switch (record.op) {
    case 'create': return { card: 'generic', title: '创建 HTML artifact', kind: 'other' }
    case 'patch': return { card: 'generic', title: `修改 artifact ${String(id)}`, kind: 'edit', rawInput: record.old_string }
    case 'save': return { card: 'generic', title: `保存版本 ${String(id)}`, kind: 'other' }
    case 'revert': return { card: 'generic', title: `回退 artifact ${String(id)} 到 版本 ${String(record.version ?? '')}`, kind: 'other' }
    case 'interactive': return { card: 'generic', title: `更新交互开关 artifact ${String(id)}`, kind: 'other' }
    case 'read': return { card: 'generic', title: `读取 artifact ${String(id)}`, kind: 'read' }
    case 'destroy': return { card: 'generic', title: `删除 artifact ${String(id)}`, kind: 'delete' }
    case 'list': return { card: 'generic', title: '列出 HTML artifacts', kind: 'read' }
    case 'library': return { card: 'generic', title: '浏览其他会话的 artifact 库', kind: 'read' }
    case 'history': return { card: 'generic', title: `查看 ${String(record.session_id ?? '')}/${String(record.artifact_id ?? '')} 的版本`, kind: 'read' }
    case 'import': return { card: 'generic', title: `导入 ${String(record.session_id ?? '')}/${String(record.artifact_id ?? '')}`, kind: 'other' }
    case 'export': return { card: 'generic', title: `导出 artifact ${String(id)} 为独立 HTML 文件`, kind: 'read' }
    default: return undefined
  }
}

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

  // The conditional half of the tool's guidance, as a lazily-loaded skill.
  //
  // OPTIONAL on purpose: `skills` is not in this plugin's `inject` list, so a
  // profile without the skill registry still loads the plugin and the tool
  // works — only the extra guidance is unavailable. Declaring `skills` as a
  // required injection instead would make the ENTIRE artifact feature fail to
  // mount in any profile lacking it, which is a far worse failure than a
  // missing optional instruction.
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.skills.register({
      name: ARTIFACT_SKILL_NAME,
      description: ARTIFACT_SKILL_DESCRIPTION,
      whenToUse: ARTIFACT_SKILL_WHEN_TO_USE,
      source: ARTIFACT_SKILL_SOURCE,
      content: ARTIFACT_SKILL_BODY,
    })
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
      // The interaction-data protocol and the after-render delivery rule are
      // CONDITIONAL: they matter only for an interactive artifact, or right
      // after one renders. They live in the `html-artifact` SKILL (src/skill.ts)
      // so they cost prompt tokens only when loaded — see that module for the
      // split rule. This description keeps only what is needed to CALL the tool.
      + `For interaction data and post-render delivery, load the \`${ARTIFACT_SKILL_NAME}\` skill.`,
    parameters: {
      op: {
        type: 'string', required: true,
        enum: [...ARTIFACT_OPS],
        description: 'The operation: create | patch | save | revert | interactive | read | destroy | list | library | history | import | export. '
          + 'library/history/import read artifacts persisted by OTHER sessions: library lists them (metadata only, no HTML), '
          + 'history lists ONE artifact\'s saved versions, and import copies a chosen artifact INTO this session as a NEW artifact. '
          + 'export writes the artifact out as a standalone .html file in the workspace.',
      },
      title: { type: 'string', description: 'create: optional display title for the artifact.' },
      interactive: { type: 'boolean', description: 'create: true when you need the user\'s interaction data back (canvas shows 提交交互; in-page data reaches you ONLY via the 提交交互 button, [data-artifact-submit] element clicks, or real form submits — ordinary controls never submit). Omit for presentational artifacts.' },
      value: { type: 'boolean', description: 'interactive: the new flag value (true = collect interaction data).' },
      html: { type: 'string', description: 'create: the initial HTML source (may be empty).' },
      id: { type: 'string', description: 'patch/save/revert/read/destroy: the artifact id returned by create or list.' },
      old_string: { type: 'string', description: 'patch: the exact substring to find in the artifact\'s HTML source.' },
      new_string: { type: 'string', description: 'patch: the replacement text.' },
      replace_all: { type: 'boolean', description: 'patch: replace every occurrence instead of only the first (default false).' },
      version: { type: 'number', description: 'revert: the saved version number to restore (see earlier save results). export: the saved version to write out; omit for the current working copy.' },
      path: { type: 'string', description: 'export: destination file path (absolute, or relative to the session cwd). Omit for a generated name in the workspace.' },
      session_id: { type: 'string', description: 'library/history/import: the SOURCE session id, as `library` reports it (the on-disk directory name).' },
      artifact_id: { type: 'string', description: 'history/import: the SOURCE artifact id within that session, as `library` reports it.' },
      all_versions: { type: 'boolean', description: 'import: also carry over every saved version of the source artifact (default false = working copy only).' },
      versions: { type: 'array', items: { type: 'integer' }, description: 'import: carry over ONLY these source version numbers (overrides all_versions). Use op:"history" to see them first.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', required: true, enum: [...ARTIFACT_OPS] },
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
          origin: { type: 'string' },
          bytes: { type: 'integer' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                title: { type: 'string' },
                artifacts: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      artifactId: { type: 'string', required: true },
                      title: { type: 'string' },
                      versions: { type: 'integer', required: true },
                      bytes: { type: 'integer', required: true },
                      preview: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
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
          case 'library': {
            if (value.sessions.length === 0) {
              return [{ type: 'text', text: 'No artifacts from OTHER sessions are available to import. (Artifacts in this session are already here — use `list`.)' }]
            }
            const lines: string[] = []
            for (const session of value.sessions) {
              lines.push(`session ${session.sessionId}${session.title === undefined ? '' : ` — ${session.title}`}`)
              for (const artifact of session.artifacts) {
                const label = artifact.title === undefined ? '' : ` (${artifact.title})`
                lines.push(`- ${artifact.artifactId}${label} · ${artifact.versions} 版本 · ${artifact.bytes} bytes`)
              }
            }
            return [{
              type: 'text',
              text: `Importable artifacts from other sessions (${value.sessions.reduce((total, session) => total + session.artifacts.length, 0)}):\n${lines.join('\n')}`
                + '\nImport one with `op:"import"`, giving its session_id and artifact_id.'
                + ' By default only the CURRENT state is carried over; pass all_versions:true to bring the whole version history,'
                + ' or call `op:"history"` first to choose specific versions with versions:[...].'
                + ' Importing copies INTO this session — the source session is never modified.',
            }]
          }
          case 'history': {
            const lines = value.versions.map(entry => `- 版本 ${entry.version} · ${entry.bytes} bytes · ${new Date(entry.time).toISOString()}`)
            return [{
              type: 'text',
              text: `Saved versions of ${value.artifactId} in session ${value.sessionId}${value.title === undefined ? '' : ` (${value.title})`}:\n${lines.join('\n')}`
                + `\nImport the artifact with \`op:"import"\` (versions:[...] to pick specific ones, all_versions:true for every version).`,
            }]
          }
          case 'import':
            return [{
              type: 'text',
              text: `Imported artifact ${value.origin} as ${value.id} (版本 ${value.version}, ${value.versions} 版本 carried over).`
                + ' It is now a normal artifact of THIS session: patch/save/revert/read all work on it, and the source session is untouched.'
                + ' The live preview updated in place — this rendering IS the deliverable, do not write prose describing it in your reply.',
            }]
          case 'export':
            return [{
              type: 'text',
              text: `Exported artifact ${value.id} (版本 ${value.version}, ${value.bytes} bytes) to ${value.path}.`
                + ' This is a standalone .html file the user can open, share or archive outside DSH; it is a COPY,'
                + ' so later edits to the artifact do NOT update it — re-export to refresh it.',
            }]
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
          // An IMPORTED artifact projects exactly like a created one, plus its
          // provenance, so the canvas renders a live preview and a source badge
          // with no client special-case beyond reading `origin`.
          case 'import':
            return {
              op: 'create', id: value.id, version: value.version, html: value.html,
              ...value.title === undefined ? {} : { title: value.title },
              importedFrom: value.origin,
            }
          // `library` and `history` are READ-ONLY listings of other sessions.
          // They project an op the client already knows how to ignore as a
          // non-preview card (`list`), rather than a new previewable op: there
          // is nothing to render, and the canvas must not treat remote content
          // as this session's artifact. The session/artifact data stays in the
          // event for the model's own reading.
          case 'library':
          case 'history':
            return { op: 'list', artifacts: [] }
          // `export` changes NO artifact state — it reads one and writes a file
          // elsewhere. Projecting it as a previewable op would make the canvas
          // adopt it as this session's artifact and jump the user's selection,
          // so it projects the same inert `list` card as the other read-only ops.
          case 'export':
            return { op: 'list', artifacts: [] }
        }
      },
    },
    async execute(args, exec) {
      const store = storeFor(exec.agent, persistRoot)
      const op = (args as Record<string, unknown>).op
      const rawId = (args as Record<string, unknown>).id
      if (exec.agent !== undefined) {
        ensureFromLog(exec.agent, store, typeof rawId === 'string' ? rawId : undefined, op === 'list' || op === 'library')
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
        case 'export': {
          // `export` writes a STANDALONE .html file the user can open, mail or
          // keep outside DSH — the counterpart to `import`. It is a pure READ of
          // the store (nothing about the artifact changes) plus one file write.
          //
          // Source selection mirrors `revert`: `version` picks a frozen saved
          // version; omitting it exports the WORKING COPY (what the canvas shows).
          const raw = args as Record<string, unknown>
          const id = requireString(raw, 'id', 'export')
          const version = raw.version
          if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version) || version < 1)) {
            throw new Error('artifact export: `version` must be a positive integer (or omitted for the working copy)')
          }
          const state = store.get(id)
          let html = state.html
          if (typeof version === 'number') {
            const found = store.versionsOf(id).find(entry => entry.version === version)
            if (found === undefined) throw new UnknownVersionError(id, version)
            html = found.html
          }
          // Destination: an explicit `path`, else a readable name in the
          // workspace. The title is slugified because it is user prose and often
          // CJK — CJK has no safe filename form, so those become the artifact id
          // rather than a pile of underscores.
          const cwd = exec.agent !== undefined ? cwdOf(exec.agent) : undefined
          const explicit = typeof raw.path === 'string' && raw.path.trim() !== '' ? raw.path.trim() : undefined
          const destination = explicit !== undefined
            ? resolve(cwd ?? process.cwd(), explicit)
            : join(cwd ?? process.cwd(), `${exportFileName(state.title, id, version)}.html`)
          mkdirSync(dirname(destination), { recursive: true })
          writeFileSync(destination, html, 'utf-8')
          return Promise.resolve({
            op: 'export', id, version: typeof version === 'number' ? version : state.version,
            path: destination, bytes: bytesOf(html),
            ...state.title === undefined ? {} : { title: state.title },
          })
        }
        case 'list': {
          const dir = exec.agent !== undefined && persistRoot !== '' ? persistDirFor(persistRoot, sessionIdOf(exec.agent) ?? 'unknown') : undefined
          return Promise.resolve({ op: 'list', ...dir === undefined ? {} : { dir }, artifacts: store.list() })
        }
        case 'library': {
          // READ-ONLY enumeration of other sessions' artifacts. The current
          // session is excluded (its artifacts are already in the store).
          const raw = args as Record<string, unknown>
          const sessionFilter = typeof raw.session_id === 'string' && raw.session_id !== '' ? raw.session_id : undefined
          const currentSession = exec.agent === undefined ? undefined : sessionIdOf(exec.agent)
          // Only title the sessions actually being reported: reading titles for
          // every session directory would be wasteful when one is requested.
          const titles = await readSessionTitles(ctx, sessionFilter === undefined ? undefined : [sessionFilter])
          const sessions = scanLibrary(persistRoot, {
            ...currentSession === undefined ? {} : { excludeSessionId: currentSession },
            ...sessionFilter === undefined ? {} : { sessionId: sessionFilter },
            limit: LIBRARY_MAX_ARTIFACTS,
            ...titles.size === 0 ? {} : { titles },
          })
          return Promise.resolve({
            op: 'library',
            sessions: sessions.map(session => ({
              sessionId: session.sessionId,
              ...session.title === undefined ? {} : { title: session.title },
              artifacts: session.artifacts.map(artifact => ({
                artifactId: artifact.artifactId,
                ...artifact.title === undefined ? {} : { title: artifact.title },
                versions: artifact.versionCount,
                bytes: artifact.bytes,
                preview: artifact.html,
              })),
            })),
          })
        }
        case 'history': {
          const raw = args as Record<string, unknown>
          const sessionId = requireString(raw, 'session_id', 'history')
          const artifactId = requireString(raw, 'artifact_id', 'history')
          const snapshot = readLibraryArtifact(persistRoot, sessionId, artifactId)
          if (snapshot === undefined) {
            throw new Error(`artifact history: no artifact ${artifactId} in session ${sessionId}`)
          }
          return Promise.resolve({
            op: 'history',
            sessionId,
            artifactId,
            ...snapshot.title === undefined ? {} : { title: snapshot.title },
            versions: snapshot.versions.map(entry => ({
              version: entry.version,
              time: entry.time,
              bytes: bytesOf(entry.html),
            })),
          })
        }
        case 'import': {
          // ONE-WAY COPY into the current session. The source directory is only
          // ever READ (readLibraryArtifact); nothing here writes to it.
          const raw = args as Record<string, unknown>
          const sessionId = requireString(raw, 'session_id', 'import')
          const artifactId = requireString(raw, 'artifact_id', 'import')
          if (exec.agent !== undefined) {
            const currentSession = sessionIdOf(exec.agent)
            if (currentSession !== undefined && currentSession === sessionId) {
              throw new Error('artifact import: that artifact is already in THIS session — use `read` with its id')
            }
          }
          const snapshot = readLibraryArtifact(persistRoot, sessionId, artifactId)
          if (snapshot === undefined) {
            throw new Error(`artifact import: no artifact ${artifactId} in session ${sessionId}`)
          }
          // Version selection, in precedence order:
          //   versions:[...]  explicit picks (an AI or user chose them);
          //   all_versions    everything the source has;
          //   (default)       the working copy only.
          // The default keeps an import small: the review's own example was a
          // 17-version artifact that would otherwise drag ~2 MB across for a
          // starting point the user usually wants the LATEST of.
          const requested = Array.isArray(raw.versions)
            ? (raw.versions as unknown[]).flatMap((entry) => typeof entry === 'number' && Number.isInteger(entry) && entry >= 1 ? [entry] : [])
            : undefined
          const allVersions = raw.all_versions === true
          const wanted = requested === undefined || requested.length === 0 ? undefined : new Set(requested)
          const sourceVersions = wanted === undefined
            ? (allVersions ? snapshot.versions : [])
            : snapshot.versions.filter(entry => wanted.has(entry.version))
          if (wanted !== undefined && sourceVersions.length === 0) {
            throw new Error(`artifact import: none of the requested versions exist in ${artifactId} (it has ${snapshot.versions.length})`)
          }
          const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : snapshot.title
          const { id, versions } = store.importArtifact({
            html: snapshot.html,
            ...title === undefined ? {} : { title },
            ...snapshot.interactive === undefined ? {} : { interactive: snapshot.interactive },
            versions: sourceVersions,
            origin: { sessionId, artifactId },
          }, maxArtifactBytes, { includeVersions: wanted !== undefined || allVersions })
          const state = store.get(id)
          return Promise.resolve({
            op: 'import',
            id,
            version: state.version,
            html: state.html,
            versions,
            origin: `${sessionId}/${artifactId}`,
            ...state.title === undefined ? {} : { title: state.title },
          })
        }
        default:
          throw new Error(`artifact: unknown op ${String(op)}`)
      }
    },
    presentCall(args) {
      return presentCallForArtifact(args)
    },
    // NO `presentResult`. This was ~55 lines building a tagged `card: 'artifact'`
    // view that nothing consumed: it is the browser half that renders the card,
    // and DSH keeps Host `presentCall`/`presentResult` values off the Client
    // (dsh-client-ui-tool README). The card the user actually sees comes from
    // `output.presentationMeta` above, which projects the raw meta onto the
    // `tool/result` event; the client discriminates on `op` itself
    // (src/client/contract.ts:artifactCardModel). Removed rather than kept as a
    // speculative host-consumer view — it needed `as unknown as ToolResultView`
    // casts to exist at all, which is the tell that it had no real consumer.
  }))
}
