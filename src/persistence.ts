/**
 * Write-through disk persistence for artifact bodies. Every session's
 * artifacts live under `~/.dsh/artifacts/<sessionId>/`:
 *
 * - `<id>.html`        — the current WORKING COPY (rewritten on every
 *   create/patch/save/revert);
 * - `<id>.json`        — the manifest: { id, title?, interactive?,
 *   versions: [{ version, time }] } (rewritten whenever metadata changes);
 * - `<id>.v<N>.html`   — each saved version's frozen source (written on save).
 *
 * The in-memory ArtifactStore remains authoritative at runtime; this directory
 * is a durable cache that survives server restarts and session-log pruning,
 * and doubles as plain files the user (or the better-sidebar file editor) can
 * open directly. External edits to these files do NOT feed back into the
 * store automatically — the model's next tool op overwrites them.
 *
 * All filesystem failures are reported to the console and otherwise ignored:
 * persistence must never break the tool's behavior.
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

/** The store-facing persistence seam (fs-backed by {@link makePersister}). */
export interface ArtifactPersistence {
  /** Write-through after every mutation of the artifact. */
  write(snapshot: PersistedArtifact): void
  /** Delete every file belonging to one artifact. */
  remove(id: string): void
  /** Load every persisted artifact (missing/corrupt files are skipped). */
  loadAll(): PersistedArtifact[]
}

interface Manifest {
  id: string
  title?: string
  interactive?: boolean
  deleted?: boolean
  versions: { version: number; time: number }[]
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

  const write = (snapshot: PersistedArtifact): void => {
    if (safeName(snapshot.id) === undefined) return
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(htmlPath(snapshot.id), snapshot.html, 'utf-8')
      for (const entry of snapshot.versions) {
        writeFileSync(versionPath(snapshot.id, entry.version), entry.html, 'utf-8')
      }
      const manifest: Manifest = {
        id: snapshot.id,
        ...snapshot.title === undefined ? {} : { title: snapshot.title },
        ...snapshot.interactive === undefined ? {} : { interactive: snapshot.interactive },
        ...snapshot.deleted === true ? { deleted: true } : {},
        versions: snapshot.versions.map(entry => ({ version: entry.version, time: entry.time })),
      }
      writeFileSync(manifestPath(snapshot.id), JSON.stringify(manifest, null, 2), 'utf-8')
    } catch (error) {
      console.error('[dsh-html-artifact] persistence write failed:', error)
    }
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
        const manifest = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Partial<Manifest>
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

  return { write, remove, loadAll }
}
