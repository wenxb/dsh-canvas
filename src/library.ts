/**
 * The cross-session artifact LIBRARY: read-only discovery of every artifact
 * this plugin has persisted under the artifacts root, grouped by session.
 *
 * WHY THIS IS SAFE BY CONSTRUCTION: it only ever CALLS `loadAll()` per session
 * directory, which reads files. Nothing here writes, moves or deletes — the
 * import path that consumes this data copies INTO the current session and never
 * touches the source. Cross-session writes are the one thing this feature must
 * never do, so the read surface is kept separate from the mutation surface
 * (ArtifactStore) on purpose: there is no way to reach a write from here.
 *
 * WHY DISK AND NOT `ctx.sessionQuery`: the disk root is the union of every
 * artifact this plugin has ever persisted, including sessions whose log was
 * pruned or archived. The session query service is used only to LABEL results
 * (a human title), never to decide what exists.
 * @module
 */
import { readdirSync } from 'node:fs'
import { makePersister, persistDirFor, type PersistedArtifact } from './persistence.ts'

/** One importable artifact, as the library reports it. */
export interface LibraryEntry {
  /** The owning session's id — the sanitized directory name. */
  sessionId: string
  /** The artifact's id WITHIN that session. */
  artifactId: string
  title?: string
  interactive?: boolean
  /** Saved versions available to carry over (ascending). */
  versionCount: number
  /** Bytes of the working copy. */
  bytes: number
  /** The working copy, for a preview/thumbnail. */
  html: string
  /** Where this artifact itself was imported from, if it was. */
  origin?: { sessionId: string; artifactId: string }
}

/** All artifacts in one session directory. */
export interface LibrarySession {
  sessionId: string
  /** Human title of the SOURCE session, when the host can supply one. Labeling
   *  only: a session with no title still lists (its id is a usable label). */
  title?: string
  artifacts: LibraryEntry[]
}

/** How many artifacts one `library` call may return, and the HTML budget.
 *  A library listing is meant to be reviewable by a model: full HTML for
 *  hundreds of artifacts would blow the context for no benefit, so entries are
 *  returned as METADATA plus a truncated preview, and a caller that wants the
 *  source uses `read` after importing (or `import` with the source session). */
export const LIBRARY_MAX_ARTIFACTS = 50
export const LIBRARY_PREVIEW_BYTES = 512

/** Truncate for preview without splitting a surrogate pair. */
function preview(html: string): string {
  if (html.length <= LIBRARY_PREVIEW_BYTES) return html
  const slice = html.slice(0, LIBRARY_PREVIEW_BYTES)
  // Drop a trailing lone high surrogate so the preview stays valid text.
  const last = slice.charCodeAt(slice.length - 1)
  return (last >= 0xd800 && last <= 0xdbff ? slice.slice(0, -1) : slice) + '…'
}

/**
 * Enumerate the artifact library across sessions.
 *
 * @param root - the artifacts root (`~/.dsh/artifacts`).
 * @param options.excludeSessionId - the CURRENT session, whose artifacts are
 *   already in the store and would be noise in the picker.
 * @param options.sessionId - restrict to one source session.
 * @param options.limit - cap on returned artifacts (default 50).
 * @returns sessions with their importable artifacts, newest session dir first.
 */
export function scanLibrary(root: string, options: {
  excludeSessionId?: string
  sessionId?: string
  limit?: number
  /** Source-session titles by sanitized directory name. Supplied by the host
   *  (ctx.sessionQuery.readTitleSnapshots) and used for LABELS only. */
  titles?: ReadonlyMap<string, string>
} = {}): LibrarySession[] {
  if (root === '') return []
  let dirs: string[]
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    // No artifacts root yet (a fresh install) — an empty library, not an error.
    return []
  }

  const wanted = options.sessionId
  const titles = options.titles
  const sessions: LibrarySession[] = []
  let remaining = options.limit ?? LIBRARY_MAX_ARTIFACTS
  for (const dir of dirs) {
    if (remaining <= 0) break
    if (dir === options.excludeSessionId) continue
    if (wanted !== undefined && dir !== wanted) continue
    // `loadAll` swallows every fs error internally, so one unreadable directory
    // can never abort the scan.
    let snapshots: PersistedArtifact[]
    try {
      snapshots = makePersister(root, dir).loadAll()
    } catch {
      continue
    }
    const artifacts: LibraryEntry[] = []
    for (const snapshot of snapshots) {
      if (remaining <= 0) break
      // Tombstones are excluded: importing a deleted artifact would resurrect
      // something the user deliberately removed.
      if (snapshot.deleted === true) continue
      artifacts.push({
        sessionId: dir,
        artifactId: snapshot.id,
        ...snapshot.title === undefined ? {} : { title: snapshot.title },
        ...snapshot.interactive === undefined ? {} : { interactive: snapshot.interactive },
        ...snapshot.origin === undefined ? {} : { origin: snapshot.origin },
        versionCount: snapshot.versions.length,
        bytes: Buffer.byteLength(snapshot.html, 'utf-8'),
        html: preview(snapshot.html),
      })
      remaining -= 1
    }
    if (artifacts.length > 0) {
      const title = titles?.get(dir)
      sessions.push({ sessionId: dir, ...title === undefined ? {} : { title }, artifacts })
    }
  }
  return sessions
}

/**
 * Read ONE artifact's full snapshot from another session, for import.
 *
 * The read is addressed by (sessionId, artifactId) and is confined to
 * `<root>/<sessionId>`; `artifactId` is validated by the persister's own name
 * check before any path is built, so a crafted id cannot escape the directory.
 * @param root - the artifacts root.
 * @param sessionId - the source session.
 * @param artifactId - the source artifact.
 * @returns the snapshot, or undefined when absent.
 */
export function readLibraryArtifact(root: string, sessionId: string, artifactId: string): PersistedArtifact | undefined {
  if (root === '') return undefined
  // Containment guard for the DIRECTORY component: `persistDirFor` sanitizes
  // the session id, and requiring the result to be a strict child of `root`
  // keeps a crafted id ('.', '..', a dot-only name) from reaching an unrelated
  // directory. The same guarantee is asserted in tests/contracts.spec.ts.
  const intended = persistDirFor(root, sessionId)
  if (!intended.startsWith(root.endsWith('/') ? root : `${root}/`)) return undefined
  try {
    const snapshot = makePersister(root, sessionId).loadAll().find(entry => entry.id === artifactId)
    return snapshot
  } catch {
    return undefined
  }
}

/** The sessions that currently have a directory on disk (for diagnostics). */
export function librarySessionIds(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}