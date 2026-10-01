/*
 * The client half of the cross-session import: response parsing for the two
 * `/artifact/api/library` shapes.
 *
 * This parser is the trust boundary between the host route and the picker's
 * rendering, so the cases that matter are the MALFORMED ones: the route is
 * fenced and version-matched to this plugin, but a stale bundle talking to a
 * newer host (or the reverse) is a real deployment shape in this profile, where
 * the plugin is `file:`-linked and rebuilt constantly. A parser that trusted
 * the payload would render `undefined` in the UI; one that returns a reason
 * tells the user what happened.
 *
 * `fetch` is stubbed rather than the module, so the real request URL is also
 * asserted — the `currentSessionId` exclusion is what keeps the picker from
 * offering to import an artifact the user already has.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_IMPORT_VERSIONS,
  canvasBridge,
  fetchLibrary,
  fetchLibraryVersions,
  sessionDisplayTitle,
} from '../src/client/canvas/state.ts'
import { MAX_VERSIONS } from '../src/registry.ts'

/** Replace global fetch with a stub returning one JSON body. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }))
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchLibrary', () => {
  it('parses a well-formed listing', () => {
    stubFetch({
      ok: true,
      sessions: [{
        sessionId: 'session-old',
        artifacts: [{ artifactId: 'art-a', title: '图', versions: 3, bytes: 2048 }],
      }],
    })
    return expect(fetchLibrary('session-now')).resolves.toEqual({
      ok: true,
      sessions: [{
        sessionId: 'session-old',
        artifacts: [{ artifactId: 'art-a', title: '图', versions: 3, bytes: 2048 }],
      }],
    })
  })

  it('IGNORES a session title even if an older host sends one', async () => {
    // Forward/backward compatibility across the wire: session naming moved to
    // the client, so a title field from a stale host must not break parsing.
    stubFetch({ ok: true, sessions: [{ sessionId: 's', title: '旧字段', artifacts: [{ artifactId: 'a' }] }] })
    const result = await fetchLibrary(undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sessions[0]?.sessionId).toBe('s')
    expect(result.sessions[0]?.artifacts).toHaveLength(1)
  })

  it('excludes the CURRENT session through the query string', async () => {
    const spy = stubFetch({ ok: true, sessions: [] })
    await fetchLibrary('session-now')
    expect(String(spy.mock.calls[0]?.[0])).toContain('currentSessionId=session-now')
  })

  it('omits the query entirely when there is no current session yet', async () => {
    const spy = stubFetch({ ok: true, sessions: [] })
    await fetchLibrary(undefined)
    expect(String(spy.mock.calls[0]?.[0])).toBe('/artifact/api/library')
  })

  it('reports an HTTP failure as a reason instead of an empty library', async () => {
    stubFetch({}, { ok: false, status: 403 })
    const result = await fetchLibrary('s')
    expect(result.ok).toBe(false)
    // 403 is the honest answer here (the host half is not loaded / not
    // same-origin); rendering [] would read as "you have no other artifacts".
    if (!result.ok) expect(result.reason).toContain('403')
  })

  it('reports a network rejection as a reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const result = await fetchLibrary('s')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('boom')
  })

  it('rejects a body that is not the expected envelope', async () => {
    for (const body of [null, {}, { ok: false }, { ok: true }, { ok: true, sessions: 'x' }]) {
      stubFetch(body)
      const result = await fetchLibrary('s')
      expect(result.ok).toBe(false)
    }
  })

  it('skips malformed entries instead of failing the whole listing', async () => {
    stubFetch({
      ok: true,
      sessions: [
        null,
        { sessionId: 42, artifacts: [] },
        { sessionId: 'good', artifacts: [{ artifactId: 'art-1', versions: 1, bytes: 1 }] },
        { sessionId: 'empty', artifacts: [] },
      ],
    })
    const result = await fetchLibrary(undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A session with no usable artifacts is dropped, not rendered as an empty group.
    expect(result.sessions.map(s => s.sessionId)).toEqual(['good'])
  })

  it('defaults missing numeric fields instead of rendering undefined', async () => {
    stubFetch({ ok: true, sessions: [{ sessionId: 's', artifacts: [{ artifactId: 'a' }] }] })
    const result = await fetchLibrary(undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sessions[0]?.artifacts[0]).toMatchObject({ artifactId: 'a', versions: 1, bytes: 0 })
  })

  it('parses origin only when it is a complete pair', async () => {
    stubFetch({
      ok: true,
      sessions: [{
        sessionId: 's',
        artifacts: [
          { artifactId: 'complete', origin: { sessionId: 'x', artifactId: 'y' } },
          { artifactId: 'partial', origin: { sessionId: 'x' } },
        ],
      }],
    })
    const result = await fetchLibrary(undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const artifacts = result.sessions[0]?.artifacts ?? []
    expect(artifacts[0]?.origin).toEqual({ sessionId: 'x', artifactId: 'y' })
    expect(artifacts[1]?.origin).toBeUndefined()
  })
})

describe('fetchLibraryVersions', () => {
  it('parses a version list', async () => {
    stubFetch({ ok: true, artifact: { versions: [{ version: 1, time: 100, bytes: 10 }, { version: 2, time: 200, bytes: 20 }] } })
    await expect(fetchLibraryVersions('s', 'a')).resolves.toEqual({
      ok: true,
      versions: [{ version: 1, time: 100, bytes: 10 }, { version: 2, time: 200, bytes: 20 }],
    })
  })

  it('addresses the exact source session and artifact', async () => {
    const spy = stubFetch({ ok: true, artifact: { versions: [] } })
    await fetchLibraryVersions('session-a', 'art-b')
    const url = String(spy.mock.calls[0]?.[0])
    expect(url).toContain('sessionId=session-a')
    expect(url).toContain('artifactId=art-b')
  })

  it('skips entries with no numeric version', async () => {
    stubFetch({ ok: true, artifact: { versions: [{ version: 1 }, { time: 5 }, null, { version: 'x' }] } })
    const result = await fetchLibraryVersions('s', 'a')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.versions).toHaveLength(1)
    expect(result.versions[0]).toMatchObject({ version: 1, time: 0, bytes: 0 })
  })

  it('reports a missing artifact as a reason', async () => {
    stubFetch({}, { ok: false, status: 404 })
    const result = await fetchLibraryVersions('s', 'gone')
    expect(result.ok).toBe(false)
  })
})

describe('the import cap mirrors the host', () => {
  it('MAX_IMPORT_VERSIONS equals the store cap the host trims to', () => {
    // If these drift, the picker offers a selection the host silently truncates.
    expect(MAX_IMPORT_VERSIONS).toBe(MAX_VERSIONS)
  })
})

/*
 * The CLIENT-SIDE session-title join.
 *
 * Session naming moved out of the host deliberately: resolving a title means
 * folding that session's LOG, which measured 32.4s and +278 MB for one listing
 * on a real root. The client already holds every `displayTitle` in
 * `sessions.list`, so the name is a Map lookup here instead.
 *
 * This is also the only reason the host can stay title-free, so the join has to
 * be pinned: if it silently returned undefined, every picker row would show a
 * raw session id and the 32-second host fold would look like the only fix.
 */
describe('sessionDisplayTitle — the free client-side join', () => {
  /** Bind the bridge to a stand-in sessions service and return the disposer. */
  function bindWith(byId: Record<string, unknown>): () => void {
    canvasBridge.resetForTests()
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({ ids: Object.keys(byId), byId }),
          subscribe: () => () => {},
        },
      },
      get: () => undefined,
      on: () => () => {},
      effect: (fn: () => unknown) => (typeof fn === 'function' ? fn() : undefined),
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    }
    return canvasBridge.init(ctx as never)
  }

  it('reads displayTitle from the session list', () => {
    const dispose = bindWith({ 's-1': { id: 's-1', displayTitle: '斗地主静态原型画布设计' } })
    try {
      expect(sessionDisplayTitle('s-1')).toBe('斗地主静态原型画布设计')
    } finally { dispose() }
  })

  it('returns undefined for an unknown session, so the caller can fall back to the id', () => {
    const dispose = bindWith({ 's-1': { id: 's-1', displayTitle: '标题' } })
    try {
      expect(sessionDisplayTitle('missing')).toBeUndefined()
    } finally { dispose() }
  })

  it('returns undefined for a blank title rather than an empty label', () => {
    const dispose = bindWith({ 's-1': { id: 's-1', displayTitle: '' } })
    try {
      expect(sessionDisplayTitle('s-1')).toBeUndefined()
    } finally { dispose() }
  })

  it('tolerates a non-string displayTitle', () => {
    const dispose = bindWith({ 's-1': { id: 's-1', displayTitle: 42 } })
    try {
      expect(sessionDisplayTitle('s-1')).toBeUndefined()
    } finally { dispose() }
  })

  it('is safe before the bridge is bound (no service yet)', () => {
    canvasBridge.resetForTests()
    expect(sessionDisplayTitle('s-1')).toBeUndefined()
  })

  it('never throws when the list itself throws', () => {
    canvasBridge.resetForTests()
    const ctx = {
      sessions: { list: { getSnapshot: () => { throw new Error('boom') }, subscribe: () => () => {} } },
      get: () => undefined,
      on: () => () => {},
      effect: (fn: () => unknown) => (typeof fn === 'function' ? fn() : undefined),
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    }
    const dispose = canvasBridge.init(ctx as never)
    try {
      // A throwing list must degrade to "show the id", never break the picker.
      expect(sessionDisplayTitle('s-1')).toBeUndefined()
    } finally { dispose() }
  })
})
