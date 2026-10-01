/*
 * The cross-session import flow, end to end against a REAL temp artifacts root.
 *
 * The safety property this feature rests on is that import is a ONE-WAY COPY:
 * it reads another session's directory and writes into the current session. The
 * tests below assert that from the outside — by stamping the source directory
 * before the import and proving nothing in it changed afterwards.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../src/registry.ts'
import { makePersister } from '../src/persistence.ts'
import { LIBRARY_MAX_ARTIFACTS, readLibraryArtifact, scanLibrary } from '../src/library.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

const CAP = 1 << 20

/**
 * A fresh artifacts root with a source session whose artifact has TWO saved
 * versions (v1, v2) and an UNSAVED working copy (v3-wip) — the interesting
 * shape, because it exercises both "carry the history" and "the working copy is
 * ahead of the newest saved version". */
function withSourceSession(sourceSession = 'session-source'): {
  root: string
  sourceStore: ArtifactStore
  artifactId: string
} {
  root = mkdtempSync(join(tmpdir(), 'dsh-artifact-import-'))
  const sourceStore = new ArtifactStore(makePersister(root, sourceSession))
  const artifactId = sourceStore.create('<h1>v1</h1>', '源画布', CAP, true)
  sourceStore.patch(artifactId, 'v1', 'v2', false, CAP)
  sourceStore.save(artifactId)
  // Deliberately NOT saved: the working copy is ahead of 版本 2.
  sourceStore.patch(artifactId, 'v2', 'v3-wip', false, CAP)
  return { root, sourceStore, artifactId }
}

/** Fingerprint every file in a directory (name + size + mtime). */
const stampDir = (dir: string): string =>
  readdirSync(dir).sort().map((file) => {
    const stats = statSync(join(dir, file))
    return `${file}:${stats.size}:${stats.mtimeMs}`
  }).join('|')

describe('scanLibrary', () => {
  it('lists artifacts from other sessions with metadata + a preview', () => {
    const { root: r, artifactId } = withSourceSession()
    const sessions = scanLibrary(r)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.sessionId).toBe('session-source')
    const entry = sessions[0]!.artifacts[0]!
    expect(entry.artifactId).toBe(artifactId)
    expect(entry.title).toBe('源画布')
    expect(entry.interactive).toBe(true)
    expect(entry.versionCount).toBe(2)
    expect(entry.html).toBe('<h1>v3-wip</h1>')
    expect(entry.bytes).toBe(Buffer.byteLength('<h1>v3-wip</h1>'))
  })

  it('excludes the current session (its artifacts are already in the store)', () => {
    const { root: r } = withSourceSession()
    expect(scanLibrary(r, { excludeSessionId: 'session-source' })).toEqual([])
    expect(scanLibrary(r, { sessionId: 'session-source' })).toHaveLength(1)
  })

  it('omits tombstones (importing would resurrect a deleted artifact)', () => {
    const { root: r, sourceStore, artifactId } = withSourceSession()
    sourceStore.destroy(artifactId)
    expect(scanLibrary(r)).toEqual([])
  })

  it('truncates a huge preview rather than shipping whole bodies', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-artifact-import-'))
    const store = new ArtifactStore(makePersister(root, 'session-big'))
    store.create(`<p>${'x'.repeat(5000)}</p>`, 'big', CAP)
    const entry = scanLibrary(root)[0]!.artifacts[0]!
    expect(entry.html.length).toBeLessThan(600)
    expect(entry.html.endsWith('…')).toBe(true)
    // The reported size is still the REAL size.
    expect(entry.bytes).toBeGreaterThan(5000)
  })

  it('does not split a surrogate pair when truncating', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-artifact-import-'))
    const store = new ArtifactStore(makePersister(root, 'session-emoji'))
    // Position a surrogate pair exactly at the cut boundary.
    store.create('a'.repeat(511) + '😀' + 'tail', 'emoji', CAP)
    const entry = scanLibrary(root)[0]!.artifacts[0]!
    // A lone high surrogate would make this string invalid.
    expect(() => encodeURIComponent(entry.html)).not.toThrow()
    expect(entry.html.endsWith('…')).toBe(true)
  })

  it('honors the limit and returns an empty library for a missing root', () => {
    const { root: r } = withSourceSession()
    expect(scanLibrary(r, { limit: 1 })[0]!.artifacts).toHaveLength(1)
    expect(scanLibrary(join(r, 'does-not-exist'))).toEqual([])
    expect(scanLibrary('')).toEqual([])
  })

  it('skips an unreadable directory instead of failing the scan', () => {
    const { root: r } = withSourceSession()
    mkdirSync(join(r, 'session-empty'), { recursive: true })
    // A bare directory with no manifest is simply not an artifact.
    const sessions = scanLibrary(r)
    expect(sessions.map(s => s.sessionId)).toEqual(['session-source'])
  })

  it('caps the total number of artifacts returned', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-artifact-import-'))
    const store = new ArtifactStore(makePersister(root, 'session-many'))
    for (let index = 0; index < LIBRARY_MAX_ARTIFACTS + 10; index += 1) {
      store.create(`<p>${index}</p>`, `a${index}`, CAP)
    }
    const total = scanLibrary(root).reduce((sum, session) => sum + session.artifacts.length, 0)
    expect(total).toBe(LIBRARY_MAX_ARTIFACTS)
  })
})

describe('readLibraryArtifact', () => {
  it('reads one artifact by session + id', () => {
    const { root: r, artifactId } = withSourceSession()
    const snapshot = readLibraryArtifact(r, 'session-source', artifactId)
    expect(snapshot?.html).toBe('<h1>v3-wip</h1>')
    expect(snapshot?.versions.map(v => v.version)).toEqual([1, 2])
  })

  it('returns undefined for an unknown artifact or session', () => {
    const { root: r } = withSourceSession()
    expect(readLibraryArtifact(r, 'session-source', 'art-nope')).toBeUndefined()
    expect(readLibraryArtifact(r, 'session-nope', 'art-nope')).toBeUndefined()
  })

  it('cannot be steered outside the root by a crafted session id', () => {
    const { root: r } = withSourceSession()
    for (const hostile of ['..', '.', '../../etc', '....']) {
      expect(readLibraryArtifact(r, hostile, 'art-1')).toBeUndefined()
    }
  })
})

describe('import is a one-way copy', () => {
  it('copies an artifact into the current session WITHOUT touching the source', () => {
    const { root: r, artifactId } = withSourceSession()
    const sourceDir = join(r, 'session-source')
    const before = stampDir(sourceDir)

    const target = new ArtifactStore(makePersister(r, 'session-target'))
    const snapshot = readLibraryArtifact(r, 'session-source', artifactId)!
    const { id, versions } = target.importArtifact({
      html: snapshot.html,
      ...snapshot.title === undefined ? {} : { title: snapshot.title },
      ...snapshot.interactive === undefined ? {} : { interactive: snapshot.interactive },
      versions: snapshot.versions,
      origin: { sessionId: 'session-source', artifactId },
    }, CAP, { includeVersions: true })

    // The source directory is byte-for-byte and mtime-for-mtime unchanged.
    expect(stampDir(sourceDir)).toBe(before)
    // The copy landed in the TARGET session's own directory.
    expect(readdirSync(join(r, 'session-target')).length).toBeGreaterThan(0)
    expect(readdirSync(sourceDir).length).toBeGreaterThan(0)
    // The copy is a normal, fully usable artifact of the target session.
    expect(target.get(id).html).toBe('<h1>v3-wip</h1>')
    expect(target.get(id).title).toBe('源画布')
    expect(target.versionsOf(id).map(v => v.version)).toEqual([1, 2, 3])
    expect(versions).toBe(3)
    expect(target.originOf(id)).toEqual({ sessionId: 'session-source', artifactId })
  })

  it('gives the import a FRESH id (source ids are only unique per session)', () => {
    const { root: r, artifactId } = withSourceSession()
    const target = new ArtifactStore(makePersister(r, 'session-target'))
    const snapshot = readLibraryArtifact(r, 'session-source', artifactId)!
    const { id } = target.importArtifact({ html: snapshot.html, versions: snapshot.versions }, CAP)
    expect(id).not.toBe(artifactId)
    expect(target.has(id)).toBe(true)
  })

  it('does not collide with an artifact the target already has', () => {
    const { root: r, artifactId } = withSourceSession()
    const target = new ArtifactStore(makePersister(r, 'session-target'))
    // Occupy several ids in the target first, then import more than once.
    const existing = new Set<string>()
    for (let i = 0; i < 5; i += 1) existing.add(target.create(`<p>${i}</p>`, undefined, CAP))
    const first = target.importArtifact({ html: '<p>a</p>', versions: [] }, CAP)
    const second = target.importArtifact({ html: '<p>b</p>', versions: [] }, CAP)
    expect(first.id).not.toBe(second.id)
    expect(existing.has(first.id)).toBe(false)
    expect(existing.has(second.id)).toBe(false)
    // And a full import from the source session also gets its own id.
    const snapshot = readLibraryArtifact(r, 'session-source', artifactId)!
    const third = target.importArtifact({ html: snapshot.html, versions: snapshot.versions }, CAP, { includeVersions: true })
    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
  })

  it('carries only the working copy by default, keeping an import small', () => {
    // The review's own case: a 17-version artifact would otherwise drag ~2 MB
    // across for what is usually just a starting point.
    const { root: r, artifactId } = withSourceSession()
    const target = new ArtifactStore(makePersister(r, 'session-target'))
    const snapshot = readLibraryArtifact(r, 'session-source', artifactId)!
    const { id, versions } = target.importArtifact({
      html: snapshot.html, versions: snapshot.versions, origin: { sessionId: 'session-source', artifactId },
    }, CAP, { includeVersions: false })
    // Working copy only: exactly one version, holding the current bytes.
    expect(versions).toBe(1)
    expect(target.get(id).html).toBe('<h1>v3-wip</h1>')
    expect(target.versionsOf(id)).toHaveLength(1)
  })

  it('carries a SELECTED subset of versions, re-based to 1..N', () => {
    const { root: r, artifactId } = withSourceSession()
    const target = new ArtifactStore(makePersister(r, 'session-target'))
    const snapshot = readLibraryArtifact(r, 'session-source', artifactId)!
    const picked = snapshot.versions.filter(entry => entry.version === 2)
    const { id, versions } = target.importArtifact({
      html: snapshot.html, versions: picked, origin: { sessionId: 'session-source', artifactId },
    }, CAP, { includeVersions: true })
    // Re-based: the single picked version becomes 1, and the working copy (which
    // differs from v2) becomes 2 — so 版本 accounting stays truthful.
    expect(versions).toBe(2)
    expect(target.versionsOf(id).map(v => v.version)).toEqual([1, 2])
    expect(target.versionsOf(id)[0]!.html).toBe('<h1>v2</h1>')
    expect(target.get(id).html).toBe('<h1>v3-wip</h1>')
  })

  it('enforces the byte cap like create does', () => {
    const { root: r, artifactId } = withSourceSession()
    const target = new ArtifactStore(makePersister(r, 'session-target'))
    const snapshot = readLibraryArtifact(r, 'session-source', artifactId)!
    expect(() => target.importArtifact({ html: snapshot.html, versions: [] }, 4)).toThrow(/exceeds the 4-byte cap/)
  })

  it('survives a restart with its provenance and versions intact', () => {
    const { root: r, artifactId } = withSourceSession()
    const target = new ArtifactStore(makePersister(r, 'session-target'))
    const snapshot = readLibraryArtifact(r, 'session-source', artifactId)!
    const { id } = target.importArtifact({
      html: snapshot.html,
      ...snapshot.title === undefined ? {} : { title: snapshot.title },
      versions: snapshot.versions,
      origin: { sessionId: 'session-source', artifactId },
    }, CAP, { includeVersions: true })

    // A fresh store booting from the same directory must see the same thing.
    const rebooted = new ArtifactStore(makePersister(r, 'session-target'))
    for (const entry of makePersister(r, 'session-target').loadAll()) rebooted.restore(entry.id, entry)
    expect(rebooted.originOf(id)).toEqual({ sessionId: 'session-source', artifactId })
    expect(rebooted.versionsOf(id).map(v => v.version)).toEqual([1, 2, 3])
    expect(rebooted.get(id).title).toBe('源画布')
    // And it is a real artifact: patch + save work on it.
    rebooted.patch(id, 'v3-wip', 'v4', false, CAP)
    expect(rebooted.save(id).unchanged).toBe(false)
    expect(rebooted.get(id).version).toBe(4)
  })

  it('an imported artifact can be re-imported into a THIRD session', () => {
    // Provenance chains must not break the import path.
    const { root: r, artifactId } = withSourceSession()
    const middle = new ArtifactStore(makePersister(r, 'session-middle'))
    const snapshot = readLibraryArtifact(r, 'session-source', artifactId)!
    middle.importArtifact({
      html: snapshot.html, ...snapshot.title === undefined ? {} : { title: snapshot.title },
      versions: snapshot.versions,
      origin: { sessionId: 'session-source', artifactId },
    }, CAP, { includeVersions: true })

    const third = new ArtifactStore(makePersister(r, 'session-third'))
    const viaMiddle = readLibraryArtifact(r, 'session-middle', middle.list()[0]!.id)!
    third.importArtifact({ html: viaMiddle.html, versions: viaMiddle.versions }, CAP, { includeVersions: true })
    expect(third.list()).toHaveLength(1)
    expect(third.list()[0]!.bytes).toBeGreaterThan(0)
  })

  it('leaves the source usable after the import (no move, no delete)', () => {
    const { root: r, artifactId } = withSourceSession()
    const target = new ArtifactStore(makePersister(r, 'session-target'))
    const snapshot = readLibraryArtifact(r, 'session-source', artifactId)!
    target.importArtifact({ html: snapshot.html, versions: snapshot.versions }, CAP, { includeVersions: true })
    // The source artifact is still there, still live, and re-importable.
    const again = readLibraryArtifact(r, 'session-source', artifactId)
    expect(again?.html).toBe('<h1>v3-wip</h1>')
    expect(scanLibrary(r, { sessionId: 'session-source' })[0]!.artifacts).toHaveLength(1)
  })
})

describe('import against an older manifest shape', () => {
  it('reads a manifest written WITHOUT origin/bytes (forward compatibility)', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-artifact-import-'))
    const dir = join(root, 'session-legacy')
    mkdirSync(dir, { recursive: true })
    // The pre-origin/pre-bytes manifest shape.
    writeFileSync(join(dir, 'art-legacy.html'), '<p>legacy</p>')
    writeFileSync(join(dir, 'art-legacy.v1.html'), '<p>legacy</p>')
    writeFileSync(join(dir, 'art-legacy.json'), JSON.stringify({
      id: 'art-legacy', title: '旧', versions: [{ version: 1, time: 1 }],
    }))
    const snapshot = readLibraryArtifact(root, 'session-legacy', 'art-legacy')
    expect(snapshot?.html).toBe('<p>legacy</p>')
    expect(snapshot?.origin).toBeUndefined()
    const target = new ArtifactStore(makePersister(root, 'session-target'))
    const { id } = target.importArtifact({ html: snapshot!.html, versions: snapshot!.versions }, CAP, { includeVersions: true })
    expect(target.get(id).html).toBe('<p>legacy</p>')
    // No invented provenance.
    expect(target.originOf(id)).toBeUndefined()
  })

  it('ignores a malformed origin record rather than trusting it', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-artifact-import-'))
    const dir = join(root, 'session-bad')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'art-bad.html'), '<p>x</p>')
    writeFileSync(join(dir, 'art-bad.json'), JSON.stringify({
      id: 'art-bad', origin: { sessionId: 42 }, versions: [],
    }))
    const snapshot = readLibraryArtifact(root, 'session-bad', 'art-bad')
    expect(snapshot?.origin).toBeUndefined()
    expect(readFileSync(join(dir, 'art-bad.json'), 'utf-8')).toContain('42')
  })
})