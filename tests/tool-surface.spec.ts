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
  output: { schema: { properties: Record<string, SchemaProperty> } }
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