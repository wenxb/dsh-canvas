/**
 * Cross-side contracts. These exist because several invariants are shared
 * between the server half (src/registry.ts, src/persistence.ts) and the client
 * half (src/client/canvas/scan.ts, src/client/contract.ts) with no compile-time
 * link — a divergence is silent until a user hits it.
 */
import { describe, expect, it } from 'vitest'
import { ArtifactStore, MAX_VERSIONS, rebuildFromMetas } from '../src/registry.ts'
import { persistDirFor } from '../src/persistence.ts'
import { MAX_CLIENT_VERSIONS, buildTimelines, scanArtifactEntries } from '../src/client/canvas/scan.ts'

const CAP = 1 << 20

/*
 * F5 — the version cap must agree. The server trims at MAX_VERSIONS on save;
 * the client rebuilds from the untrimmed log. If they drift, the canvas lists
 * a version the server already discarded and 回退 fails with
 * UnknownVersionError — with no runtime signal beforehand.
 */
describe('version-cap parity between server and client', () => {
  it('the client cap equals the server cap', () => {
    expect(MAX_CLIENT_VERSIONS).toBe(MAX_VERSIONS)
  })

  it('the server keeps exactly MAX_VERSIONS after exceeding it', () => {
    const store = new ArtifactStore()
    const id = store.create('<p>v1</p>', undefined, CAP)
    for (let n = 2; n <= MAX_VERSIONS + 5; n += 1) {
      store.patch(id, `v${n - 1}`, `v${n}`, false, CAP)
      store.save(id)
    }
    const versions = store.versionsOf(id).map(entry => entry.version)
    expect(versions).toHaveLength(MAX_VERSIONS)
    // The OLDEST are the ones dropped: the newest save survives.
    expect(versions[versions.length - 1]).toBe(MAX_VERSIONS + 5)
    expect(versions[0]).toBe(6)
  })

  it('the client timeline presents the same version set as the server', () => {
    // Drive a real store through the same ops, then fold the equivalent log
    // metas through the client's reconstruction — the two must agree on both
    // the count and the surviving version numbers.
    const store = new ArtifactStore()
    const id = store.create('<p>v1</p>', 'T', CAP)
    const metas: any[] = [{ op: 'create', id, html: '<p>v1</p>', version: 1, title: 'T' }]
    for (let n = 2; n <= MAX_VERSIONS + 5; n += 1) {
      store.patch(id, `v${n - 1}`, `v${n}`, false, CAP)
      store.save(id)
      metas.push({ op: 'patch', id, html: `<p>v${n}</p>` })
      metas.push({ op: 'save', id, html: `<p>v${n}</p>`, version: n })
    }
    const serverVersions = store.versionsOf(id).map(entry => entry.version)

    const nodes = metas.map((meta, index) => ({
      kind: 'tool-result', seq: index + 1, time: index, callId: `c${index}`, meta,
    }))
    const clientVersions = buildTimelines(scanArtifactEntries(nodes))
      .get(id)!.checkpoints.map(checkpoint => checkpoint.version)

    expect(clientVersions).toEqual(serverVersions)
  })
})

/*
 * F9 — the on-disk directory name must survive a round trip. The reverse
 * direction is what matters: a consumer holding a directory name (or a session
 * id read back from disk) has to get the same session's directory again, or
 * cross-session lookup silently finds nothing.
 */
describe('persistDirFor round-trip', () => {
  it('is idempotent for a real session id', () => {
    const root = '/tmp/root'
    const sessionId = 'session-71109b7e-2710-43a4-8ff2-7ae87c30f181'
    const dir = persistDirFor(root, sessionId)
    expect(dir).toBe(`${root}/${sessionId}`)
  })

  it('maps two distinct session ids to two distinct directories', () => {
    const ids = [
      'session-5bf00dc5-1111-2222-3333-444444444444',
      'session-5e3ffb87-5555-6666-7777-888888888888',
      '5bf00dc5-1111-2222-3333-444444444444',
    ]
    const dirs = ids.map(id => persistDirFor('/tmp/root', id))
    expect(new Set(dirs).size).toBe(ids.length)
  })

  it('sanitizes separators so a hostile id cannot escape the root', () => {
    // A session id containing path separators or ".." must not traverse. Note the
    // assertion is CONTAINMENT, not "contains no dots": `../../etc/passwd`
    // legitimately becomes the child name `.._.._etc_passwd`, which is inside
    // the root and harmless. What would be dangerous is resolving outside the
    // root, or ending on a bare `.`/`..` segment.
    const dir = persistDirFor('/tmp/root', '../../etc/passwd')
    expect(dir.startsWith('/tmp/root/')).toBe(true)
    expect(dir).not.toContain('/etc/passwd')
    expect(dir.split('/').pop()).toBe('.._.._etc_passwd')
  })

  it('reports the sanitized name, which is the value a consumer must key on', () => {
    // Consumers that read directory names back off disk see the SANITIZED form.
    // For every id shape this plugin has produced the two are identical, so a
    // consumer may use either — this test pins that they agree.
    for (const id of ['session-abc', 'session-ABC_1.2-3', 'plainid']) {
      const dir = persistDirFor('/tmp/root', id)
      expect(dir).toBe(`/tmp/root/${id}`)
    }
  })
})

/*
 * Legacy meta shapes must keep folding. Older sessions carry a `revision`
 * field instead of `version`, may omit the create meta entirely, and may mark
 * a `read` as truncated. Dropping any of these would make an existing user's
 * canvas vanish after an upgrade.
 */
describe('legacy meta compatibility in rebuildFromMetas', () => {
  it('accepts revision in place of version', () => {
    const states = rebuildFromMetas([
      { op: 'create', id: 'art-x', html: '<p>a</p>', revision: 1 } as any,
      { op: 'patch', id: 'art-x', html: '<p>b</p>', revision: 2 } as any,
    ])
    const snapshot = states.get('art-x')!
    expect(snapshot.html).toBe('<p>b</p>')
  })

  it('bootstraps from the first html-bearing meta when create is missing', () => {
    // A forked/pruned log may start mid-history.
    const states = rebuildFromMetas([
      { op: 'patch', id: 'art-y', html: '<p>tail</p>' } as any,
    ])
    expect(states.get('art-y')?.html).toBe('<p>tail</p>')
  })

  it('ignores a truncated read (it carries partial html, not state)', () => {
    const truncated = rebuildFromMetas([
      { op: 'create', id: 'art-z', html: '<p>full</p>', version: 1 } as any,
      { op: 'read', id: 'art-z', html: '<p>f', truncated: true } as any,
    ])
    expect(truncated.get('art-z')?.html).toBe('<p>full</p>')
  })

  it('re-materializes a revert target missing from the log (forked session)', () => {
    const states = rebuildFromMetas([
      { op: 'create', id: 'art-w', html: '<p>v1</p>', version: 1 } as any,
      { op: 'revert', id: 'art-w', html: '<p>v7</p>', version: 7 } as any,
    ])
    const versions = states.get('art-w')!.versions.map(entry => entry.version)
    expect(versions).toContain(7)
  })
})
/*
 * Traversal safety. Found by writing the round-trip contract above: `.` is a
 * legal id character (session ids contain dots), so a bare `..` survived the
 * character filter and `join(root, '..')` resolved OUTSIDE the artifacts root.
 * A session id reaching this from a log, a CLI flag or a URL could therefore
 * have pointed the plugin's persistence at an arbitrary directory.
 */
describe('persistDirFor traversal safety', () => {
  const cases = ['..', '.', '...', '....', '../..', './..']
  it('never returns a directory outside the root', () => {
    for (const id of cases) {
      const dir = persistDirFor('/tmp/root', id)
      expect(dir.startsWith('/tmp/root/')).toBe(true)
    }
  })
  it('never returns the root itself (which would alias the whole store)', () => {
    for (const id of cases) {
      expect(persistDirFor('/tmp/root', id)).not.toBe('/tmp/root')
    }
  })
  it('still round-trips real ids unchanged', () => {
    expect(persistDirFor('/tmp/root', 'session-abc-123')).toBe('/tmp/root/session-abc-123')
    expect(persistDirFor('/tmp/root', '5bf00dc5-1111-2222-3333-444444444444'))
      .toBe('/tmp/root/5bf00dc5-1111-2222-3333-444444444444')
  })
  it('gives every all-dots variant the same placeholder, not the root', () => {
    expect(persistDirFor('/tmp/root', '..')).toBe('/tmp/root/unknown-session')
    expect(persistDirFor('/tmp/root', '.')).toBe('/tmp/root/unknown-session')
  })
})
