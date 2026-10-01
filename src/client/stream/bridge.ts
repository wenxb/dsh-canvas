/**
 * The streaming bridge document: a PERSISTENT iframe srcdoc for the live
 * artifact draft. Unlike the settled document (which rebuilds srcdoc per
 * snapshot), this one loads once and receives streamed html through a
 * postMessage bridge — the iframe never reloads while the model writes, so the
 * preview stays stable and cheap. The artifact html is injected into a root
 * div via innerHTML (which never executes embedded <script> tags — draft
 * scripts run only in the settled surface after the call completes).
 *
 * There is deliberately no auto-height probe: the panel body gives this iframe
 * `flex:1` and owns its height, so a probe reporting the content box had no
 * consumer and only re-walked every element on each streamed chunk. See the
 * SIZING note in sandbox.ts.
 * @module
 */

import { ARTIFACT_CSP, ARTIFACT_THEME_VARS, themeRootCss, type ArtifactTheme } from '../sandbox.ts'

/**
 * The stream receiver: swaps `dsh-artifact-stream` html into the root div and
 * applies `dsh-artifact-theme` by rewriting the theme stylesheet.
 *
 * The theme handler MUST rebuild the stylesheet, not just set `colorScheme`:
 * the panel's `theme` is a `useState` captured once at mount, so if the user
 * switches appearance while a draft renders, the iframe only learns about it
 * through this message. Setting `color-scheme` alone leaves the variables at
 * the old scheme and the draft preview wears stale colours.
 */
function bridgeScript(postMessageId: string): string {
  const themes = JSON.stringify(ARTIFACT_THEME_VARS)
  return `<script>(function(){var themes=${themes};var id=${JSON.stringify(postMessageId)};var build=function(theme){var vars=Object.entries(themes[theme]).map(function(e){return e[0]+":"+e[1]}).join(";");return ":root{color-scheme:"+theme+";font-family:system-ui,sans-serif;"+vars+"}"};addEventListener("message",function(event){var data=event.data;if(!data){return}if(data.type==="dsh-artifact-stream"&&typeof data.html==="string"){var root=document.getElementById("dsh-artifact-root");if(root){root.innerHTML=data.html}}else if(data.type==="dsh-artifact-theme"&&(data.theme==="light"||data.theme==="dark")){document.documentElement.style.colorScheme=data.theme;var style=document.getElementById("dsh-artifact-theme");if(style){style.textContent=build(data.theme)}}})})()</script>`
}

/**
 * Build the persistent srcdoc for one streaming draft surface.
 * @param postMessageId - stable per-surface id; the document is addressed
 *   wholesale by this bridge (messages carry no id, unlike the collect
 *   round-trip), so it is passed for diagnostics and future routing.
 * @param theme - initial host theme for the document.
 * @returns the complete standalone document string.
 */
export function buildStreamingBridgeDocument(
  postMessageId: string,
  theme: ArtifactTheme,
  options: { scrollable?: boolean } = {},
): string {
  const overflow = options.scrollable === true ? 'auto' : 'hidden'
  // `color-scheme: ${theme}` in the :root rule also makes the UA pick the right
  // default background for the artifact's own `canvas`/`color` values.
  const themeStyle = `<style id="dsh-artifact-theme">html,body{margin:0;overflow:${overflow};background:transparent}${themeRootCss(theme)}</style>`
  return `<!doctype html><html data-surface="${postMessageId}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">${themeStyle}</head><body><div id="dsh-artifact-root"></div>${bridgeScript(postMessageId)}</body></html>`
}