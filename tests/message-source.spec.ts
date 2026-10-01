/*
 * THE PRODUCER-OWNED SOURCE CONTRACT.
 *
 * This file exists because of a shipped failure live verification caught: the
 * canvas commands that wake the model built their message source as the RETIRED
 * V3 wrapper
 *
 *     { kind: 'plugin', plugin: name, form: 'notice', summary }
 *
 * which only the log MIGRATOR accepts. A newly appended event goes through
 * `assertV4MessageSources`, whose validator rejects `kind === 'plugin'`:
 *
 *     format v4 message requires a producer-owned source kind
 *
 * The append threw, the followup never reached the model, and the turn died as
 * "本轮运行失败" — so an interaction submission or an import silently lost its
 * model notification. Both commands had it; NOTHING in the suite could see it,
 * because no test had ever constructed the message the command actually sends.
 *
 * The validation rules below are copied from the host's own implementation
 * (dsh-session-format-v3-to-v4/lib/index.js `source()` and
 * `producerKind()`) so this test fails the same way the host does, rather than
 * asserting a shape we merely believe is right.
 */
import { describe, expect, it } from 'vitest'
import { NOTICE_SOURCE_KIND, artifactNoticeSource } from '../src/message-source.ts'

/** The host's `source()` validator, transcribed from the package. */
function assertProducerOwnedSource(value: unknown): void {
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)
  if (!isObject) throw new Error('format v4 message requires a producer-owned source kind')
  const kind = (value as { kind?: unknown }).kind
  if (typeof kind !== 'string' || kind.length === 0 || kind === 'plugin') {
    throw new Error('format v4 message requires a producer-owned source kind')
  }
}

/** The host's `producerKind()`, transcribed (external plugin → `plugin:<pkg>`). */
function producerKind(plugin: string): string {
  const renamed: Record<string, string> = {
    '@deepseek-ai/dsh-system-prompt': 'system-prompt',
  }
  return renamed[plugin] ?? `plugin:${plugin}`
}

const PACKAGE_NAME = '@dsh-external/dsh-html-artifact'

describe('the artifact notice source is accepted by the native validator', () => {
  it('passes the producer-owned check that the retired wrapper failed', () => {
    // The regression, stated directly: this is the exact call the command makes.
    expect(() => assertProducerOwnedSource(artifactNoticeSource('导入 art-x → art-y'))).not.toThrow()
  })

  it('FAILS for the shape that shipped, so the guard is real', () => {
    // Falsification baked into the suite: if someone reintroduces the V3
    // wrapper, this proves the validator would reject it.
    expect(() => assertProducerOwnedSource({ kind: 'plugin', plugin: PACKAGE_NAME, form: 'notice', summary: 'x' }))
      .toThrow('producer-owned source kind')
  })

  it('uses the SAME kind the migrator produces for this package', () => {
    // Old messages migrated out of V3 and new ones must share one kind, or a
    // consumer grouping by kind sees two producers for one plugin.
    expect(NOTICE_SOURCE_KIND).toBe(producerKind(PACKAGE_NAME))
  })

  it('declares the notice form, the documented shape for a one-off account', () => {
    expect(artifactNoticeSource('x').form).toBe('notice')
  })

  it('bounds the summary to the host limit', () => {
    // Producers commit the summary to the durable log; the host ellipsizes past
    // 120 chars, so an unbounded one would be truncated by someone else.
    const long = 'x'.repeat(500)
    const summary = artifactNoticeSource(long).summary
    expect(summary.length).toBeLessThanOrEqual(120)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('leaves a short summary untouched', () => {
    expect(artifactNoticeSource('导入 art-x → art-y').summary).toBe('导入 art-x → art-y')
  })

  it('keeps a summary of exactly the limit intact', () => {
    const exact = 'x'.repeat(120)
    expect(artifactNoticeSource(exact).summary).toBe(exact)
  })

  it('is a plain JSON object, so it survives the durable log', () => {
    const source = artifactNoticeSource('导入 art-x → art-y')
    expect(JSON.parse(JSON.stringify(source))).toEqual(source)
    // No `plugin` field: that key belongs to the retired syntax.
    expect(Object.keys(source).sort()).toEqual(['form', 'kind', 'summary'])
  })
})

/*
 * The COMMANDS' side of the contract: the real registered handlers must send a
 * source the host accepts. Pinning `artifactNoticeSource` alone would not catch
 * a command that builds its own message inline — which is exactly how the
 * original defect shipped in TWO places.
 *
 * These drive the handlers captured out of `apply()`, so the assertion covers
 * the shipped command, not a reconstruction of it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { apply } from '../src/index.ts'

interface CapturedCommand {
  name: string
  handler: (invocation: unknown) => unknown
}

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Capture the registered slash commands from the real `apply()`. */
function captureCommands(persistRoot: string): Map<string, CapturedCommand> {
  const commands = new Map<string, CapturedCommand>()
  const ctx = {
    tools: { register: () => () => {} },
    commands: {
      register(definition: CapturedCommand) {
        commands.set(definition.name, definition)
        return () => {}
      },
    },
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
  return commands
}

/** Run a command handler with a recording agent and return what it appended. */
async function runCommand(
  commands: Map<string, CapturedCommand>,
  name: string,
  rawInput: string,
): Promise<{ messages: unknown[]; result: unknown }> {
  const messages: unknown[] = []
  const agent = {
    session: { id: 'session-current', header: { cwd: process.cwd() } },
    followup: (message: unknown) => { messages.push(message) },
  }
  const handler = commands.get(name)
  if (handler === undefined) throw new Error(`command ${name} was not registered`)
  const result = await handler.handler({ rawInput, agent })
  return { messages, result }
}

/** A seeded artifacts root with one other session's artifact. */
function seedOtherSession(): string {
  root = mkdtempSync(join(tmpdir(), 'dsh-artifact-src-'))
  const dir = join(root, 'session-other')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'art-x.html'), '<p>x</p>')
  writeFileSync(join(dir, 'art-x.json'), JSON.stringify({ id: 'art-x', versions: [] }))
  return root
}

describe('the registered commands send a host-accepted source', () => {
  it('/artifact-import wakes the model with a producer-owned source', async () => {
    const seam = seedOtherSession()
    const { messages, result } = await runCommand(
      captureCommands(seam), 'artifact-import',
      JSON.stringify({ sessionId: 'session-other', artifactId: 'art-x' }),
    )
    expect((result as { kind: string }).kind).toBe('success')
    expect(messages).toHaveLength(1)
    const source = (messages[0] as { source: unknown }).source
    // THE REGRESSION: this is what threw at append time and killed the turn.
    expect(() => assertProducerOwnedSource(source)).not.toThrow()
    expect((source as { kind: string }).kind).toBe(NOTICE_SOURCE_KIND)
  })

  it('/artifact-import names the NEW id in the notice, so the model patches the right artifact', async () => {
    const seam = seedOtherSession()
    const { messages } = await runCommand(
      captureCommands(seam), 'artifact-import',
      JSON.stringify({ sessionId: 'session-other', artifactId: 'art-x' }),
    )
    const summary = (messages[0] as { source: { summary: string } }).source.summary
    expect(summary).toContain('art-x')
    // The minted id appears too — without it the model would keep using the
    // source id and patch an artifact in the wrong session.
    const minted = /→ (art-[a-z0-9]+)/.exec(summary)?.[1]
    expect(minted).toBeDefined()
  })

  it('/artifact-submit sends an accepted source too (the same latent defect)', async () => {
    // This command had the identical retired wrapper and had never been
    // exercised with a real model turn.
    const commands = captureCommands('off')
    const { messages, result } = await runCommand(
      commands, 'artifact-submit',
      JSON.stringify({ id: 'art-x', title: 't', data: { fields: { name: 'a' } } }),
    )
    expect((result as { kind: string }).kind).toBe('success')
    expect(messages).toHaveLength(1)
    expect(() => assertProducerOwnedSource((messages[0] as { source: unknown }).source)).not.toThrow()
  })
})
