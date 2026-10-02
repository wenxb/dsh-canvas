/**
 * The tool's NAME, in one place for both halves.
 *
 * The tool was registered as `artifact` until the plugin was renamed to
 * dsh-canvas. The old name is not just cosmetic history: tool NAMES are written
 * into every session log, and three separate mechanisms match on them —
 *
 *   - the host's replay correlates a patch's arguments to its result by tool name
 *     (see `ensureFromLog`), so a log written before the rename must still resolve;
 *   - the canvas timeline builds its entries from logged tool calls;
 *   - the client registers one toolview card PER TOOL NAME, so pre-rename calls
 *     need their own registration.
 *
 * Hence the acceptance set below: everything that reads a name from a log or a
 * live call accepts BOTH. `card: 'artifact'` (the render intent inside a result
 * view, see client/contract.ts) is a different string and is deliberately left
 * alone — it is the render tag, not the tool name.
 * @module
 */

/** The name the tool registers under today. */
export const ARTIFACT_TOOL_NAME = 'canvas'

/** Names it was registered under BEFORE the rename; newest first. */
export const LEGACY_ARTIFACT_TOOL_NAMES: readonly string[] = ['artifact']

/** Every name that must be accepted as this plugin's tool. */
export const ARTIFACT_TOOL_NAMES: readonly string[] = [ARTIFACT_TOOL_NAME, ...LEGACY_ARTIFACT_TOOL_NAMES]

/** True when `name` is this plugin's tool — under its current name or a legacy one. */
export function isArtifactToolName(name: unknown): boolean {
  return typeof name === 'string' && ARTIFACT_TOOL_NAMES.includes(name)
}
