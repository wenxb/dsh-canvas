/*
 * Disk persistence: write-through on every mutation, clean destroy, and a
 * full round-trip into a FRESH store (rebuilds working copy + versions).
 * Runs against a real tmp dir — the seam is fs-backed, so test the fs.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../src/registry.ts'
import { makePersister } from '../src/persistence.ts'

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function storeInTemp(): { store: ArtifactStore; dir: string } {
  dir = mkdtempSync(join(tmpdir(), 'dsh-artifact-persist-'))
  const persister = makePersister(dir, 'session-1')
  // loadAll looks INSIDE <root>/<sessionId>/ — the store boots from there.
  return { dir: join(dir, 'session-1'), store: new ArtifactStore(persister) }
}

const CAP = 1024 * 1024

describe('artifact disk persistence', () => {
  it('writes the working copy, manifest, and per-version files on mutations', () => {
    const { store, dir: d } = storeInTemp()
    const id = store.create('<p>v1</p>', '演示', CAP, true)
    store.patch(id, '<p>v1</p>', '<p>v2-wip</p>', false, CAP)
    store.save(id)
    const files = readdirSync(d).sort()
    expect(files).toEqual([`${id}.html`, `${id}.json`, `${id}.v1.html`, `${id}.v2.html`])
    expect(readFileSync(join(d, `${id}.html`), 'utf-8')).toBe('<p>v2-wip</p>')
    expect(readFileSync(join(d, `${id}.v1.html`), 'utf-8')).toBe('<p>v1</p>')
    expect(readFileSync(join(d, `${id}.v2.html`), 'utf-8')).toBe('<p>v2-wip</p>')
    const manifest = JSON.parse(readFileSync(join(d, `${id}.json`), 'utf-8'))
    expect(manifest.title).toBe('演示')
    expect(manifest.interactive).toBe(true)
    expect(manifest.versions.map((v: { version: number }) => v.version)).toEqual([1, 2])
  })

  it('round-trips into a fresh store in the same session directory', () => {
    const first = storeInTemp()
    const id = first.store.create('<h1>A</h1>', '页面', CAP)
    first.store.patch(id, 'A</h1>', 'A!</h1>', false, CAP)
    first.store.save(id)
    const second = new ArtifactStore(makePersister(dir as string, 'session-1'))
    for (const snap of makePersister(dir as string, 'session-1').loadAll()) {
      second.restore(snap.id, snap)
    }
    expect(second.get(id).html).toBe('<h1>A!</h1>')
    expect(second.get(id).title).toBe('页面')
    expect(second.versionsOf(id).map(v => v.version)).toEqual([1, 2])
    // Revert works off the disk-restored versions.
    second.revertTo(id, 1)
    expect(second.get(id).html).toBe('<h1>A</h1>')
    expect(second.get(id).version).toBe(2)
  })

  it('destroy is now a SOFT delete: files and manifest stay, manifest records deleted', () => {
    const { store, dir: d } = storeInTemp()
    const id = store.create('<p>x</p>', undefined, CAP)
    store.patch(id, 'x', 'y', false, CAP)
    store.save(id)
    store.destroy(id)
    const remaining = readdirSync(d).filter(f => f.startsWith(id))
    expect(remaining.sort()).toEqual([`${id}.html`, `${id}.json`, `${id}.v1.html`, `${id}.v2.html`].sort())
    expect(JSON.parse(readFileSync(join(d, `${id}.json`), 'utf-8')).deleted).toBe(true)
  })

  it('a soft-deleted artifact is invisible to new ops but recoverable from disk', () => {
    const first = storeInTemp()
    const id = first.store.create('<p>x</p>', undefined, CAP)
    first.store.destroy(id)
    // Model-visible: not there anymore
    expect(() => first.store.get(id)).toThrow(/not found/)
    expect(first.store.list()).toEqual([])
    expect(first.store.has(id)).toBe(false)
    // Disk still has it; a fresh store booting from the SAME dir is opaque to it.
    const second = new ArtifactStore(makePersister(dir as string, 'session-1'))
    for (const snap of makePersister(dir as string, 'session-1').loadAll()) {
      second.restore(snap.id, { html: snap.html, ...snap.deleted === true ? { deleted: true } : {}, versions: snap.versions })
    }
    expect(second.has(id)).toBe(false)
    expect(second.list()).toEqual([])
    // But the manifest still carries the deleted flag for manual repair:
    expect(JSON.parse(readFileSync(join(dir as string, 'session-1', `${id}.json`), 'utf-8')).deleted).toBe(true)
  })

  it('the session GC removes artifact dirs whose session is gone from persistence — keeps everything alive or archived', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-artifact-gc-'))
    mkdirSync(join(root, 'session-a'), { recursive: true })
    mkdirSync(join(root, 'session-b'), { recursive: true })
    mkdirSync(join(root, 'session-gone'), { recursive: true })
    const { writeFileSync } = require('node:fs')
    writeFileSync(join(root, 'session-a', 'art-x.html'), '<p>a</p>')
    writeFileSync(join(root, 'session-gone', 'art-y.html'), '<p>bye</p>')
    const { gcOrphanArtifacts } = require('../src/persistence.ts')
    const removed: string[] = gcOrphanArtifacts(root, new Set(['session-a', 'session-b']))
    expect(removed).toEqual(['session-gone'])
    expect(readdirSync(root).sort()).toEqual(['session-a', 'session-b'].sort())
    rmSync(root, { recursive: true, force: true })
  })

  it('corrupt manifests are skipped, not fatal', () => {
    const { dir: d } = storeInTemp()
    const { writeFileSync, mkdirSync } = require('node:fs')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'art-broken.json'), '{not json', 'utf-8')
    expect(makePersister(dir as string, 'session-1').loadAll()).toEqual([])
  })
})
