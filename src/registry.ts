/**
 * Pure artifact store and patch engine for the `artifact` tool. Kept free of
 * harness imports so the semantics (replace counting, byte caps, truncation,
 * id generation, explicit versioning) are directly unit-testable and
 * replay-safe: the tool's presentationMeta carries the FULL html on every
 * mutation op, so the GUI and session log never depend on this in-memory
 * state surviving.
 *
 * VERSIONING MODEL (explicit, model-driven):
 * - `create` stores the initial source as 版本 1.
 * - `patch` mutates the WORKING COPY and never bumps any version.
 * - `save` snapshots the current working copy as the next version (skipped
 *   when identical to the newest saved version).
 * - `revertTo` resets the working copy to a previously saved version's
 *   content without touching the version list.
 * @module
 */

/** One saved version of an artifact (ascending by `version`). */
export interface ArtifactVersion {
  /** Monotonic version number; 1 = the initial create. */
  version: number
  /** The saved HTML source. */
  html: string
  /** Epoch ms when this version was saved. */
  time: number
}

/** One live HTML artifact owned by a session. */
export interface ArtifactState {
  /** The artifact's current (working-copy) HTML source. */
  html: string
  /** The newest SAVED version number (the working copy may be ahead of it). */
  version: number
  /** Optional display title the model chose at create time. */
  title?: string
  /** Whether the model expects user interaction data for this artifact
   *  (drives the canvas's 提交交互 button). Undefined = not declared. */
  interactive?: boolean
}

interface InternalState {
  html: string
  title?: string
  interactive?: boolean
  versions: ArtifactVersion[]
  /** Soft-deleted via the destroy op: invisible to the model, kept on disk. */
  deleted?: boolean
  /** Set when this artifact was imported from another session (provenance for
   *  the canvas badge and for `library`/`read`). Absent = created here. */
  origin?: { sessionId: string; artifactId: string }
}

/** One listable artifact summary, as the `list` op reports it. */
export interface ArtifactSummary {
  id: string
  version: number
  bytes: number
  title?: string
  /** Present when this artifact was imported from another session. */
  origin?: { sessionId: string; artifactId: string }
}


/** Result of applying a patch to an artifact. */
export interface PatchResult {
  /** The updated artifact state (version unchanged). */
  state: ArtifactState
  /** How many occurrences the replacement matched. */
  count: number
}

/** Result of one `save` op. */
export interface SaveResult {
  /** The post-save state (`version` = the saved version number). */
  state: ArtifactState
  /** True when the working copy already matched the newest saved version. */
  unchanged: boolean
}

export const MAX_VERSIONS = 20

import { contentHash, replaceOccurrences, type PatchArgs } from './patch.ts'

/**
 * Literal patch application. The implementation lives in `./patch.ts` because
 * the CLIENT's timeline fold needs the identical algorithm — one copy, so the
 * two sides cannot drift apart.
 */
export { replaceOccurrences, type ReplaceOutcome } from './patch.ts'

/**
 * Truncate an HTML source to a UTF-8 byte cap without splitting a character.
 * @param html - the source to cap.
 * @param maxBytes - the cap in UTF-8 bytes.
 * @returns the (possibly truncated) source and whether it was cut.
 */
export function truncateHtml(html: string, maxBytes: number): { html: string; truncated: boolean } {
  if (new TextEncoder().encode(html).byteLength <= maxBytes) return { html, truncated: false }
  let low = 0
  let high = html.length
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (new TextEncoder().encode(html.slice(0, mid)).byteLength <= maxBytes) low = mid
    else high = mid - 1
  }
  return { html: html.slice(0, low), truncated: true }
}

function byteLength(html: string): number {
  return new TextEncoder().encode(html).byteLength
}

/** Error thrown when a patch's old_string is not present in the artifact. */
export class PatchNotFoundError extends Error {
  constructor(public readonly id: string, public readonly snippet: string) {
    super(`artifact ${id}: old_string not found${snippet === '' ? '' : ` (near ${JSON.stringify(snippet.slice(0, 60))})`}`)
    this.name = 'PatchNotFoundError'
  }
}

/** Error thrown when a patch would leave the artifact unchanged. */
export class NoChangeError extends Error {
  constructor(public readonly id: string) {
    super(`artifact ${id}: old_string equals new_string — nothing to change`)
    this.name = 'NoChangeError'
  }
}

/** Error thrown when a mutation would exceed the configured byte cap. */
export class ArtifactTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`artifact source exceeds the ${maxBytes}-byte cap; remove or shrink content first`)
    this.name = 'ArtifactTooLargeError'
  }
}

/** Error thrown when an op names an artifact this session does not own. */
export class ArtifactNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`artifact ${id} not found in this session's store (create it first, or list). If it was created before a fork/restart, recovery runs from the session log on the next op — retry once; if it still fails, the history predates this session and it must be recreated.`)
    this.name = 'ArtifactNotFoundError'
  }
}

/** Error thrown when a revert names a version that was never saved. */
export class UnknownVersionError extends Error {
  constructor(public readonly id: string, public readonly version: number) {
    super(`artifact ${id}: no saved 版本 ${version}`)
    this.name = 'UnknownVersionError'
  }
}

/** The subset of a tool-result meta this store can rebuild from. */
export interface ArtifactMetaLike {
  op: string
  id: string
  version?: number
  html?: string
  title?: string
  applied?: number
  truncated?: boolean
  interactive?: boolean
  /**
   * For `patch`: the arguments that PRODUCED this state, so a log that does not
   * carry the resulting source can still be replayed. See {@link contentHash}
   * for the check that keeps this honest.
   */
  patch?: PatchArgs
  /** For `patch`: fingerprint of the resulting working copy, for verification. */
  hash?: string
}

/**
 * Rebuild artifact states from the session's artifact presentation metas, in
 * log order — the server-side mirror of the GUI's timeline scan. `read` metas
 * carry possibly-truncated source and are skipped for the working copy when
 * marked truncated (never trust a capped read as the full source).
 * @param metas - artifact metas in log order.
 * @returns reconstructed states keyed by artifact id.
 */
export function rebuildFromMetas(metas: readonly ArtifactMetaLike[]): Map<string, {
  html: string
  title?: string
  interactive?: boolean
  deleted?: boolean
  versions: ArtifactVersion[]
  /**
   * Set when a patch could NOT be reproduced from its arguments (or reproduced
   * to something the recorded fingerprint disagrees with). A diverged snapshot
   * must NOT be adopted over a good store/disk copy — it is a best-effort
   * reconstruction, not the truth.
   */
  diverged?: boolean
}> {
  const states = new Map<string, { html: string; title?: string; interactive?: boolean; deleted?: boolean; versions: ArtifactVersion[]; diverged?: boolean }>()
  for (const meta of metas) {
    if (typeof meta.id !== 'string' || meta.id === '') continue
    let state = states.get(meta.id)
    if (meta.op === 'create' && typeof meta.html === 'string') {
      state = {
        html: meta.html,
        ...meta.title === undefined ? {} : { title: meta.title },
        ...meta.interactive === undefined ? {} : { interactive: meta.interactive },
        versions: [{ version: 1, html: meta.html, time: 0 }],
      }
      states.set(meta.id, state)
      continue
    }
    if (state === undefined) {
      // NO create meta in the log (fork seed cut before it, or the create
      // result never carried one — e.g. the schema-rejected era): bootstrap
      // from the first html-bearing meta, which is itself a COMPLETE source
      // snapshot (patch/save metas carry the full post-op html).
      if (typeof meta.html !== 'string') continue
      if (meta.op === 'read' && meta.truncated === true) continue
      state = {
        html: meta.html,
        ...meta.title === undefined ? {} : { title: meta.title },
        ...meta.interactive === undefined ? {} : { interactive: meta.interactive },
        versions: [{ version: meta.version ?? 1, html: meta.html, time: 0 }],
      }
      states.set(meta.id, state)
      continue
    }
    if (meta.title !== undefined) state.title = meta.title
    if (meta.interactive !== undefined) state.interactive = meta.interactive
    if (meta.op === 'interactive') continue
    if (meta.op === 'destroy') {
      // The log keeps the destroy and we replay it the same way — the recovery
      // target is still a soft-deleted artifact.
      state.deleted = true
      continue
    }
    // A PATCH may arrive with only its arguments and a fingerprint: the log no
    // longer stores a full copy of the post-patch working copy (measured at
    // 7.87 MB of one real 29.49 MB log, while the same patches' arguments were
    // 0.16 MB). Reproduce the effect from the cause.
    if (meta.op === 'patch' && typeof meta.html !== 'string') {
      if (meta.patch === undefined) {
        // Nothing to replay from (a truncated/foreign meta). Leave the working
        // copy as the last known state and flag it, rather than inventing one.
        state.diverged = true
        continue
      }
      const outcome = replaceOccurrences(state.html, meta.patch.oldString, meta.patch.newString, meta.patch.replaceAll)
      if (outcome.count === 0) {
        // A successful patch always changed something (a zero-count patch throws
        // PatchNotFoundError and is logged as an error, not as this meta). So a
        // zero count means OUR working copy is not the one the patch applied to.
        state.diverged = true
        continue
      }
      state.html = outcome.html
      if (meta.hash !== undefined && contentHash(state.html) !== meta.hash) {
        // Fingerprint disagreement: the reconstruction is not what the tool
        // produced. Keep it (it is still the best available) but mark it so a
        // caller with real bytes prefers those.
        state.diverged = true
      }
      continue
    }
    if (typeof meta.html !== 'string') continue
    if (meta.op === 'read' && meta.truncated === true) continue
    state.html = meta.html
    if (meta.op === 'revert') {
      // FORKED SESSIONS only carry a TAIL of the history: the create/save
      // metas that produced the revert's TARGET version may all be missing.
      // The revert meta ships that version's complete saved source, so
      // re-materialize the version entry — otherwise a later revert/save in
      // this session would either fail (版本不存在) or renumber wrongly.
      if (typeof meta.version === 'number' && !state.versions.some(v => v.version === meta.version)) {
        state.versions.push({ version: meta.version, html: meta.html, time: 0 })
        state.versions.sort((a, b) => a.version - b.version)
        while (state.versions.length > MAX_VERSIONS) state.versions.shift()
      }
    }
    if (meta.op === 'save') {
      const latest = state.versions[state.versions.length - 1]
      if (latest === undefined || latest.html !== meta.html) {
        state.versions.push({ version: meta.version ?? (latest?.version ?? 0) + 1, html: meta.html, time: 0 })
        while (state.versions.length > MAX_VERSIONS) state.versions.shift()
      }
    }
  }
  return states
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Generate a fresh artifact id not present in `existing`. */
export function makeArtifactId(existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let id = 'art-'
    for (let i = 0; i < 6; i++) {
      id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
    }
    if (!existing.has(id)) return id
  }
  throw new Error('artifact: could not allocate a unique id')
}

import type { ArtifactPersistence } from './persistence.ts'

/** The per-session artifact registry. One instance per owning agent; the tool
 *  plugin keys a WeakMap by the executing Agent. An optional {@link ArtifactPersistence}
 *  write-through keeps `~/.dsh/artifacts/<sessionId>/` in sync with every
 *  mutation, so server restarts and log pruning never lose the artifacts. */
export class ArtifactStore {
  private readonly states = new Map<string, InternalState>()

  constructor(private readonly persistence?: ArtifactPersistence) {}

  /**
   * Create an artifact with an initial source, saved as 版本 1.
   * @param html - the initial HTML source (may be empty).
   * @param title - optional display title.
   * @param maxBytes - byte cap on the stored source.
   * @returns the new artifact's id.
   */
  create(html: string, title: string | undefined, maxBytes: number, interactive?: boolean): string {
    if (byteLength(html) > maxBytes) throw new ArtifactTooLargeError(maxBytes)
    const id = makeArtifactId(new Set(this.states.keys()))
    const versions = [{ version: 1, html, time: Date.now() }]
    this.states.set(id, {
      html,
      ...title === undefined ? {} : { title },
      ...interactive === undefined ? {} : { interactive },
      versions,
    })
    this.writeCreated(id, versions)
    return id
  }

  /**
   * Toggle whether user interaction data is expected for this artifact
   * (drives the canvas's 提交交互 button). Only the manifest changes.
   * @param id - the artifact.
   * @param value - true = show the submit-interaction affordance.
   * @returns the updated state.
   */
  setInteractive(id: string, value: boolean): ArtifactState {
    const internal = this.internal(id)
    internal.interactive = value
    this.writeMetadata(id)
    return this.stateOf(internal)
  }

  /**
   * Apply one string replacement to the artifact's WORKING COPY. No version
   * is created — call {@link save} to snapshot the result.
   * @param id - the artifact to patch.
   * @param oldString - exact substring to find (non-empty).
   * @param newString - replacement text.
   * @param replaceAll - replace every occurrence instead of the first.
   * @param maxBytes - byte cap on the stored source.
   * @returns the updated state and match count.
   */
  patch(id: string, oldString: string, newString: string, replaceAll: boolean, maxBytes: number): PatchResult {
    const internal = this.internal(id)
    if (oldString === newString) throw new NoChangeError(id)
    const outcome = replaceOccurrences(internal.html, oldString, newString, replaceAll)
    if (outcome.count === 0) {
      const index = internal.html.indexOf(oldString.slice(0, 1))
      const snippet = index === -1 ? '' : internal.html.slice(Math.max(0, index - 40), index + 80)
      throw new PatchNotFoundError(id, snippet)
    }
    if (byteLength(outcome.html) > maxBytes) throw new ArtifactTooLargeError(maxBytes)
    internal.html = outcome.html
    this.writeWorkingCopy(id)
    return { state: this.stateOf(internal), count: outcome.count }
  }

  /**
   * Snapshot the current working copy as the next version. A save whose
   * content already equals the newest saved version is reported `unchanged`
   * and does not push a duplicate entry.
   * @param id - the artifact to save.
   * @returns the post-save state and whether it was a no-op.
   */
  save(id: string): SaveResult {
    const internal = this.internal(id)
    const latest = internal.versions[internal.versions.length - 1]
    if (latest !== undefined && latest.html === internal.html) {
      return { state: this.stateOf(internal), unchanged: true }
    }
    internal.versions.push({ version: latest === undefined ? 1 : latest.version + 1, html: internal.html, time: Date.now() })
    while (internal.versions.length > MAX_VERSIONS) internal.versions.shift()
    // A save freezes exactly ONE new version: write that file plus the manifest,
    // not the whole history. Rewriting every version file was pure waste on the
    // common path and got slower as the history grew.
    const written = internal.versions[internal.versions.length - 1]
    /* c8 ignore next -- `written` exists: we just pushed it. */
    if (written !== undefined) this.writeVersion(id, written)
    this.writeManifest(id)
    return { state: this.stateOf(internal), unchanged: false }
  }

  /**
   * Reset the working copy to one saved version's content. The version list
   * itself is untouched; later saves continue from the highest number.
   * @param id - the artifact to revert.
   * @param version - the saved version to restore.
   * @returns the post-revert state.
   */
  revertTo(id: string, version: number): ArtifactState {
    const internal = this.internal(id)
    const target = internal.versions.find(entry => entry.version === version)
    if (target === undefined) throw new UnknownVersionError(id, version)
    internal.html = target.html
    this.writeWorkingCopy(id)
    return this.stateOf(internal)
  }

  /** The saved-version history of one artifact, ascending by version. */
  versionsOf(id: string): readonly ArtifactVersion[] {
    return [...this.internal(id).versions]
  }

  /**
   * Whether this store currently holds the artifact AT ALL — including a
   * soft-deleted one.
   *
   * DELIBERATELY differs from "is live". The log-replay and disk-restore paths
   * used to guard on this predicate to decide whether an artifact needed
   * rebuilding, while `deleted` artifacts were reported as absent. Since a
   * destroyed artifact is restored with `deleted: true` and then still reports
   * absent, every replay restored it again and wrote its files to disk again —
   * an unbounded loop of redundant work. Rebuild guards must ask "do I already
   * have this?", and the answer for a tombstone is yes; asking "is it visible?"
   * is {@link isLive}.
   */
  has(id: string): boolean {
    return this.states.has(id)
  }

  /** Whether the artifact exists AND is visible to the model and the canvas. */
  isLive(id: string): boolean {
    const state = this.states.get(id)
    return state !== undefined && state.deleted !== true
  }

  /** How many artifacts this store holds, tombstones included. Lets the caller
   *  tell "already replayed into a populated store" from "replay produced
   *  nothing", which decides whether a full log walk can be skipped. */
  size(): number {
    return this.states.size
  }

  /**
   * Fold a snapshot reconstructed from the session log into this store,
   * keeping whichever side is NEWER.
   *
   * Why this exists (the stale-patch bug): boot restores artifacts from the
   * disk cache, then log replay used to skip any id the store already had —
   * `if (!store.has(id)) store.restore(...)`. The disk cache is written on
   * mutation, so it can lag the log, and the log always wins on content: every
   * artifact op projects its FULL html into the log. Skipping meant a session
   * reopened after an unsaved patch kept editing the pre-patch html — the next
   * patch matched stale text (wrong replacement, or PatchNotFoundError).
   *
   * The log is authoritative because a session log is append-only and durable;
   * the disk directory is a derived cache (it exists so artifacts survive log
   * loss, not to be the source of truth). The one case where the disk is kept
   * is a log that carries FEWER versions than the store, which means the log
   * is partial rather than newer — then adopting it would lose history.
   * @param id - the artifact id.
   * @param snapshot - the log-derived state.
   * @returns whether the store adopted the incoming snapshot.
   */
  adoptReplay(id: string, snapshot: { html: string; title?: string; interactive?: boolean; deleted?: boolean; origin?: { sessionId: string; artifactId: string }; versions: ArtifactVersion[]; diverged?: boolean }): boolean {
    // A DIVERGED reconstruction is best-effort, not truth: its patches could not
    // be reproduced from their arguments. It may still be the only copy (a fresh
    // process with an empty store), so it is adopted then — but it must never
    // overwrite content we already hold from the disk cache or live edits.
    if (snapshot.diverged === true && this.states.has(id)) return false
    const existing = this.states.get(id)
    if (existing === undefined) {
      this.restore(id, snapshot)
      return true
    }
    const have = existing.versions[existing.versions.length - 1]?.version ?? 0
    const incoming = snapshot.versions[snapshot.versions.length - 1]?.version ?? 0
    // The log is behind the disk cache: a partial/pruned log must not erase
    // history the cache still holds.
    if (incoming < have) return false
    if (
      incoming === have
      && existing.html === snapshot.html
      && (existing.deleted === true) === (snapshot.deleted === true)
      && existing.origin?.artifactId === snapshot.origin?.artifactId
      && existing.origin?.sessionId === snapshot.origin?.sessionId
    ) {
      return false
    }
    // Equal version numbers with different html is the interesting case: a
    // `patch` does not bump any version, so the log carrying different content
    // at the same version means it holds a later unsaved patch.
    this.restore(id, snapshot)
    return true
  }

  /**
   * Import a snapshot as a NEW artifact in this store, preserving its version
   * history and recording where it came from.
   *
   * ONE-WAY COPY: the caller passes a snapshot it read from elsewhere; this
   * method never reads or writes another session's directory. Importing into
   * the CURRENT session is the whole point — the source session's canvas is
   * never modified, which is the safety property this feature rests on.
   *
   * The imported artifact takes a FRESH id from this store's namespace: ids are
   * only unique within a session's own directory, so reusing the source id
   * could collide with an artifact this session already has. Version numbers
   * are re-based to be contiguous from 1, because the server indexes versions by
   * number and `revertTo` looks them up by it — a history with gaps would be
   * navigable in the canvas but unusable by the model.
   * @param snapshot - the source state (working copy + saved versions).
   * @param maxBytes - byte cap on the stored source.
   * @param options.includeVersions - false carries the working copy only.
   * @returns the new artifact's id and how many versions it now holds.
   */
  importArtifact(snapshot: {
    html: string
    title?: string
    interactive?: boolean
    versions: readonly ArtifactVersion[]
    origin?: { sessionId: string; artifactId: string }
  }, maxBytes: number, options: { includeVersions?: boolean } = {}): { id: string; versions: number } {
    if (byteLength(snapshot.html) > maxBytes) throw new ArtifactTooLargeError(maxBytes)
    const id = makeArtifactId(new Set(this.states.keys()))
    const source = options.includeVersions === false
      ? []
      : [...snapshot.versions].sort((a, b) => a.version - b.version)
    const versions: ArtifactVersion[] = source.map((entry, index) => ({
      version: index + 1,
      html: entry.html,
      time: entry.time,
    }))
    const latest = versions[versions.length - 1]
    if (latest === undefined || latest.html !== snapshot.html) {
      // The working copy is ahead of (or unrelated to) the newest saved
      // version — that is precisely the "unsaved edits" state, so no extra
      // version is invented; the working-copy bytes are stored as they are.
      versions.push({ version: versions.length + 1, html: snapshot.html, time: Date.now() })
    }
    while (versions.length > MAX_VERSIONS) versions.shift()
    this.states.set(id, {
      html: snapshot.html,
      ...snapshot.title === undefined ? {} : { title: snapshot.title },
      ...snapshot.interactive === undefined ? {} : { interactive: snapshot.interactive },
      ...snapshot.origin === undefined ? {} : { origin: snapshot.origin },
      versions,
    })
    this.writeCreated(id, versions)
    return { id, versions: versions.length }
  }

  /** Where an artifact was imported from, if it was. */
  originOf(id: string): { sessionId: string; artifactId: string } | undefined {
    return this.internal(id).origin
  }

  /**
   * Restore an artifact reconstructed from the durable session log or from the
   * disk cache (server restarts lose the in-memory store; the log is the
   * source of truth).
   *
   * WRITES NOTHING TO DISK: restoring is not a mutation, and the caller already
   * holds whatever bytes this snapshot came from. The previous version ended in
   * a full `persist()`, so merely OPENING an old session rewrote every artifact
   * in it — twice, once for the disk-first boot and again for each log-replayed
   * artifact. State is adopted verbatim, tombstones included.
   * @param id - the artifact id.
   * @param snapshot - the reconstructed state (html/title/interactive/versions).
   */
  restore(id: string, snapshot: { html: string; title?: string; interactive?: boolean; deleted?: boolean; origin?: { sessionId: string; artifactId: string }; versions: ArtifactVersion[] }): void {
    this.states.set(id, {
      html: snapshot.html,
      ...snapshot.title === undefined ? {} : { title: snapshot.title },
      ...snapshot.interactive === undefined ? {} : { interactive: snapshot.interactive },
      ...snapshot.deleted === true ? { deleted: true } : {},
      ...snapshot.origin === undefined ? {} : { origin: snapshot.origin },
      versions: [...snapshot.versions],
    })
  }

  /**
   * Read an artifact's current (working-copy) state.
   * @param id - the artifact to read.
   * @returns the state.
   */
  get(id: string): ArtifactState {
    return this.stateOf(this.internal(id))
  }

  /**
   * Remove an artifact.
   * @param id - the artifact to destroy.
   */
  destroy(id: string): void {
    const internal = this.internal(id)
    internal.deleted = true
    // SOFT DELETE: files and persisted data STAY — recovery is possible
    // (rebuildFromMetas replays the destroy meta to this same flag). Only the
    // manifest records the tombstone; the bodies are untouched.
    this.writeMetadata(id)
  }

  /** Summaries of every visible artifact in this store, in creation order. */
  list(): ArtifactSummary[] {
    return [...this.states.entries()].filter(([, state]) => state.deleted !== true).map(([id, state]) => ({
      id,
      version: state.versions[state.versions.length - 1]?.version ?? 1,
      bytes: byteLength(state.html),
      ...state.title === undefined ? {} : { title: state.title },
      ...state.origin === undefined ? {} : { origin: state.origin },
    }))
  }

  /**
   * The exact juggling the persister is allowed to do. Each method writes the
   * MINIMUM needed by its operation, because every extra `writeFileSync` is
   * paid on the tool's hot path:
   *  - `writeCreated`  — one version file + manifest (a fresh id has no other
   *    files to touch);
   *  - `writeWorkingCopy` — the working copy only;
   *  - `writeVersion`  — one frozen version file;
   *  - `writeMetadata` — the manifest only.
   */
  private persistenceApi(): NonNullable<ArtifactStore['persistence']> | undefined {
    return this.persistence
  }

  private writeCreated(id: string, versions: readonly ArtifactVersion[]): void {
    const internal = this.states.get(id)
    const api = this.persistenceApi()
    if (internal === undefined || api === undefined) return
    // All three: a fresh artifact has no working copy on disk yet, and
    // `loadAll` reads `<id>.html` unconditionally — omit it and the artifact
    // becomes invisible to the next boot even though its manifest is there.
    api.writeWorkingCopy(id, internal.html)
    for (const entry of versions) api.writeVersion(id, entry)
    this.writeManifest(id)
  }

  private writeWorkingCopy(id: string): void {
    const internal = this.states.get(id)
    const api = this.persistenceApi()
    if (internal === undefined || api === undefined) return
    api.writeWorkingCopy(id, internal.html)
  }

  private writeVersion(id: string, version: ArtifactVersion): void {
    this.persistenceApi()?.writeVersion(id, version)
  }

  private writeMetadata(id: string): void {
    this.writeManifest(id)
  }

  /** The manifest is the artifact's full metadata (never its bodies). Byte
   *  lengths are recorded because that is what a listing shows, and they are
   *  known here without reading anything back from disk. */
  private writeManifest(id: string): void {
    const internal = this.states.get(id)
    const api = this.persistenceApi()
    if (internal === undefined || api === undefined) return
    api.writeManifest({
      id,
      ...internal.title === undefined ? {} : { title: internal.title },
      ...internal.interactive === undefined ? {} : { interactive: internal.interactive },
      ...internal.deleted === true ? { deleted: true } : {},
      ...internal.origin === undefined ? {} : { origin: internal.origin },
      bytes: byteLength(internal.html),
      versions: internal.versions.map(entry => ({ version: entry.version, time: entry.time, bytes: byteLength(entry.html) })),
    })
  }

  private internal(id: string): InternalState {
    const internal = this.states.get(id)
    if (internal === undefined || internal.deleted === true) throw new ArtifactNotFoundError(id)
    return internal
  }

  private stateOf(internal: InternalState): ArtifactState {
    return {
      html: internal.html,
      version: internal.versions[internal.versions.length - 1]?.version ?? 1,
      ...internal.title === undefined ? {} : { title: internal.title },
      ...internal.interactive === undefined ? {} : { interactive: internal.interactive },
    }
  }
}
