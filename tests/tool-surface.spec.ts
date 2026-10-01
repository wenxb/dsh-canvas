/*
 * THE TOOL-SURFACE CONTRACT.
 *
 * This file exists because of a real, shipped bug: `library`, `history` and
 * `import` were implemented in `execute`, declared in the output schema, and
 * rendered in the result text — but MISSING from the `op` parameter's `enum`.
 * A tool argument outside a declared enum is rejected by schema validation
 * before `execute` ever runs, so the entire cross-session import feature was
 * uncallable by the model while every unit test stayed green (no test imported
 * `index.ts` at all).
 *
 * The lesson is not "add the three ops to the enum" — it is that a hand-typed
 * op list in four places WILL drift. So this test drives the REAL registered
 * tool definition through a stand-in `ctx` and pins every op surface to the
 * single `ARTIFACT_OPS` source.
 */
import { describe, expect, it } from 'vitest'
import { ARTIFACT_OPS, apply, presentCallForArtifact } from '../src/index.ts'
import { contentHash } from '../src/patch.ts'

/**
 * A realistic working copy. Real artifacts in the observed data run 15-150 KB
 * (the largest single artifact on disk was 149124 bytes), and it is their SIZE
 * that made per-patch re-projection expensive.
 */
const FULL = `<body>${'<p>content</p>'.repeat(2000)}</body>`

/** One JSON-Schema property, as `defineTool` normalizes it. */
interface SchemaProperty {
  type?: string
  enum?: readonly string[]
  description?: string
}

/** The tool definition the plugin hands to `ctx.tools.register`, post-normalization. */
interface CapturedTool {
  name: string
  description: string
  parameters: { type: string; properties: Record<string, SchemaProperty>; required: readonly string[] }
  output: {
    schema: { properties: Record<string, SchemaProperty> }
    presentationMeta?: (args: unknown, value: unknown) => unknown
  }
  presentCall?: (args: unknown) => unknown
}

/**
 * Run `apply()` against a minimal fake context and capture the registration.
 * Only the three injected services are stubbed; `webServer.register` and
 * `commands.register` are recorded and ignored.
 */
function captureArtifactTool(): CapturedTool {
  let captured: CapturedTool | undefined
  const ctx = {
    tools: {
      register(definition: CapturedTool) {
        captured = definition
        return () => {}
      },
    },
    commands: { register: () => () => {} },
    webServer: { register: () => () => {} },
    effect: (fn: () => unknown) => (typeof fn === 'function' ? fn() : undefined),
    // `skills` is an OPTIONAL injection: the callback runs only when the service
    // exists. Stubbed here so `apply()` completes; the skill itself is covered
    // in tests/skill.spec.ts.
    inject: (_deps: unknown, callback: (ctx: unknown) => void) => {
      callback({ skills: { register: () => () => {} } })
      return () => {}
    },
    get: () => undefined,
    on: () => () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  apply(ctx as never, { persistRoot: 'off' })
  if (captured === undefined) throw new Error('apply() registered no tool')
  return captured
}

describe('artifact tool surface — every op is reachable', () => {
  const tool = captureArtifactTool()

  it('registers exactly one tool named `artifact`', () => {
    expect(tool.name).toBe('artifact')
  })

  it('the input `op` enum is exactly ARTIFACT_OPS (the bug that shipped)', () => {
    // The original defect: this enum listed 8 ops while ARTIFACT_OPS had 11.
    expect(tool.parameters.properties.op?.enum).toEqual([...ARTIFACT_OPS])
  })

  it('the output `op` enum is exactly ARTIFACT_OPS', () => {
    expect(tool.output.schema.properties.op?.enum).toEqual([...ARTIFACT_OPS])
  })

  it('every op has a pending-call card (a missing one renders no card at all)', () => {
    const missing = ARTIFACT_OPS.filter(op => presentCallForArtifact({ op }) === undefined)
    expect(missing).toEqual([])
  })

  it('every op in the enum is also accepted by ARTIFACT_OPS (no extras on either side)', () => {
    const declared = tool.parameters.properties.op?.enum ?? []
    expect([...declared].sort()).toEqual([...ARTIFACT_OPS].sort())
  })

  it('the description enumerates every op it accepts', () => {
    // The enum is the machine contract; the description is the model's only
    // prose guide to it. A silently missing name there costs a tool call.
    // Only the first sentence ("The operation: a | b | c.") is the enumeration;
    // the prose after it explains a few ops without listing them all.
    const description = tool.parameters.properties.op?.description ?? ''
    const sentence = /The operation:\s*([^.]*)\./.exec(description)?.[1] ?? ''
    expect(sentence.split(/\s*\|\s*/).map(token => token.trim())).toEqual([...ARTIFACT_OPS])
  })

  it('covers the cross-session ops the bug made unreachable', () => {
    for (const op of ['library', 'history', 'import', 'export'] as const) {
      expect(tool.parameters.properties.op?.enum).toContain(op)
      expect(presentCallForArtifact({ op })).toBeDefined()
    }
  })
})

describe('presentCallForArtifact', () => {
  it('returns undefined rather than a card for a non-artifact shape', () => {
    expect(presentCallForArtifact(undefined)).toBeUndefined()
    expect(presentCallForArtifact({})).toBeUndefined()
    expect(presentCallForArtifact({ op: 'nope' })).toBeUndefined()
  })

  it('carries the patch target as rawInput so the row can show the old text', () => {
    expect(presentCallForArtifact({ op: 'patch', id: 'art-1', old_string: '<p>x</p>' }))
      .toMatchObject({ card: 'generic', kind: 'edit', rawInput: '<p>x</p>' })
  })

  it('names the source session on an import card', () => {
    const card = presentCallForArtifact({ op: 'import', session_id: 's-9', artifact_id: 'art-2' })
    expect(card?.title).toContain('s-9/art-2')
  })
})
/*
 * THE LOG-BUDGET CONTRACT.
 *
 * `presentationMeta` is what actually enters the session log (it rides the
 * tool-result event as `data.meta`). A `patch` used to project the FULL
 * resulting working copy: 7.87 MB of one real 29.49 MB log across 139 patches,
 * while the same patches' tool-call ARGUMENTS — also in the log — were 0.16 MB.
 *
 * WHERE THE COST ACTUALLY IS, measured rather than assumed: NOT on disk (zstd
 * with a large window dedupes the near-identical copies; recompressing with and
 * without them moved the file ~0%), but in MEMORY — 193.4 MB of heap to parse
 * the events with the copies, 152.7 MB without (40.7 MB / 21% on a heavy
 * session). So these tests pin the projection shape that avoids the heap cost.
 *
 * These tests pin the shape that fixes it, because the failure mode is silent:
 * re-adding `html` here costs megabytes per session and NOTHING else breaks.
 * The replay path is covered in tests/replay-args.spec.ts.
 */
describe('a patch does not project its resulting source into the log', () => {
  const TOOL = captureArtifactTool()
  const project = (): Record<string, unknown> =>
    TOOL.output.presentationMeta?.({}, { op: 'patch', id: 'art-a', version: 1, html: FULL, applied: 2 }) as Record<string, unknown>

  it('omits html entirely', () => {
    // The whole point: no copy of the working copy in the event.
    expect(project()).not.toHaveProperty('html')
  })

  it('still keeps everything a replay and the card need', () => {
    const meta = project()
    expect(meta.op).toBe('patch')
    expect(meta.id).toBe('art-a')
    expect(meta.version).toBe(1)
    expect(meta.applied).toBe(2)
  })

  it('carries a byte count and a fingerprint so the reproduction is verifiable', () => {
    const meta = project()
    // Without the fingerprint a replay could silently rebuild the WRONG
    // working copy; with it, divergence is detectable.
    expect(meta.bytes).toBe(new TextEncoder().encode(FULL).byteLength)
    expect(meta.hash).toBe(contentHash(FULL))
    expect(typeof meta.hash).toBe('string')
  })

  it('is a negligible fraction of the source it no longer repeats', () => {
    const projected = JSON.stringify(project()).length
    // Against a realistic artifact the meta is ~0.2% of the source. Pinned as a
    // ratio, not a byte count, so a future field addition is caught if it grows
    // the meta out of proportion.
    expect(projected).toBeLessThan(200)
    expect(projected * 100).toBeLessThan(FULL.length)
    // Sanity-check the fixture itself: if FULL ever shrinks to a toy size this
    // ratio assertion stops meaning anything.
    expect(FULL.length).toBeGreaterThan(10_000)
  })

  it('still projects SOURCE for the ops where the source IS the state', () => {
    // create/save/revert remain the log's content checkpoints: dropping their
    // html would make the artifact unreconstructable.
    for (const op of ['create', 'save', 'revert'] as const) {
      const meta = TOOL.output.presentationMeta?.({}, { op, id: 'art-a', version: 1, html: '<p>x</p>', title: 'T' }) as Record<string, unknown>
      expect(meta.html).toBe('<p>x</p>')
    }
  })
})
