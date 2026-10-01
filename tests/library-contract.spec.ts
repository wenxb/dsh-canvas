/*
 * THE HOST↔CLIENT WIRE CONTRACT for the cross-session library.
 *
 * The host builds these JSON bodies and the browser half parses them, with no
 * type shared across the boundary and no compiler between them. Each side's own
 * unit tests pass happily while the field names disagree; the user then sees an
 * EMPTY PICKER, which is indistinguishable from "you have no other artifacts".
 *
 * So this test does not assert a hand-written fixture against the parser — it
 * runs the HOST'S ACTUAL payload builder into the CLIENT'S ACTUAL parser and
 * requires a faithful round trip. Rename a field on either side and this fails.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  libraryListingPayload,
  libraryVersionsPayload,
  readLibraryArtifact,
  scanLibrary,
} from '../src/library.ts'
import { fetchLibrary, fetchLibraryVersions } from '../src/client/canvas/state.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
})

/** A real artifacts root on disk with one source session. */
function seedRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'dsh-artifact-libcontract-'))
  const dir = join(root, 'session-source')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'art-demo.html'), '<h1>working</h1>')
  writeFileSync(join(dir, 'art-demo.v1.html'), '<h1>one</h1>')
  writeFileSync(join(dir, 'art-demo.v2.html'), '<h1>two</h1>')
  writeFileSync(join(dir, 'art-demo.json'), JSON.stringify({
    id: 'art-demo',
    title: '示例画布',
    interactive: true,
    origin: { sessionId: 'session-even-older', artifactId: 'art-root' },
    versions: [{ version: 1, time: 1000 }, { version: 2, time: 2000 }],
  }))
  return root
}

/** Serve one JSON body through a stubbed global fetch. */
function stubFetch(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })))
}

describe('listing payload round-trips through the client parser', () => {
  it('preserves ids, titles, counts, sizes and provenance', async () => {
    const seam = seedRoot()
    const sessions = scanLibrary(seam, { titles: new Map([['session-source', '源会话标题']]) })
    stubFetch(listingLibraryPayload(sessions))

    const parsed = await fetchLibrary(undefined)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.sessions).toHaveLength(1)
    const session = parsed.sessions[0]
    // The session title comes from the host's title map, not the directory name.
    expect(session?.sessionId).toBe('session-source')
    expect(session?.title).toBe('源会话标题')

    const artifact = session?.artifacts[0]
    expect(artifact?.artifactId).toBe('art-demo')
    expect(artifact?.title).toBe('示例画布')
    expect(artifact?.versions).toBe(2)
    // The byte count is the WORKING COPY's, computed host-side.
    expect(artifact?.bytes).toBe(Buffer.byteLength('<h1>working</h1>', 'utf-8'))
    expect(artifact?.interactive).toBe(true)
    // Provenance must survive, or the "转自其他会话" badge never renders.
    expect(artifact?.origin).toEqual({ sessionId: 'session-even-older', artifactId: 'art-root' })
  })

  it('omits optional fields rather than sending them as undefined', () => {
    const payload = listingLibraryPayload([{
      sessionId: 's',
      artifacts: [{ sessionId: 's', artifactId: 'a', versionCount: 1, bytes: 3, html: 'x' }],
    }])
    const serialized = JSON.stringify(payload)
    // `undefined` does not survive JSON anyway, but a literal null WOULD reach
    // the client as a present-but-null title.
    expect(serialized).not.toContain('null')
    expect(payload.sessions[0]?.title).toBeUndefined()
    expect(payload.sessions[0]?.artifacts[0]?.title).toBeUndefined()
    expect(payload.sessions[0]?.artifacts[0]?.origin).toBeUndefined()
  })
})

describe('version payload round-trips through the client parser', () => {
  it('preserves every version with its time and byte size', async () => {
    const seam = seedRoot()
    const snapshot = readLibraryArtifact(seam, 'session-source', 'art-demo')
    expect(snapshot).toBeDefined()
    stubFetch(libraryVersionsPayload('session-source', 'art-demo', snapshot!))

    const parsed = await fetchLibraryVersions('session-source', 'art-demo')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.versions.map(v => v.version)).toEqual([1, 2])
    expect(parsed.versions.map(v => v.time)).toEqual([1000, 2000])
    expect(parsed.versions[0]?.bytes).toBe(Buffer.byteLength('<h1>one</h1>', 'utf-8'))
    expect(parsed.versions[1]?.bytes).toBe(Buffer.byteLength('<h1>two</h1>', 'utf-8'))
  })

  it('keeps the artifact marked interactive when the manifest says so', () => {
    const snapshot = readLibraryArtifact(seedRoot(), 'session-source', 'art-demo')
    const payload = libraryVersionsPayload('session-source', 'art-demo', snapshot!)
    expect(payload.artifact.interactive).toBe(true)
  })
})

/** Local alias so the test reads clearly; the host exports the same shape. */
function listingLibraryPayload(sessions: Parameters<typeof libraryListingPayload>[0]) {
  return libraryListingPayload(sessions)
}
