/*
 * N7 — the tool description's CONDITIONAL guidance, as a lazily-loaded skill.
 *
 * The measurement this file pins is a PROMPT BUDGET, so it is asserted rather
 * than described: the `artifact` tool description is sent on every request in
 * every session, while a skill body costs tokens only when the model loads it.
 * Before the split the description carried 3402 characters of always-on text,
 * most of it about interaction data and post-render delivery — guidance that
 * matters only for an interactive artifact, or right after one renders.
 *
 * The split rule the tests enforce: anything needed to CALL the tool stays in
 * the description; situation-specific procedure moves to the skill. A skill
 * body is opt-in, so a rule the model must follow WHILE calling the tool cannot
 * live there.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import {
  ARTIFACT_SKILL_BODY,
  ARTIFACT_SKILL_DESCRIPTION,
  ARTIFACT_SKILL_NAME,
  ARTIFACT_SKILL_SOURCE,
  ARTIFACT_SKILL_WHEN_TO_USE,
} from '../src/skill.ts'

interface CapturedSkill {
  name: string
  description: string
  whenToUse: string
  source: string
  content: string
}

/** Capture both registrations from one `apply()` against a stand-in context. */
function capture(): { tool: { description: string; parameters: { properties: Record<string, { description?: string }> } }; skill: CapturedSkill | undefined } {
  let tool: never | undefined
  let skill: CapturedSkill | undefined
  const stub = {
    tools: { register(definition: never) { tool = definition; return () => {} } },
    commands: { register: () => () => {} },
    webServer: { register: () => () => {} },
    effect: (fn: unknown) => (typeof fn === 'function' ? (fn as () => unknown)() : undefined),
    inject: (_deps: unknown, callback: (ctx: unknown) => void) => {
      callback({ skills: { register: (definition: CapturedSkill) => { skill = definition; return () => {} } } })
      return () => {}
    },
    get: () => undefined,
    on: () => () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  apply(stub as never, { persistRoot: 'off' })
  if (tool === undefined) throw new Error('apply() registered no tool')
  return { tool, skill }
}

describe('the conditional guidance was actually moved out of the description', () => {
  it('registers the skill with the loader-facing metadata', () => {
    const { skill } = capture()
    expect(skill?.name).toBe(ARTIFACT_SKILL_NAME)
    expect(skill?.source).toBe(ARTIFACT_SKILL_SOURCE)
    expect(skill?.description).toBe(ARTIFACT_SKILL_DESCRIPTION)
    expect(skill?.whenToUse).toBe(ARTIFACT_SKILL_WHEN_TO_USE)
    expect(skill?.content).toBe(ARTIFACT_SKILL_BODY)
  })

  it('uses a valid kebab-case skill name (the registry grammar)', () => {
    expect(ARTIFACT_SKILL_NAME).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('keeps the always-on description under a budget, and much smaller than before', () => {
    const { tool } = capture()
    // The pre-split description was 3402 characters. A regression that moves the
    // protocol text back inline would blow straight past this.
    expect(tool.description.length).toBeLessThan(2000)
  })

  it('the skill body is where the token savings came from (it is NOT small)', () => {
    // Sanity check on the premise: if the deferred body were tiny, the split
    // would be pointless complexity.
    expect(ARTIFACT_SKILL_BODY.length).toBeGreaterThan(1000)
  })

  it('points the model at the skill by name', () => {
    const { tool } = capture()
    expect(tool.description).toContain(ARTIFACT_SKILL_NAME)
    expect(tool.description).toContain('skill')
  })

  it('the moved text is really only in the skill body, not duplicated inline', () => {
    const { tool } = capture()
    for (const marker of ['__dshArtifactData', 'data-artifact-submit']) {
      expect(ARTIFACT_SKILL_BODY).toContain(marker)
      expect(tool.description).not.toContain(marker)
    }
  })
})

describe('what deliberately stayed inline (needed to CALL the tool)', () => {
  it('keeps the explicit-versioning model and the per-round save rule', () => {
    const { tool } = capture()
    // These must NOT be deferred: they govern how the tool is used on the very
    // call being made, and a skill body is only loaded on request.
    expect(tool.description).toContain('WORKFLOW RULE')
    expect(tool.description).toContain('save')
    expect(tool.description).toContain('版本')
  })

  it('keeps the read-only-files warning, which prevents real data loss', () => {
    const { tool } = capture()
    expect(tool.description).toContain('READ-ONLY')
  })

  it('keeps every op on the op parameter', () => {
    const { tool } = capture()
    const listed = Object.keys(tool.parameters.properties)
    for (const param of ['op', 'id', 'session_id', 'artifact_id', 'path']) {
      expect(listed).toContain(param)
    }
  })
})

describe('the skill file stays consistent with the module it documents', () => {
  it('src/skill.ts is where the body lives (so the guidance is reviewable)', () => {
    const source = readFileSync(new URL('../src/skill.ts', import.meta.url), 'utf-8')
    expect(source).toContain(ARTIFACT_SKILL_NAME)
    expect(source).toContain('__dshArtifactData')
  })

  it('documents why the skill must not be declared deferLoading', () => {
    // The rule that makes this design safe: a deferred declaration does not
    // activate anything, so marking this skill deferred would silently drop the
    // guidance instead of deferring it.
    const source = readFileSync(new URL('../src/skill.ts', import.meta.url), 'utf-8')
    expect(source).toContain('deferLoading')
  })
})
