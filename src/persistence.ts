/**
 * Write-through disk persistence for artifact bodies. Every session's
 * artifacts live under `~/.dsh/artifacts/<sessionId>/`:
 *
 * - `<id>.html`        — the current WORKING COPY (rewritten on every
 *   create/patch/save/revert);
 * - `<id>.json`        — the manifest: { id, title?, interactive?, deleted?,
 *   bytes?, versions: [{ version, time, bytes? }] }. METADATA ONLY — it never
 *   duplicates a body, and `bytes` lets a listing size an artifact without
 *   reading any html;
 * - `<id>.v<N>.html`   — each saved version's frozen source (written on save).
 *
 * The in-memory ArtifactStore remains authoritative at runtime; this directory
 * is a durable cache that survives server restarts and session-log pruning,
 * and doubles as plain files the user (or the better-sidebar file editor) can
 * open directly. External edits to these files do NOT feed back into the
 * store automatically — the model's next tool op overwrites them.
 *
 * All filesystem failures are reported to the console and otherwise ignored:
 * persistence must never break the tool's behavior. Each write is independent
 * (rather than one try/catch around a multi-file sweep) so one unreadable file
 * cannot cause the rest of an operation's writes to be skipped.
 * @module
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactVersion } from './registry.ts'

/** A full artifact snapshot as persisted to (and loaded from) disk. */
export interface PersistedArtifact {
  id: string
  html: string
  title?: string
  interactive?: boolean
  versions: ArtifactVersion[]
  /** Soft-deleted (destroy op): files stay on disk for manual recovery. */
  deleted?: boolean
}

/** The store-facing persistence seam (fs-backed by {@link makePersister}).
 *
 * The operations are MINIMAL on purpose. An earlier seam exposed a single
 * `write(snapshot)` that rewrote the working copy AND every version file AND
 * the manifest on every mutation — so a single-character `patch` rewrote the
 * entire version history, and `restore()` (called for every artifact on every
 * session open) rewrote every artifact from scratch. Each method here writes
 * exactly the file its operation changed.
 */
export interface ArtifactPersistence {
  /** Write the working copy (`<id>.html`) after a patch/revert. */
  writeWorkingCopy(id: string, html: string): void
  /** Write one frozen version body (`<id>.v<N>.html`). */
  writeVersion(id: string, version: ArtifactVersion): void
  /** Write the manifest (`<id>.json`) — metadata only, never a body. */
  writeManifest(manifest: ArtifactManifest): void
  /** Delete every file belonging to one artifact. */
  remove(id: string): void
  /** Load every persisted artifact (missing/corrupt files are skipped). */
  loadAll(): PersistedArtifact[]
}

/** The lightweight per-artifact manifest stored beside the bodies. Bodies are
 *  NOT duplicated here: `versions` carries only the numbers and timestamps,
 *  and `bytes` lets a listing report size without reading the html files. */
export interface ArtifactManifest {
  id: string
  title?: string
  interactive?: boolean
  deleted?: boolean
  /** Total bytes of the working copy. */
  bytes?: number
  versions: { version: number; time: number; bytes?: number }[]
}

/** The default root: per-session directories under the DSH home. */
export const DEFAULT_PERSIST_ROOT = (): string => join(homedir(), '.dsh', 'artifacts')

function safeName(id: string): string | undefined {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) ? id : undefined
}

/** The on-disk directory of one session's artifacts (sanitized session id). */
export function persistDirFor(root: string, sessionId: string): string {
  return join(root, sessionId.replace(/[^a-z0-9._-]/gi, '_'))
}

function safeSessionDir(root: string, sessionId: string): string {
  return persistDirFor(root, sessionId)
}

/**
 * Garbage-collect artifact directories whose session no longer exists in the
 * persistence index (hard-deleted from the 回收站; archived-but-recoverable
 * sessions stay). Returns the removed session ids.
 * Errors are per-dir swallowed — the GC must never block the plugin boot.
 */
export function gcOrphanArtifacts(root: string, aliveSessionIds: ReadonlySet<string>): string[] {
  let dirs: string[]
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const dir of dirs) {
    if (aliveSessionIds.has(dir)) continue
    try {
      rmSync(join(root, dir), { recursive: true, force: true })
      removed.push(dir)
    } catch (error) {
      console.error(`[dsh-html-artifact] gc failed for ${dir}:`, error)
    }
  }
  return removed
}

/**
 * Create the fs-backed persister for one session.
 * @param root - persistence root (`~/.dsh/artifacts` by default).
 * @param sessionId - the owning session's id (directory name, sanitized).
 * @returns the persister; all io errors are logged-and-swallowed.
 */
export function makePersister(root: string, sessionId: string): ArtifactPersistence {
  const dir = safeSessionDir(root, sessionId)
  const htmlPath = (id: string): string => join(dir, `${id}.html`)
  const manifestPath = (id: string): string => join(dir, `${id}.json`)
  const versionPath = (id: string, version: number): string => join(dir, `${id}.v${version}.html`)

  /** Every write is a lone `mkdirSync` + `writeFileSync`; a failure in one
   *  artifact's write must not abandon the rest of an operation. */
  const writeFile = (path: string, content: string): void => {
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, content, 'utf-8')
    } catch (error) {
      console.error(`[dsh-html-artifact] persistence write failed for ${path}:`, error)
    }
  }

  const writeWorkingCopy = (id: string, html: string): void => {
    if (safeName(id) === undefined) return
    writeFile(htmlPath(id), html)
  }

  const writeVersion = (id: string, version: ArtifactVersion): void => {
    if (safeName(id) === undefined) return
    writeFile(versionPath(id, version.version), version.html)
  }

  const writeManifest = (manifest: ArtifactManifest): void => {
    if (safeName(manifest.id) === undefined) return
    writeFile(manifestPath(manifest.id), JSON.stringify(manifest, null, 2))
  }

  const remove = (id: string): void => {
    if (safeName(id) === undefined) return
    try {
      for (const file of readdirSync(dir)) {
        if (file === `${id}.json` || file === `${id}.html` || file.startsWith(`${id}.v`)) {
          unlinkSync(join(dir, file))
        }
      }
    } catch (error) {
      console.error('[dsh-html-artifact] persistence remove failed:', error)
    }
  }

  const loadAll = (): PersistedArtifact[] => {
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      return []
    }
    const out: PersistedArtifact[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const id = file.slice(0, -'.json'.length)
      if (safeName(id) === undefined) continue
      try {
        const manifest = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Partial<ArtifactManifest>
        if (typeof manifest.id !== 'string' || !Array.isArray(manifest.versions)) continue
        const html = readFileSync(htmlPath(manifest.id), 'utf-8')
        const versions: ArtifactVersion[] = []
        for (const entry of manifest.versions) {
          if (typeof entry?.version !== 'number' || typeof entry?.time !== 'number') continue
          try {
            versions.push({ version: entry.version, html: readFileSync(versionPath(manifest.id, entry.version), 'utf-8'), time: entry.time })
          } catch {
            // A version file went missing — skip it; the working copy survives.
          }
        }
        out.push({
          id: manifest.id,
          html,
          ...manifest.deleted === true ? { deleted: true } : {},
          ...typeof manifest.title === 'string' ? { title: manifest.title } : {},
          ...typeof manifest.interactive === 'boolean' ? { interactive: manifest.interactive } : {},
          versions,
        })
      } catch (error) {
        console.error(`[dsh-html-artifact] skipping corrupt persisted artifact ${id}:`, error)
      }
    }
    return out
  }

  return { writeWorkingCopy, writeVersion, writeManifest, remove, loadAll }
}
