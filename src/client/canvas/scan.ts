/**
 * Conversation-timeline scan for artifact state: the settled tool-result
 * nodes of the current session snapshot each carry the full HTML of their op
 * (create/patch/save/revert/read all project it through presentationMeta), so
 * the canvas panel can rebuild every artifact's version history from the log
 * alone — no host round-trip, survives restarts, no extra wire traffic. Pure
 * functions, directly unit-testable.
 * @module
 */
import type { ArtifactCardView, HtmlArtifactOp } from '../contract.ts'
import { artifactCardModel, cardVersion } from '../contract.ts'

/** One settled artifact op found in the timeline. */
export interface ArtifactEntry {
  /** Timeline seq of the `tool-result` node (monotonic conversation order). */
  seq: number
  /** Node time (epoch ms). */
  time: number
  /** The originating call id, when the node carries one. */
  callId: string | undefined
  op: ArtifactCardView['op']
  id: string
  /** Saved version number when the card carries one (`version`/legacy). */
  version: number | undefined
  html: string | undefined
  title: string | undefined
  /** Interaction-data expectation, when the card declares one. */
  interactive: boolean | undefined
  isError: boolean
}

/**
 * Scan a conversation snapshot's nodes for settled artifact cards.
 * @param nodes - the snapshot's `nodes` array (conversation order).
 * @returns the artifact entries in timeline order.
 */
/**
 * The newest persist dir a `list` card carried (the server writes it when
 * disk persistence is on), or undefined — the canvas's 编辑器 button uses it
 * to open the viewed artifact's on-disk file in the sidebar's editor.
 * @param nodes - the snapshot's `nodes` array.
 * @returns the dir, or undefined.
 */
export function scanPersistDir(nodes: readonly unknown[]): string | undefined {
  let dir: string | undefined
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    const record = node as Record<string, unknown>
    if (record.kind !== 'tool-result') continue
    // `resultView` is the legacy host shape; current hosts deliver the raw
    // `presentationMeta` payload on `meta` with no `card` tag, so discriminate
    // on `op` alone.
    const view = record.resultView ?? record.meta
    if (view === null || typeof view !== 'object') continue
    const candidate = view as Record<string, unknown>
    if (candidate.op !== 'list') continue
    if (typeof candidate.dir === 'string' && candidate.dir !== '') dir = candidate.dir
  }
  return dir
}

export function scanArtifactEntries(nodes: readonly unknown[]): ArtifactEntry[] {
  const entries: ArtifactEntry[] = []
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    const record = node as Record<string, unknown>
    if (record.kind !== 'tool-result') continue
    const model = artifactCardModel(node as never)
    if (model === null) continue
    const view = model.view
    // `list` cards carry no single artifact id — nothing for the panel,
    // but their persist dir (when the server wrote one) is remembered.
    if (view.op === 'list') continue
    const htmlOp = view.op !== 'destroy' ? view as Extract<ArtifactCardView, { html: string }> : undefined
    entries.push({
      seq: typeof record.seq === 'number' ? record.seq : 0,
      time: typeof record.time === 'number' ? record.time : 0,
      callId: typeof record.callId === 'string' ? record.callId : undefined,
      op: view.op,
      id: view.id,
      version: htmlOp === undefined ? undefined : cardVersion(htmlOp),
      html: htmlOp?.html,
      title: htmlOp?.title,
      interactive: 'interactive' in view && typeof view.interactive === 'boolean' ? view.interactive : undefined,
      isError: record.isError === true,
    })
  }
  return entries
}

/** One saved checkpoint in an artifact's reconstructed history. */
export interface ArtifactCheckpoint {
  /** Version number (1 = initial create; ascending). */
  version: number
  /** The saved source. */
  html: string
  /** Title carried by the checkpointing card, when any. */
  title: string | undefined
  /** Timeline seq of the checkpointing node. */
  seq: number
  /** Checkpoint time (epoch ms). */
  time: number
}

/** The reconstructed history of one artifact id. */
export interface ArtifactTimeline {
  id: string
  title: string | undefined
  /** Whether interaction data is expected (latest declaration wins). */
  interactive: boolean | undefined
  /** Saved checkpoints, ascending by version (create = 版本 1). */
  checkpoints: ArtifactCheckpoint[]
  /** The latest known source (working copy incl. unsaved patches). */
  workingHtml: string | undefined
  /** True when patches followed the newest checkpoint (unsaved edits exist). */
  workingDirty: boolean
  /** True once a `destroy` entry was seen for this id. */
  destroyed: boolean
  /** Seq of the last entry for this id. */
  lastSeq: number
  /** Time of the last entry for this id. */
  lastTime: number
}

const CHECKPOINT_OPS: readonly string[] = ['create', 'save']

/**
 * Saved versions the server keeps per artifact. MUST match `MAX_VERSIONS` in
 * src/registry.ts — the server trims its version list on `save`, and the client
 * rebuilds the same list from the log, which is never trimmed. Without this cap
 * the two disagree: the canvas would list a version the server already shifted
 * away, and 回退 to it fails with UnknownVersionError.
 *
 * A cross-check test (tests/scan-cap.spec.ts) fails if the two constants drift,
 * because this is a silent-divergence bug class — nothing at runtime detects
 * it until a user reverts to a version that no longer exists.
 */
export const MAX_CLIENT_VERSIONS = 20

/**
 * Build per-artifact histories from timeline entries.
 * @param entries - scanned entries in timeline order.
 * @returns timelines keyed by artifact id (insertion order = first appearance).
 */
export function buildTimelines(entries: readonly ArtifactEntry[]): Map<string, ArtifactTimeline> {
  const timelines = new Map<string, ArtifactTimeline>()
  for (const entry of entries) {
    let timeline = timelines.get(entry.id)
    if (timeline === undefined) {
      timeline = {
        id: entry.id,
        title: undefined,
        interactive: undefined,
        checkpoints: [],
        workingHtml: undefined,
        workingDirty: false,
        destroyed: false,
        lastSeq: entry.seq,
        lastTime: entry.time,
      }
      timelines.set(entry.id, timeline)
    }
    timeline.lastSeq = Math.max(timeline.lastSeq, entry.seq)
    timeline.lastTime = Math.max(timeline.lastTime, entry.time)
    if (entry.title !== undefined) timeline.title = entry.title
    if (entry.interactive !== undefined) timeline.interactive = entry.interactive
    if (entry.html !== undefined) timeline.workingHtml = entry.html
    if (entry.op === 'destroy') timeline.destroyed = true
    if (entry.isError) continue
    if (CHECKPOINT_OPS.includes(entry.op) && entry.html !== undefined && !timeline.destroyed) {
      const previous = timeline.checkpoints[timeline.checkpoints.length - 1]
      // Legacy sessions numbered every patch via `revision`; only trust the
      // explicit numbering when it moves forward, else derive it.
      const version = entry.version !== undefined && (previous === undefined || entry.version > previous.version)
        ? entry.version
        : (previous?.version ?? 0) + 1
      timeline.checkpoints.push({ version, html: entry.html, title: entry.title, seq: entry.seq, time: entry.time })
      timeline.workingDirty = false
      // Mirror the server's trim so both sides expose the same version set.
      while (timeline.checkpoints.length > MAX_CLIENT_VERSIONS) timeline.checkpoints.shift()
    } else if (entry.op === 'revert' && entry.html !== undefined) {
      // A revert resets the working copy without creating a version; whether
      // it is "dirty" depends on where it landed relative to the checkpoints.
      const target = timeline.checkpoints.find(checkpoint => checkpoint.version === entry.version)
      if (target !== undefined) {
        timeline.workingDirty = target.html !== entry.html
      } else if (entry.version !== undefined && entry.version >= 1) {
        // FORKED SESSIONS only carry a TAIL of the history: the
        // create/save ops that produced the revert's target version are
        // missing from this log. The revert card still ships the COMPLETE
        // saved source of that version, so synthesize the checkpoint —
        // without it the canvas would badge the newest version as
        // "未保存" while the working copy is in fact an exact save.
        timeline.checkpoints.push({ version: entry.version, html: entry.html, title: entry.title, seq: entry.seq, time: entry.time })
        timeline.checkpoints.sort((a, b) => a.version - b.version)
        while (timeline.checkpoints.length > MAX_CLIENT_VERSIONS) timeline.checkpoints.shift()
        timeline.workingDirty = false
      } else {
        timeline.workingDirty = true
      }
    } else if (entry.op === 'patch' && entry.html !== undefined) {
      timeline.workingDirty = true
    }
  }
  return timelines
}
/**
 * Index of the checkpoint that IS the current state: after a revert the
 * working copy equals some OLDER checkpoint — that one is "current" (the
 * later saves still exist on disk, but nothing is being viewed "from the
 * future"). Falls back to the newest checkpoint when the working copy is
 * dirty (unsaved patches) or no checkpoint matches.
 */
export function currentCheckpointIndex(timeline: ArtifactTimeline): number {
  const count = timeline.checkpoints.length
  if (count === 0) return -1
  if (!timeline.workingDirty && timeline.workingHtml !== undefined) {
    const idx = timeline.checkpoints.findIndex(checkpoint => checkpoint.html === timeline.workingHtml)
    if (idx >= 0) return idx
  }
  return count - 1
}
