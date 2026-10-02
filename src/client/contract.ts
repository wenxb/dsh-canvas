/**
 * Local toolview contract for the dsh-canvas plugin: the owner currency
 * the stock ui-tool rows supply at `tool.call.toolview` and the pure
 * artifact-card derivation, declared locally so this plugin never imports the
 * stock ui-tool contract (one-way dependency). The `declare module` merge
 * restores the slot keys this plugin registers into — the stock ui-tool bundle
 * declares the toolview row with the same shape, and interface merging accepts
 * the duplicate identical declaration.
 * @module
 */
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'

// `ToolCallOwnerProps` is IMPORTED, not re-declared: the local twin this file
// used to carry had already drifted (it lacked `loadImage` and `home`), and a
// hand-written copy keeps typechecking green while silently diverging from the
// host contract. The real definition lives in
// `@deepseek-ai/dsh-client-ui-tool/lib/types/client/contract/slots.d.ts`.
export type { ToolCallOwnerProps }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Keyed atomic Tool call view (declared by the stock ui-tool chat tree). */
    'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ToolCallOwnerProps }
    // 'conversation.chat.node' is NOT re-declared here: ui-chat already
    // declares it (with a precise owner + keyProps), and a hand-written stub
    // with `owner: unknown` collides with that declaration (TS2717) while
    // hiding the real contract from this plugin.
  }
}

/** One listable artifact summary on the wire (legacy rows carry `revision`). */
export interface ArtifactSummaryView {
  id: string
  /** Newest saved version (new wire). */
  version?: number
  /** Legacy field from sessions logged before explicit versioning. */
  revision?: number
  bytes: number
  title?: string
}

/** Ops whose card carries the full HTML source. */
export type HtmlArtifactOp = 'create' | 'patch' | 'save' | 'revert' | 'read'

/**
 * The plugin-owned `card: 'artifact'` render intent the host computes from the
 * tool's `presentResult` and ships on the `tool/result` event. The core union
 * does not know this card; the wire value is parsed with these local types and
 * every malformed field falls back to the generic card. Sessions logged by the
 * pre-versioning plugin carry `revision`; new ones carry `version`.
 */
/**
 * A card that can carry artifact SOURCE.
 *
 * `html` is OPTIONAL for one op only — `patch`. The log does not store a full
 * copy of the post-patch working copy (measured: 7.87 MB of one real 29.49 MB
 * log, against 0.16 MB for the same patches' arguments), so a patch ships its
 * cause instead and the fold reproduces it. Every other op still requires it;
 * callers that need real source must narrow with a `typeof view.html === 'string'`
 * check rather than assuming.
 */
export interface ArtifactHtmlCard {
  card: 'artifact'
  op: HtmlArtifactOp
  id: string
  version?: number
  revision?: number
  html?: string
  title?: string
  applied?: number
  truncated?: boolean
  unchanged?: boolean
  /** Whether interaction data is expected (drives the 提交交互 button). */
  interactive?: boolean
}

export type ArtifactCardView =
  | ArtifactHtmlCard
  | { card: 'artifact'; op: 'interactive'; id: string; version?: number; interactive: boolean; title?: string }
  | { card: 'artifact'; op: 'destroy'; id: string }
  | { card: 'artifact'; op: 'list'; dir?: string; artifacts: ArtifactSummaryView[] }

/** The derived artifact-card material the row draws. */
export interface ArtifactCardModel {
  view: ArtifactCardModelView
}

type ArtifactCardModelView =
  | ArtifactHtmlCard
  | Extract<ArtifactCardView, { op: 'interactive' }>
  | Extract<ArtifactCardView, { op: 'destroy' }>
  | Extract<ArtifactCardView, { op: 'list' }>

/** The saved-version number of an html-bearing card (`version`, falling back
 *  to the legacy `revision`), or undefined when neither is well-formed. */
export function cardVersion(view: ArtifactHtmlCard): number | undefined {
  if (typeof view.version === 'number') return view.version
  if (typeof view.revision === 'number') return view.revision
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

const HTML_OPS: readonly string[] = ['create', 'patch', 'save', 'revert', 'read']

/**
 * Narrow a wire `card:'artifact'` view to a well-formed model, or null when
 * this call is not an artifact card (running calls have no result view; a
 * `card` or `op` value this UI version does not know arrives over the wire
 * from a newer host and takes the generic path).
 * @param block - running or settled tool node.
 * @returns the artifact-card model, or null for the generic path.
 */
export function artifactCardModel(block: ToolCallBlock): ArtifactCardModel | null {
  // Running calls have no result view; the artifact card is result-only.
  //
  // Two wire shapes reach this point:
  // - LEGACY hosts shipped the Host `presentResult` output as a tagged
  //   `{card:'artifact', ...}` view on `resultView`;
  // - CURRENT hosts keep Host `presentCall`/`presentResult` values OFF the
  //   client (dsh-client-ui-tool README: "Host presentCall and presentResult
  //   values never enter the Client") and expose only the raw persisted
  //   `output.presentationMeta` payload on `meta` — which carries no `card`
  //   tag.
  // The `op` vocabulary plus the per-op shape checks below discriminate both
  // shapes on their own, so the `card` tag is optional and must never be
  // required.
  const raw = block as unknown as { resultView?: unknown; meta?: unknown }
  const view = asRecord(raw.resultView ?? raw.meta)
  if (view === null) return null
  const op = view.op
  if (typeof op !== 'string') return null
  if (HTML_OPS.includes(op)) {
    const { id, version, revision, html, title, applied, truncated, unchanged, interactive } = view
    if (typeof id !== 'string') return null
    // A PATCH is the one op that may legitimately arrive with no source: its
    // meta carries the cause (bytes + fingerprint) and the fold reproduces it
    // from the tool call's arguments. Requiring html here would DROP every patch
    // card from the client timeline — the artifact would appear to stop
    // updating entirely.
    if (op !== 'patch' && typeof html !== 'string') return null
    if (typeof version !== 'number' && typeof revision !== 'number') return null
    return {
      view: {
        card: 'artifact', op: op as HtmlArtifactOp, id,
        ...typeof html === 'string' ? { html } : {},
        ...typeof version === 'number' ? { version } : {},
        ...typeof revision === 'number' ? { revision } : {},
        ...typeof title === 'string' ? { title } : {},
        ...typeof applied === 'number' ? { applied } : {},
        ...typeof truncated === 'boolean' ? { truncated } : {},
        ...typeof unchanged === 'boolean' ? { unchanged } : {},
        ...typeof interactive === 'boolean' ? { interactive } : {},
      },
    }
  }
  if (op === 'interactive') {
    const { id, version, interactive, title } = view
    if (typeof id !== 'string' || typeof interactive !== 'boolean') return null
    return {
      view: {
        card: 'artifact', op: 'interactive', id, interactive,
        ...typeof version === 'number' ? { version } : {},
        ...typeof title === 'string' ? { title } : {},
      },
    }
  }
  if (op === 'destroy') {
    if (typeof view.id !== 'string') return null
    return { view: { card: 'artifact', op: 'destroy', id: view.id } }
  }
  if (op === 'list') {
    if (!Array.isArray(view.artifacts)) return null
    const artifacts: ArtifactSummaryView[] = []
    for (const entry of view.artifacts) {
      const record = asRecord(entry)
      if (record === null) return null
      const { id, version, revision, bytes, title } = record
      if (typeof id !== 'string' || typeof bytes !== 'number') return null
      if (typeof version !== 'number' && typeof revision !== 'number') return null
      artifacts.push({
        id, bytes,
        ...typeof version === 'number' ? { version } : {},
        ...typeof revision === 'number' ? { revision } : {},
        ...typeof title === 'string' ? { title } : {},
      })
    }
    return { view: { card: 'artifact', op: 'list', artifacts } }
  }
  return null
}

/** The parsed model-facing arguments of one artifact call. */
export interface ArtifactArgs {
  op: string
  id?: string
  title?: string
  html?: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
  version?: number
}

/**
 * Parse the model-facing arguments off a running or settled node. The wire
 * args are a JSON string; malformed JSON yields undefined (the generic path).
 * @param block - running or settled tool node.
 * @returns the parsed args, or undefined when unparseable.
 */
export function artifactArgs(block: ToolCallBlock): ArtifactArgs | undefined {
  const argsRaw = 'kind' in block ? (block.call?.argsRaw ?? '') : block.argsRaw
  if (typeof argsRaw !== 'string' || argsRaw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return undefined
  }
  const record = asRecord(parsed)
  if (record === null || typeof record.op !== 'string') return undefined
  return {
    op: record.op,
    ...typeof record.id === 'string' ? { id: record.id } : {},
    ...typeof record.title === 'string' ? { title: record.title } : {},
    ...typeof record.html === 'string' ? { html: record.html } : {},
    ...typeof record.old_string === 'string' ? { oldString: record.old_string } : {},
    ...typeof record.new_string === 'string' ? { newString: record.new_string } : {},
    ...typeof record.replace_all === 'boolean' ? { replaceAll: record.replace_all } : {},
    ...typeof record.version === 'number' ? { version: record.version } : {},
  }
}
