/**
 * The `artifact` tool's CONDITIONAL guidance, as a lazily-loaded skill.
 *
 * WHY THIS IS A SKILL AND NOT TOOL-DESCRIPTION TEXT: the tool description is
 * sent on EVERY request in EVERY session, whether or not the model is making an
 * artifact. The two long passages below are needed only in narrow situations —
 * one when an artifact carries interaction state, one right after an artifact
 * renders. Keeping them inline cost ~2000 characters of first-turn prompt on
 * every single request, for guidance most turns never use.
 *
 * WHAT DELIBERATELY STAYED INLINE: everything needed to call the tool at all —
 * the op vocabulary, the explicit-versioning model, the save-once-per-round
 * workflow rule, the read-only-files warning. A skill body is only loaded when
 * the model asks for it, so moving a rule the model must follow *while* calling
 * the tool would turn a guaranteed instruction into an optional lookup. The
 * split rule is: ROUTING and always-true constraints stay in the description;
 * situation-specific procedure moves here.
 *
 * The catalog line (name + description) is always visible, so the model can see
 * that this guidance exists and load it. Do NOT mark the skill `deferLoading`:
 * the dsh-llm README notes a deferred declaration does not itself activate a
 * tool, and a skill that never loads is strictly worse than inline text.
 *
 * @module
 */

/** The skill name the model calls: `skill({ name: 'html-artifact' })`. */
export const ARTIFACT_SKILL_NAME = 'html-artifact'

/**
 * Provenance bucket for this skill. `'runtime'` is the category for a skill a
 * mounted plugin contributes from code (as opposed to a file-backed
 * `project-*`/`user-*` root); the registry applies it to no other purpose than
 * precedence and prompt-visible origin.
 */
export const ARTIFACT_SKILL_SOURCE = 'runtime'

/**
 * Routing summary shown in the always-present skill catalog. Must be short and
 * must make the two covered situations obvious, or the model will never load
 * the body.
 */
export const ARTIFACT_SKILL_DESCRIPTION =
  'Interaction-data and delivery rules for the `artifact` tool: how to expose live state via '
  + 'window.__dshArtifactData, how in-page submission works, and what to say after an artifact renders.'

/** Optional extra routing guidance for the catalog. */
export const ARTIFACT_SKILL_WHEN_TO_USE =
  'Load before creating an interactive artifact, or when deciding how to reply after an artifact renders.'

/**
 * The skill body. Written as direct instructions to the model, because a loaded
 * skill is read as guidance, not as documentation.
 */
export const ARTIFACT_SKILL_BODY = `# HTML artifacts — interaction data and delivery

These rules apply only in the two situations below. The \`artifact\` tool's own
description remains the authority on ops, versioning and persistence.

## Interaction data

Expose live state as \`window.__dshArtifactData = { ... }\` — a JSON value the
artifact updates as its state changes. This is how the model receives state; a
value that is never assigned sends nothing.

Decide AT CREATE TIME whether interaction data matters: pass \`interactive: true\`
when you genuinely need the user's data back (the canvas then shows a 提交交互
button); omit it for purely presentational artifacts so no unnecessary button
shows. Toggle it any time later with the \`interactive\` op.

## Submission is explicit

Data reaches you ONLY through three deliberate user actions:

1. the user clicks the canvas header's 提交交互 button;
2. the user clicks an in-page element YOU marked with \`data-artifact-submit\`
   (add that attribute only to real submit-style controls, e.g. a
   "提交答案/保存成绩" button);
3. a real \`<form>\` in the page submits (navigation is auto-suppressed, so plain
   forms work).

EVERY OTHER control — game buttons, on-screen direction pads, keyboard and
arrow-key handlers, sliders, tabs, ordinary links — NEVER submits regardless of
how often it is used. Design on-page controls freely, and reserve
\`data-artifact-submit\` for the exact points that mean "send my data to the AI".

## After an artifact renders

A successful \`create\`, \`save\` or final \`patch\` renders the artifact live in the
GUI — that rendering IS the answer to the user, not a summary of it. After
finishing an artifact, do NOT write explanatory prose describing what you made;
end the turn with at most a single short closing line (or nothing) unless the
user explicitly asked for an explanation. Only \`read\`/\`list\` results (which
return source text) may warrant a brief prose response.
`