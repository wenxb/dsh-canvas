/**
 * EVERY RETURNED VALUE, CHECKED AGAINST THE DECLARED OUTPUT SCHEMA.
 *
 * The output schema is `additionalProperties: false`, so a value that carries
 * ONE undeclared key fails the whole tool call at the harness boundary — the
 * side effect already happened, but the model only ever sees
 * `tool "artifact" returned invalid output: "value.versions" is not a declared
 * property`. That is how `history` and `import` shipped broken: their values
 * gained `sessionId`/`artifactId`/`versions` while the declaration kept only
 * the older field set, and nothing compared the two.
 *
 * `tool-surface.spec.ts` asserts the ops are DECLARED; this spec asserts the
 * declarations are TRUE, by driving every op and validating the value it
 * returns against `tool.output.schema` with the same subset the host enforces
 * (type / oneOf / properties / required / additionalProperties / items /
 * enum / const).
 * @module
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { ArtifactStore } from '../src/registry.ts'
import { makePersister } from '../src/persistence.ts'

interface SchemaNode {
  type?: string
  oneOf?: SchemaNode[]
  properties?: Record<string, SchemaNode>
  required?: boolean | readonly string[]
  additionalProperties?: boolean
  items?: SchemaNode
  enum?: readonly unknown[]
  const?: unknown
}

interface ToolDef {
  name: string
  output: { schema: SchemaNode }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Capture the registered `artifact` tool, as `tool-surface.spec.ts` does. */
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

/** What the host calls this value's type (integers are their own case). */
function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

const typeMatches = (value: unknown, type: string): boolean => {
  const kind = kindOf(value)
  return type === 'number' ? kind === 'number' || kind === 'integer' : kind === type
}

/**
 * Every way `value` breaks `node`, as host-style messages (empty = valid).
 *
 * Deliberately the same SUBSET the host validator accepts, so a schema using a
 * keyword the host rejects cannot pass here either.
 */
function violations(value: unknown, node: SchemaNode, path: string): string[] {
  if (Array.isArray(node.oneOf)) {
    const branches = node.oneOf.filter((branch) => violations(value, branch, path).length === 0)
    return branches.length === 1 ? [] : [`${path} must match exactly one oneOf branch (matched ${branches.length})`]
  }
  const found: string[] = []
  if (node.type !== undefined && !typeMatches(value, node.type)) {
    return [`${path} is not of type ${node.type} (got ${kindOf(value)})`]
  }
  if (node.enum !== undefined && !node.enum.includes(value)) found.push(`${path} is not one of its enum values`)
  if (node.const !== undefined && value !== node.const) found.push(`${path} is not const`)
  if (node.type === 'array' && Array.isArray(value) && node.items !== undefined) {
    value.forEach((item, index) => found.push(...violations(item, node.items!, `${path}[${index}]`)))
  }
  if (node.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const properties = node.properties ?? {}
    const record = value as Record<string, unknown>
    if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) found.push(`"${path}.${key}" is not a declared property (additionalProperties: false)`)
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(record, key)) {
        if (child.required === true) found.push(`"${path}.${key}" is required but absent`)
        continue
      }
      found.push(...violations(record[key], child, `${path}.${key}`))
    }
    if (Array.isArray(node.required)) {
      for (const key of node.required) {
        if (!Object.hasOwn(record, key)) found.push(`"${path}.${key}" is required but absent`)
      }
    }
  }
  return found
}

const CAP = 1 << 20

describe('the declared output schema describes what every op returns', () => {
  it('validates all twelve ops, including the imported/listed artifact that carries an origin', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-artifact-schema-'))
    // A SOURCE session on disk with two SAVED versions, so `library`, `history`
    // and `import` all have something real to report.
    const sourceSession = 'session-schema-source'
    const sourceStore = new ArtifactStore(makePersister(root, sourceSession))
    const sourceId = sourceStore.create('<h1>v1</h1>', '源画布', CAP, true)
    sourceStore.patch(sourceId, 'v1', 'v2', false, CAP)
    sourceStore.save(sourceId)

    const tool = captureTool(root)
    const exec = {
      agent: {
        session: {
          id: 'session-schema-current',
          header: { cwd: root },
          seq: 0,
          snapshotEvents: () => [],
        },
      },
    }

    /** Run one op and prove its value fits the declaration. */
    const check = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const value = await tool.execute(args, exec) as Record<string, unknown>
      expect(violations(value, tool.output.schema, 'value'), `op ${String(args.op)}`).toEqual([])
      return value
    }

    const created = await check({ op: 'create', html: '<h1>hi</h1>', title: 'demo' })
    const id = created.id as string
    await check({ op: 'patch', id, old_string: '<h1>hi</h1>', new_string: '<h2>hi</h2>' })
    await check({ op: 'save', id })
    await check({ op: 'revert', id, version: 1 })
    await check({ op: 'read', id })
    await check({ op: 'interactive', id, value: true })
    await check({ op: 'list' })
    await check({ op: 'export', id })

    // The cross-session trio: `history` reports the source's versions, `import`
    // the copy it made (count + origin breadcrumb), and `list` then carries the
    // imported artifact's `origin` object — the three shapes that drifted.
    await check({ op: 'library' })
    await check({ op: 'history', session_id: sourceSession, artifact_id: sourceId })
    const imported = await check({ op: 'import', session_id: sourceSession, artifact_id: sourceId, all_versions: true })
    const listed = await check({ op: 'list' })
    expect(listed.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: { sessionId: sourceSession, artifactId: sourceId } }),
    ]))
    await check({ op: 'destroy', id: imported.id })
  })

  it('catches an undeclared key, so the assertion cannot pass vacuously', () => {
    const schema: SchemaNode = {
      type: 'object',
      additionalProperties: false,
      properties: { op: { type: 'string', required: true } },
    }
    expect(violations({ op: 'history', versions: [1] }, schema, 'value')).toEqual([
      '"value.versions" is not a declared property (additionalProperties: false)',
    ])
    expect(violations({ op: 'history' }, schema, 'value')).toEqual([])
  })
})
