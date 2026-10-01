/**
 * Server-side interaction-submission handling for artifact surfaces: parse the
 * slash-command payload and render the submission text the pre-step injector
 * puts in front of the model. Pure functions so the command handler and the
 * injector stay thin and the semantics are directly unit-testable.
 * @module
 */

/** One interaction submission recorded for an agent. */
export interface InteractionSubmission {
  /** The artifact id the user interacted with. */
  id: string
  /** Optional artifact display title. */
  title?: string
  /** The collected interaction payload (fields/artifactData). */
  data: unknown
  /** Epoch ms when the submission was recorded. */
  time: number
}

/** Result of parsing one `/artifact-submit` raw input. */
export type SubmissionParseResult =
  | { ok: true; value: InteractionSubmission }
  | { ok: false; error: string }

/**
 * Parse the raw input following `/artifact-submit` into a submission.
 * @param raw - the exact text after the command name (whitespace included).
 * @returns the parsed submission or a validation error.
 */
export function parseSubmissionPayload(raw: string): SubmissionParseResult {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'artifact-submit: expected a JSON payload after the command name' }
  }
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: 'artifact-submit: payload must be a JSON object' }
  }
  const record = payload as Record<string, unknown>
  const { id, title, data } = record
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'artifact-submit: "id" must be a non-empty string' }
  }
  if (data === undefined) {
    return { ok: false, error: 'artifact-submit: "data" is required' }
  }
  return {
    ok: true,
    value: {
      id,
      ...typeof title === 'string' && title !== '' ? { title } : {},
      data,
      time: Date.now(),
    },
  }
}

/**
 * Render one submission as the model-visible context text (the expanded body
 * of the UI's context-injection row and the content the model reads).
 * @param submission - the recorded submission.
 * @returns the text block.
 */
export function renderInteractionSubmission(submission: InteractionSubmission): string {
  const label = submission.title === undefined ? submission.id : `${submission.id}（${submission.title}）`
  return `[artifact 交互提交] 用户操作了 HTML artifact ${label} 并提交了交互数据：\n\`\`\`json\n${JSON.stringify(submission.data, null, 2)}\n\`\`\``
}

/**
 * Render the one-line summary shown in the collapsed context-injection row
 * (the `source.summary` of the injected plugin message).
 * @param submission - the recorded submission.
 * @returns the summary line.
 */
export function renderSubmissionSummary(submission: InteractionSubmission): string {
  const data = submission.data
  let count = 0
  if (data !== null && typeof data === 'object') {
    const fields = (data as Record<string, unknown>).fields
    if (Array.isArray(fields)) count = fields.length
  }
  const label = submission.title === undefined ? submission.id : `${submission.id}（${submission.title}）`
  return `artifact ${label} 交互数据（${count} 个字段）`
}

/** One user-side revert request delivered through `/artifact-revert`. */
export interface RevertRequest {
  /** The artifact id to revert. */
  id: string
  /** The saved version to restore as the working copy. */
  version: number
  /** Optional artifact display title (for nicer notices). */
  title?: string
}

/** Result of parsing one `/artifact-revert` raw input. */
export type RevertParseResult =
  | { ok: true; value: RevertRequest }
  | { ok: false; error: string }

/**
 * Parse the raw input following `/artifact-revert` into a revert request.
 * @param raw - the exact text after the command name (whitespace included).
 * @returns the parsed request or a validation error.
 */
export function parseRevertRequest(raw: string): RevertParseResult {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'artifact-revert: expected a JSON payload after the command name' }
  }
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: 'artifact-revert: payload must be a JSON object' }
  }
  const record = payload as Record<string, unknown>
  const { id, version, title } = record
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'artifact-revert: "id" must be a non-empty string' }
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: 'artifact-revert: "version" must be a positive integer' }
  }
  return {
    ok: true,
    value: { id, version, ...typeof title === 'string' && title !== '' ? { title } : {} },
  }
}



/** One artifact to copy in from another session, as the import picker sends it. */
export interface ImportRequest {
  /** The SOURCE session the artifact lives in. */
  sessionId: string
  /** The SOURCE artifact id within that session. */
  artifactId: string
  /**
   * Source version numbers to carry over, in ascending order. Omitted or empty
   * means "the working copy only" — never "all versions", because a 17-version
   * artifact is ~2 MB and the picker's default must stay cheap.
   */
  versions?: number[]
  /** Optional display title to give the imported copy. */
  title?: string
}

export type ImportParseResult =
  | { ok: true; value: ImportRequest }
  | { ok: false; error: string }

/**
 * Parse the canvas import picker's `/artifact-import` payload.
 *
 * Validated strictly rather than defensively: the payload is produced by this
 * plugin's own UI, so a malformed one is a bug worth surfacing, and a
 * permissive parser here would let a crafted command line reach the import path
 * with values the picker never produces.
 * @param raw - the raw text after the command name.
 * @returns the parsed request, or a message describing what was wrong.
 */
export function parseImportRequest(raw: string): ImportParseResult {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'artifact-import: expected a JSON payload after the command name' }
  }
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: 'artifact-import: payload must be a JSON object' }
  }
  const record = payload as Record<string, unknown>
  const { sessionId, artifactId, versions, title } = record
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, error: 'artifact-import: "sessionId" must be a non-empty string' }
  }
  if (typeof artifactId !== 'string' || artifactId.length === 0) {
    return { ok: false, error: 'artifact-import: "artifactId" must be a non-empty string' }
  }
  // Reject a version list containing anything that is not a positive integer
  // rather than silently dropping it: a dropped entry would import a DIFFERENT
  // set of versions than the user selected.
  let picked: number[] | undefined
  if (versions !== undefined) {
    if (!Array.isArray(versions)) {
      return { ok: false, error: 'artifact-import: "versions" must be an array of positive integers' }
    }
    for (const entry of versions) {
      if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1) {
        return { ok: false, error: 'artifact-import: "versions" must contain only positive integers' }
      }
    }
    picked = [...new Set(versions as number[])].sort((a, b) => a - b)
    if (picked.length === 0) picked = undefined
  }
  return {
    ok: true,
    value: {
      sessionId,
      artifactId,
      ...picked === undefined ? {} : { versions: picked },
      ...typeof title === 'string' && title !== '' ? { title } : {},
    },
  }
}
