/*
 * `export` — the other direction of the cross-session feature.
 *
 * Import reads another session's artifact IN; export writes this session's
 * artifact OUT as a standalone .html file. The two share the `library`/version
 * vocabulary, so they are tested side by side.
 *
 * `export` is the one op that touches the user's workspace, so the properties
 * worth pinning are: which content it writes (working copy vs a named version),
 * that it never mutates the artifact, and that a title becomes a FILENAME a
 * human can recognize — including a CJK-only title, which an earlier ASCII-only
 * slug silently reduced to a meaningless fragment.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, exportFileName, slugifyTitle } from '../src/index.ts'

/** The tool definition the plugin registers, captured from a fake ctx. */
interface ToolLike {
  execute: (args: unknown, exec: { agent?: unknown }) => Promise<Record<string, unknown>>
}

function captureTool(): ToolLike {
  let captured: ToolLike | undefined
  const ctx = {
    tools: { register(definition: ToolLike) { captured = definition; return () => {} } },
    commands: { register: () => () => {} },
    webServer: { register: () => () => {} },
    effect: (fn: unknown) => (typeof fn === 'function' ? (fn as () => unknown)() : undefined),
    inject: () => () => {},
    get: () => undefined,
    on: () => () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  apply(ctx as never, { persistRoot: 'off' })
  if (captured === undefined) throw new Error('apply() registered no tool')
  return captured
}

let work: string | undefined

afterEach(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true })
  work = undefined
})

/** A tool bound to a fresh temp workspace, as the session cwd. */
function toolInFreshWorkspace(): { tool: ToolLike; exec: { agent: unknown }; dir: string } {
  work = mkdtempSync(join(tmpdir(), 'dsh-artifact-export-'))
  const exec = { agent: { session: { id: 'session-export', header: { cwd: work } } } }
  return { tool: captureTool(), exec, dir: work }
}

describe('slugifyTitle / exportFileName', () => {
  it('keeps a CJK title instead of reducing it to a stray fragment', () => {
    // The regression: an ASCII-only slug turned this into just `SVG`.
    expect(slugifyTitle('鹈鹕骑自行车 · SVG 动画')).toContain('鹈鹕骑自行车')
    expect(slugifyTitle('鹈鹕骑自行车 · SVG 动画')).toContain('SVG')
  })

  it('removes path separators and control codes', () => {
    expect(slugifyTitle('a/b\\c:d')).not.toMatch(/[/\\:]/)
    expect(slugifyTitle('evil\u0000name')).not.toMatch(/\u0000/)
    expect(slugifyTitle('../../etc/passwd')).not.toMatch(/[/\\]/)
  })

  it('collapses whitespace runs to single dashes and trims edge dashes', () => {
    expect(slugifyTitle('  hello   world  ')).toBe('hello-world')
  })

  it('returns empty for a title with no letters or digits, so the id is used', () => {
    expect(slugifyTitle('···')).toBe('')
    expect(slugifyTitle('   ')).toBe('')
    expect(slugifyTitle(undefined)).toBe('')
    expect(exportFileName('···', 'art-abc123', undefined)).toBe('art-abc123')
  })

  it('falls back to the artifact id when there is no title', () => {
    expect(exportFileName(undefined, 'art-abc123', undefined)).toBe('art-abc123')
  })

  it('appends the version only when one was named', () => {
    expect(exportFileName('demo', 'art-1', undefined)).toBe('demo')
    expect(exportFileName('demo', 'art-1', 3)).toBe('demo-v3')
  })

  it('never produces a traversing or empty stem', () => {
    for (const title of ['..', '../..', '/', '\\', '.', '...', 'a'.repeat(500)]) {
      const stem = exportFileName(title, 'art-fallback', undefined)
      expect(stem).not.toBe('')
      expect(stem).not.toContain('/')
      expect(stem).not.toContain('\\')
      expect(stem.length).toBeLessThanOrEqual(80)
    }
  })
})

describe('the export op', () => {
  it('writes the WORKING COPY by default and reports its real byte size', async () => {
    const { tool, exec, dir } = toolInFreshWorkspace()
    const created = await tool.execute({ op: 'create', html: '<h1>hi</h1>', title: 'demo' }, exec)
    // `patch` is a LITERAL string replacement, so the whole tag is replaced.
    await tool.execute({ op: 'patch', id: created.id, old_string: '<h1>hi</h1>', new_string: '<h2>hi</h2>' }, exec)
    const result = await tool.execute({ op: 'export', id: created.id }, exec)
    expect(result.path).toBe(join(dir, 'demo.html'))
    expect(existsSync(result.path as string)).toBe(true)
    // The working copy carries the unsaved patch.
    expect(readFileSync(result.path as string, 'utf-8')).toBe('<h2>hi</h2>')
    expect(result.bytes).toBe(Buffer.byteLength('<h2>hi</h2>', 'utf-8'))
  })

  it('writes a NAMED saved version when `version` is given', async () => {
    const { tool, exec, dir } = toolInFreshWorkspace()
    const created = await tool.execute({ op: 'create', html: '<p>v1</p>', title: 'demo' }, exec)
    await tool.execute({ op: 'patch', id: created.id, old_string: 'v1', new_string: 'v2' }, exec)
    // The patch is unsaved, so version 1 is still the original text.
    const result = await tool.execute({ op: 'export', id: created.id, version: 1 }, exec)
    expect(result.version).toBe(1)
    expect(result.path).toBe(join(dir, 'demo-v1.html'))
    expect(readFileSync(result.path as string, 'utf-8')).toBe('<p>v1</p>')
  })

  it('honours an explicit path and creates missing parent directories', async () => {
    const { tool, exec, dir } = toolInFreshWorkspace()
    const created = await tool.execute({ op: 'create', html: '<p>x</p>' }, exec)
    const result = await tool.execute({ op: 'export', id: created.id, path: 'nested/deep/out.html' }, exec)
    expect(result.path).toBe(join(dir, 'nested/deep/out.html'))
    expect(existsSync(result.path as string)).toBe(true)
  })

  it('is a pure READ: it does not bump any version, save, or dirty the working copy', async () => {
    const { tool, exec } = toolInFreshWorkspace()
    const created = await tool.execute({ op: 'create', html: '<p>v1</p>' }, exec)
    const before = await tool.execute({ op: 'read', id: created.id }, exec)
    await tool.execute({ op: 'export', id: created.id }, exec)
    const after = await tool.execute({ op: 'read', id: created.id }, exec)
    expect(after.html).toBe(before.html)
    expect(after.version).toBe(before.version)
  })

  it('overwrites a previous export rather than failing (re-export refreshes)', async () => {
    const { tool, exec } = toolInFreshWorkspace()
    const created = await tool.execute({ op: 'create', html: '<p>first</p>', title: 'demo' }, exec)
    const first = await tool.execute({ op: 'export', id: created.id }, exec)
    await tool.execute({ op: 'patch', id: created.id, old_string: 'first', new_string: 'second' }, exec)
    const second = await tool.execute({ op: 'export', id: created.id }, exec)
    expect(second.path).toBe(first.path)
    expect(readFileSync(second.path as string, 'utf-8')).toBe('<p>second</p>')
  })

  it('rejects a version that does not exist, naming the artifact', async () => {
    const { tool, exec } = toolInFreshWorkspace()
    const created = await tool.execute({ op: 'create', html: '<p>x</p>' }, exec)
    await expect(tool.execute({ op: 'export', id: created.id, version: 99 }, exec))
      .rejects.toThrow(/no saved/)
  })

  it('rejects a non-positive or fractional version', async () => {
    const { tool, exec } = toolInFreshWorkspace()
    const created = await tool.execute({ op: 'create', html: '<p>x</p>' }, exec)
    for (const version of [0, -1, 1.5]) {
      await expect(tool.execute({ op: 'export', id: created.id, version }, exec)).rejects.toThrow(/positive integer/)
    }
  })

  it('rejects an unknown artifact id', async () => {
    const { tool, exec } = toolInFreshWorkspace()
    await expect(tool.execute({ op: 'export', id: 'art-nope' }, exec)).rejects.toThrow()
  })

  it('writes the file once, at the reported size', async () => {
    const { tool, exec } = toolInFreshWorkspace()
    const created = await tool.execute({ op: 'create', html: '<p>measure me</p>', title: 'demo' }, exec)
    const result = await tool.execute({ op: 'export', id: created.id }, exec)
    expect(statSync(result.path as string).size).toBe(result.bytes)
  })
})