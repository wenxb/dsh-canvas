/*
 * THE `/artifact/api/library` ROUTE, driven through the REAL `apply()`.
 *
 * The route is the only way the picker learns what exists in other sessions,
 * and it is fenced — a request it rejects looks to the UI exactly like "there is
 * nothing to import". So both halves are asserted here: that a trusted request
 * gets the right data, and that an untrusted one is refused.
 *
 * Nothing else covers this handler. It has no unit tests of its own, and the
 * path is only reachable from a browser in a live harness, so a fence that
 * admitted everything, or an exclusion that dropped the wrong session, would
 * ship unnoticed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

/** A route registration captured from `apply()`. */
interface CapturedRoute {
  kind: string
  path: string
  handler: (req: FakeRequest, res: FakeResponse) => unknown
}

/** The `res` surface the route writes through (`writeHead` + `end`). */
interface FakeResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body: string): void
}

interface FakeRequest {
  headers: Record<string, string>
  url?: string
  method?: string
}

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** An artifacts root with one OTHER session holding one artifact, two versions. */
function seedRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'dsh-artifact-route-'))
  const dir = join(root, 'session-other')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'art-x.html'), '<p>working</p>')
  writeFileSync(join(dir, 'art-x.v1.html'), '<p>one</p>')
  writeFileSync(join(dir, 'art-x.v2.html'), '<p>two</p>')
  writeFileSync(join(dir, 'art-x.json'), JSON.stringify({
    id: 'art-x',
    title: '别人画的',
    versions: [{ version: 1, time: 100 }, { version: 2, time: 200 }],
  }))
  // A tombstone must never be offered for import.
  const deadDir = join(root, 'session-dead')
  mkdirSync(deadDir, { recursive: true })
  writeFileSync(join(deadDir, 'art-gone.html'), '<p>gone</p>')
  writeFileSync(join(deadDir, 'art-gone.json'), JSON.stringify({
    id: 'art-gone', deleted: true, versions: [],
  }))
  return root
}

/** Records any attempt to fold session logs for titles. */
const titleProbes: string[] = []

/**
 * Run `apply()` against a stand-in context and capture the library route.
 *
 * `sessionQuery.readTitleSnapshots` is a TRIPWIRE: resolving a session title
 * means folding that session's LOG, which measured 32.4 seconds and +278 MB for
 * a single listing against a real 107-directory artifacts root. The listing
 * must never do it — session names are a free client-side join from the
 * `displayTitle` the session list already holds. Any call here is recorded and
 * fails the performance test below.
 */
function captureLibraryRoute(persistRoot: string): CapturedRoute {
  let captured: CapturedRoute | undefined
  const ctx = {
    tools: { register: () => () => {} },
    commands: { register: () => () => {} },
    webServer: {
      register(route: CapturedRoute) {
        if (route.path === '/artifact/api/library') captured = route
        return () => {}
      },
    },
    effect: (fn: () => unknown) => (typeof fn === 'function' ? fn() : undefined),
    inject: (_deps: unknown, callback: (ctx: unknown) => void) => {
      callback({ skills: { register: () => () => {} } })
      return () => {}
    },
    // A live-shaped proxy: `get` resolves the optional service, so a
    // reintroduced title fold would find a working (tripwire) implementation
    // rather than silently no-op'ing on undefined.
    get: (name: string) => name === 'sessionQuery'
      ? { readTitleSnapshots: async (ids: readonly string[]) => { titleProbes.push(...ids); return [] } }
      : undefined,
    on: () => () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  apply(ctx as never, { persistRoot })
  if (captured === undefined) throw new Error('apply() registered no library route')
  return captured
}

/** A request as the browser would send it: same-origin, loopback host. */
function trustedRequest(url: string): FakeRequest {
  return {
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' },
    url,
    method: 'GET',
  }
}

/**
 * Drive the handler and return its reply, decoding the JSON body exactly as the
 * browser does — so the assertions cover the real serialization, not an
 * in-memory object that never made the trip.
 */
async function callRoute(route: CapturedRoute, req: FakeRequest): Promise<{ status: number; body: any }> {
  let result: { status: number; body: any } | undefined
  const res: FakeResponse = {
    writeHead(status) { result = { status, body: undefined } },
    end(body) {
      if (result === undefined) throw new Error('end() before writeHead()')
      result = { status: result.status, body: JSON.parse(body) }
    },
  }
  await route.handler(req as never, res)
  if (result === undefined) throw new Error('the route never replied')
  return result
}

describe('the library route — the picker\'s only data source', () => {
  it('lists another session\'s artifacts with metadata and no HTML', async () => {
    const seam = seedRoot()
    const reply = await callRoute(captureLibraryRoute(seam), trustedRequest('/artifact/api/library'))
    expect(reply.status).toBe(200)
    expect(reply.body.ok).toBe(true)
    const session = reply.body.sessions.find((s: any) => s.sessionId === 'session-other')
    expect(session).toBeDefined()
    const artifact = session.artifacts.find((a: any) => a.artifactId === 'art-x')
    expect(artifact).toMatchObject({ title: '别人画的', versions: 2 })
    // The listing must not ship artifact source — a library of hundreds must
    // not pay to draw a list.
    expect(JSON.stringify(reply.body)).not.toContain('<p>one</p>')
  })

  it('never offers a tombstoned artifact', async () => {
    const seam = seedRoot()
    const reply = await callRoute(captureLibraryRoute(seam), trustedRequest('/artifact/api/library'))
    expect(reply.body.sessions.some((s: any) => s.sessionId === 'session-dead')).toBe(false)
    expect(JSON.stringify(reply.body)).not.toContain('art-gone')
  })

  it('excludes the CURRENT session, so the picker cannot duplicate itself', async () => {
    const seam = seedRoot()
    const reply = await callRoute(
      captureLibraryRoute(seam),
      trustedRequest('/artifact/api/library?currentSessionId=session-other'),
    )
    expect(reply.body.sessions.some((s: any) => s.sessionId === 'session-other')).toBe(false)
  })

  it('returns one artifact\'s versions for the picker\'s second step', async () => {
    const seam = seedRoot()
    const reply = await callRoute(
      captureLibraryRoute(seam),
      trustedRequest('/artifact/api/library?sessionId=session-other&artifactId=art-x'),
    )
    expect(reply.status).toBe(200)
    expect(reply.body.artifact.versions.map((v: any) => v.version)).toEqual([1, 2])
    expect(reply.body.artifact.bytes).toBe(Buffer.byteLength('<p>working</p>', 'utf-8'))
  })

  it('REFUSES a cross-site request', async () => {
    const seam = seedRoot()
    const route = captureLibraryRoute(seam)
    const req = trustedRequest('/artifact/api/library')
    const reply = await callRoute(route, { ...req, headers: { ...req.headers, 'sec-fetch-site': 'cross-site' } })
    expect(reply.status).toBe(403)
    expect(reply.body.ok).toBe(false)
  })

  it('REFUSES a foreign Host, so a LAN origin cannot enumerate local artifacts', async () => {
    const seam = seedRoot()
    const route = captureLibraryRoute(seam)
    const req = trustedRequest('/artifact/api/library')
    const reply = await callRoute(route, { ...req, headers: { ...req.headers, host: 'evil.example.com' } })
    expect(reply.status).toBe(403)
  })

  it('REFUSES a mismatched Origin', async () => {
    const seam = seedRoot()
    const route = captureLibraryRoute(seam)
    const req = trustedRequest('/artifact/api/library')
    const reply = await callRoute(route, { ...req, headers: { ...req.headers, origin: 'http://evil.example.com' } })
    expect(reply.status).toBe(403)
  })

  it('REFUSES a request with no Host header at all', async () => {
    const seam = seedRoot()
    const route = captureLibraryRoute(seam)
    const reply = await callRoute(route, { headers: {}, url: '/artifact/api/library', method: 'GET' })
    expect(reply.status).toBe(403)
  })

  it('refuses before touching the disk (an untrusted id cannot probe the filesystem)', async () => {
    const seam = seedRoot()
    const route = captureLibraryRoute(seam)
    // A traversal attempt through the version lookup must be stopped by the
    // FENCE, not by a containment check that might have a hole.
    const reply = await callRoute(route, {
      headers: { host: 'evil.example.com' },
      url: '/artifact/api/library?sessionId=../../etc&artifactId=passwd',
      method: 'GET',
    })
    expect(reply.status).toBe(403)
  })
})

/*
 * THE PERFORMANCE CONTRACT — the listing must not read session logs.
 *
 * This test exists because the shipped version DID: the route asked the host to
 * fold every session's title out of its log, so opening the import picker took
 * 32.4 seconds and grew the server by 278 MB on a real root (107 session
 * directories, 43 with artifacts). Nothing in the previous suite noticed,
 * because every fixture had one or two sessions — the cost scales with the
 * user's history, which is exactly what a small fixture cannot show.
 *
 * So the assertion is not "it is fast" (wall-clock assertions are flaky); it is
 * "it never folds a log", which is the actual defect and is deterministic. The
 * listing stays O(artifacts-on-disk) manifest reads, which is milliseconds.
 */
describe('the listing never folds session logs for titles', () => {
  it('does not call readTitleSnapshots on the listing path', async () => {
    titleProbes.length = 0
    const seam = seedRoot()
    const reply = await callRoute(captureLibraryRoute(seam), trustedRequest('/artifact/api/library'))
    expect(reply.status).toBe(200)
    expect(titleProbes).toEqual([])
  })

  it('does not call it for the version step either (the client names that row)', async () => {
    titleProbes.length = 0
    const seam = seedRoot()
    const reply = await callRoute(
      captureLibraryRoute(seam),
      trustedRequest('/artifact/api/library?sessionId=session-other&artifactId=art-x'),
    )
    expect(reply.status).toBe(200)
    expect(titleProbes).toEqual([])
  })

  it('still lists a session whose log is gone, naming it by id', async () => {
    // The artifacts root is the source of truth for what EXISTS. A pruned,
    // archived or deleted session keeps its artifacts and must stay importable
    // even though no title can ever be resolved for it.
    titleProbes.length = 0
    const seam = seedRoot()
    const reply = await callRoute(captureLibraryRoute(seam), trustedRequest('/artifact/api/library'))
    const session = reply.body.sessions.find((s: any) => s.sessionId === 'session-other')
    expect(session).toBeDefined()
    expect(session.title).toBeUndefined()
    expect(titleProbes).toEqual([])
  })
})
