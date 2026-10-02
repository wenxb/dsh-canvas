/**
 * REPLAY WITHOUT STORED SOURCE.
 *
 * A patch no longer projects its resulting working copy into the log (measured:
 * 7.87 MB of one real 29.49 MB log for 139 patches whose ARGUMENTS were
 * 0.16 MB). The host must therefore rebuild the working copy by applying those
 * arguments to the reconstructed state — walking `tool/call` events for the
 * cause and `tool/result` events for the effect.
 *
 * These drive the REAL registered tool through a stand-in context and a
 * synthetic session log, because the part that can silently break is the
 * CORRELATION (call args → the right result meta by callId), not the arithmetic.
 * A unit test of the fold alone would stay green while the tool never passed the
 * arguments in at all — which is exactly the shape of the bug that made the
 * import ops uncallable.
 * @module
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { contentHash } from '../src/patch.ts'

interface ToolDef {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Capture the registered `artifact` tool. */
function captureTool(persistRoot: string): ToolDef {
  let captured: ToolDef | undefined
  const ctx = {
    tools: { register: (definition: ToolDef) => { captured = definition; return () => {} } },
    commands: { register: () => () => {} },
    webServer: { register: () => () => {} },
    effect: (fn: () => unknown) => (typeof fn === 'function' ? fn() : undefined),
    inject: (_deps: unknown, callback: (ctx: unknown) => void) => {
      callback({ skills: { register: () => () => {} } })
      return () => {}
    },
    get: () => undefined,
    on: () => () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  apply(ctx as never, { persistRoot })
  if (captured === undefined) throw new Error('the artifact tool did not register')
  return captured
}

/** One synthetic log event. */
type Event = { type: string; seq: number; data?: unknown }

const CREATE_HTML = '<body><h1>title</h1></body>'

/**
 * A synthetic session whose log carries a create, then a patch recorded the NEW
 * way: a `tool/call` with the arguments and a `tool/result` whose meta has NO
 * source, only a byte count and a fingerprint.
 */
function patchedLog(options: { withArgs?: boolean; hash?: string; toolName?: string } = {}): Event[] {
  // Defaults to the LEGACY name on purpose: every test in this file then doubles
  // as proof that a log written before the rename still replays.
  const toolName = options.toolName ?? 'artifact'
  const patched = '<body><h1>EDITED</h1></body>'
  const events: Event[] = [
    {
      type: 'tool/call', seq: 1,
      data: { callId: 'call-create', name: toolName, arguments: JSON.stringify({ op: 'create', html: CREATE_HTML, title: 'T' }) },
    },
    {
      type: 'tool/result', seq: 2,
      data: {
        meta: { op: 'create', id: 'art-a', version: 1, html: CREATE_HTML, title: 'T' },
        message: { toolCallId: 'call-create' },
      },
    },
  ]
  if (options.withArgs !== false) {
    events.push({
      type: 'tool/call', seq: 3,
      data: {
        callId: 'call-patch', name: toolName,
        arguments: JSON.stringify({ op: 'patch', id: 'art-a', old_string: '<h1>title</h1>', new_string: '<h1>EDITED</h1>' }),
      },
    })
  }
  events.push({
    type: 'tool/result', seq: 4,
    data: {
      // NO `html` — this is the whole point of the change.
      meta: { op: 'patch', id: 'art-a', version: 1, applied: 1, bytes: patched.length, hash: options.hash ?? contentHash(patched) },
      message: { toolCallId: 'call-patch' },
    },
  })
  return events
}

/**
 * Freeze a payload the way the host does: an event's `data` is NOT extensible, so
 * any code that assigns into a meta throws instead of silently succeeding.
 */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  for (const child of Object.values(value)) deepFreeze(child)
  Object.freeze(value)
}

/** The same log, with every event payload frozen as the real host delivers it. */
function frozenLog(events: Event[]): Event[] {
  for (const event of events) if (event.data !== undefined) deepFreeze(event.data)
  return events
}

/** Run one tool op against a synthetic session log. */
async function runWithLog(events: Event[], args: unknown): Promise<Record<string, unknown>> {
  root = mkdtempSync(join(tmpdir(), 'dsh-artifact-replay-'))
  const tool = captureTool(root)
  const agent = {
    session: {
      id: 'session-current',
      header: { cwd: process.cwd() },
      seq: events.length,
      snapshotEvents: () => events,
    },
  }
  return await tool.execute(args, { agent }) as Record<string, unknown>
}

describe('a log whose patch carries only its cause still replays', () => {
  it('replays even when the host FREEZES the event metas', async () => {
    // Regression: the cause used to be attached by ASSIGNING into the event meta.
    // The host freezes every event payload, so that threw
    //   "Cannot add property patch, object is not extensible"
    // and — because every replay-backed op walks this path — ONE patch in the log
    // broke read/save/revert/export/list/destroy for the whole session.
    const value = await runWithLog(frozenLog(patchedLog()), { op: 'read', id: 'art-a' })
    expect(value.html).toBe('<body><h1>EDITED</h1></body>')
  })

  it('replays the SAME log written under the CURRENT tool name', async () => {
    // Both names must resolve: the rename (artifact → canvas) cannot strand the
    // logs written on either side of it.
    const value = await runWithLog(patchedLog({ toolName: 'canvas' }), { op: 'read', id: 'art-a' })
    expect(value.html).toBe('<body><h1>EDITED</h1></body>')
  })

  it('reconstructs the PATCHED working copy from the tool call arguments', async () => {
    const value = await runWithLog(patchedLog(), { op: 'read', id: 'art-a' })
    // The store was built from the log alone (no disk cache in a fresh tmp dir).
    expect(value.html).toBe('<body><h1>EDITED</h1></body>')
  })

  it('leaves the UNPATCHED source when the call arguments are missing', async () => {
    // Without the cause there is nothing to reproduce from. The fold must flag
    // divergence and keep the last state, never invent content.
    const value = await runWithLog(patchedLog({ withArgs: false }), { op: 'read', id: 'art-a' })
    expect(value.html).toBe(CREATE_HTML)
  })

  it('adopts a diverged reconstruction when it is the ONLY copy', async () => {
    // With an empty store and no disk cache, a flagged reconstruction is still
    // the best information available — refusing it would leave nothing at all.
    const events = patchedLog()
    // Break the fingerprint so the fold flags divergence.
    ;(events[3]!.data as { meta: { hash: string } }).meta.hash = 'deadbeef'
    const value = await runWithLog(events, { op: 'read', id: 'art-a' })
    expect(value.html).toBe('<body><h1>EDITED</h1></body>')
  })

  it('a diverged reconstruction NEVER overwrites content we already hold', async () => {
    // This is the safety property the flag exists for: a best-effort rebuild
    // must not clobber real bytes (a live edit, or the disk cache).
    root = mkdtempSync(join(tmpdir(), 'dsh-artifact-replay-'))
    const tool = captureTool(root)
    let events = patchedLog()
    let logLength = 4
    const agent = {
      session: {
        id: 'session-current', header: { cwd: process.cwd() },
        get seq() { return logLength },
        snapshotEvents: () => events,
      },
    }
    // 1. A GOOD replay populates the store with the patched content.
    const good = await tool.execute({ op: 'read', id: 'art-a' }, { agent }) as Record<string, unknown>
    expect(good.html).toBe('<body><h1>EDITED</h1></body>')
    // 2. The log loses the patch's CAUSE, so the rebuild diverges and lands on
    //    the UNPATCHED create source — which is a DIFFERENT string from what the
    //    store holds. Without the guard this would overwrite the store and
    //    silently erase the patch.
    events = patchedLog({ withArgs: false })
    logLength = 8
    const after = await tool.execute({ op: 'read', id: 'art-a' }, { agent }) as Record<string, unknown>
    // The good content survives; the diverged rebuild is discarded.
    expect(after.html).toBe('<body><h1>EDITED</h1></body>')
  })

  it('still replays an OLD log that carries the post-patch source', async () => {
    // Backward compatibility: logs written before this change store the full
    // copy. They must keep working (and win over any arg replay).
    const patched = '<body><h1>LEGACY</h1></body>'
    const events: Event[] = [
      { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'artifact', arguments: JSON.stringify({ op: 'create', html: CREATE_HTML }) } },
      { type: 'tool/result', seq: 2, data: { meta: { op: 'create', id: 'art-a', version: 1, html: CREATE_HTML }, message: { toolCallId: 'c1' } } },
      { type: 'tool/result', seq: 3, data: { meta: { op: 'patch', id: 'art-a', version: 1, applied: 1, html: patched }, message: { toolCallId: 'gone' } } },
    ]
    const value = await runWithLog(events, { op: 'read', id: 'art-a' })
    expect(value.html).toBe(patched)
  })

  it('replays a SEQUENCE of arg-only patches in order', async () => {
    const patched = '<body><h1>C</h1></body>'
    const events: Event[] = [
      { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'artifact', arguments: JSON.stringify({ op: 'create', html: CREATE_HTML }) } },
      { type: 'tool/result', seq: 2, data: { meta: { op: 'create', id: 'art-a', version: 1, html: CREATE_HTML }, message: { toolCallId: 'c1' } } },
    ]
    const steps: [string, string][] = [['title', 'A'], ['A', 'B'], ['B', 'C']]
    let seq = 3
    for (const [from, to] of steps) {
      events.push({ type: 'tool/call', seq: seq++, data: { callId: `p-${to}`, name: 'artifact', arguments: JSON.stringify({ op: 'patch', id: 'art-a', old_string: `<h1>${from}</h1>`, new_string: `<h1>${to}</h1>` }) } })
      events.push({ type: 'tool/result', seq: seq++, data: { meta: { op: 'patch', id: 'art-a', version: 1, applied: 1 }, message: { toolCallId: `p-${to}` } } })
    }
    const value = await runWithLog(events, { op: 'read', id: 'art-a' })
    expect(value.html).toBe(patched)
  })

  it('ignores a tool call that is not ours', async () => {
    // Args from another tool must never be read as a patch.
    const events = patchedLog()
    events[2] = { type: 'tool/call', seq: 3, data: { callId: 'call-patch', name: 'bash', arguments: JSON.stringify({ op: 'patch', id: 'art-a', old_string: '<h1>title</h1>', new_string: '<h1>EDITED</h1>' }) } }
    const value = await runWithLog(events, { op: 'read', id: 'art-a' })
    expect(value.html).toBe(CREATE_HTML)
  })

  it('survives a malformed argument blob instead of failing the replay', async () => {
    const events = patchedLog()
    events[2] = { type: 'tool/call', seq: 3, data: { callId: 'call-patch', name: 'artifact', arguments: '{not json' } }
    const value = await runWithLog(events, { op: 'read', id: 'art-a' })
    expect(value.html).toBe(CREATE_HTML)
  })
})
