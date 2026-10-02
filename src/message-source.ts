/**
 * This plugin's PRODUCER-OWNED conversation message source.
 *
 * WHY THIS EXISTS — a shipped failure found only by live verification. The
 * canvas commands that wake the model (`/artifact-submit`, `/artifact-import`)
 * built their message source as:
 *
 *     { kind: 'plugin', plugin: name, form: 'notice', summary }
 *
 * That shape is the RETIRED V3 wrapper. It is accepted only by the log MIGRATOR
 * (`rewritePluginSource` in dsh-session-format-v3-to-v4 rewrites a V3
 * `kind: 'plugin'` + `plugin` pair into the producer's own kind). A NEWLY
 * appended event goes through `assertV4MessageSources` instead, whose validator
 * rejects `kind === 'plugin'` outright:
 *
 *     format v4 message requires a producer-owned source kind
 *
 * So the append threw, `agent.followup()` failed, the turn ended as
 * "本轮运行失败", and the model never learned about the artifact. The interaction
 * submission path had the same defect and had never been exercised with a real
 * model turn.
 *
 * The kind is `plugin:<package>` because that is exactly what the migrator
 * produces for this package's historical messages (`producerKind` falls through
 * to `plugin:${plugin}`). Using the same string keeps OLD messages migrated from
 * V3 and NEW ones under ONE kind, so a consumer grouping by kind does not see
 * this plugin as two producers.
 *
 * DELIBERATELY NOT UPDATED WHEN THE PLUGIN IS RENAMED. The package is now
 * `@dsh-external/dsh-canvas`, but this kind stays `plugin:<old package>` because
 * it is the string the migrator derives from the HISTORICAL package name — the
 * one already committed to every existing log. Renaming it here would split this
 * plugin into two producers, which is the exact failure the paragraph above
 * exists to prevent.
 * @module
 */

import type {} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:@dsh-external/dsh-html-artifact': {
      readonly kind: 'plugin:@dsh-external/dsh-html-artifact'
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

/**
 * The one source this plugin attributes its conversation messages to.
 *
 * `form: 'notice'` is the documented form for "a one-off account of something
 * that just happened; it supersedes nothing" — which is precisely what an
 * interaction submission or an import notice is.
 *
 * The summary MUST stay within `CONTEXT_SUMMARY_MAX_CHARS` (120): producers commit
 * it to the durable log, and the host's own `boundContextSummary` ellipsizes
 * anything longer. Callers pass caller text (artifact ids, counts), so it is
 * bounded here rather than left to each call site.
 */
export const NOTICE_SOURCE_KIND = 'plugin:@dsh-external/dsh-html-artifact' as const

/** `notice` summaries are bounded to this many characters by the host. */
const SUMMARY_MAX_CHARS = 120

/**
 * Build this plugin's `notice` source with a bounded summary.
 * @param summary - one-line account of what happened; ellipsized past 120 chars.
 * @returns the source record to hand to `createUserMessage`.
 */
export function artifactNoticeSource(summary: string): {
  kind: typeof NOTICE_SOURCE_KIND
  form: 'notice'
  summary: string
} {
  return {
    kind: NOTICE_SOURCE_KIND,
    form: 'notice',
    summary: summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` : summary,
  }
}
