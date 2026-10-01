/**
 * Sandboxed HTML document builder for the artifact preview, porting the
 * standard artifact-sandbox recipe (CSP meta, theme variables, storage shim,
 * theme bridge) as a self-contained string: every artifact renders inside an
 * iframe whose srcdoc carries a `default-src 'none'` policy, an opaque origin
 * (`sandbox="allow-scripts"` without allow-same-origin), and a postMessage
 * bridge for theme and interaction data — the artifact can script itself but
 * cannot touch the host document.
 *
 * SIZING: there is deliberately NO auto-height probe. Both surfaces that embed
 * an artifact (the canvas panel body and the streaming draft surface) give the
 * iframe `flex:1` and own its height, so a document that measured its own
 * content box and posted `dsh-artifact-resize` had no consumer at all — it
 * only forced a full-document `getComputedStyle` + `getBoundingClientRect`
 * sweep per rendered element, then again on every `ResizeObserver` tick. If
 * inlined auto-height is ever wanted, add the probe AND its consumer together.
 * @module
 */
import { useEffect, useState } from 'react'
import { collectBridgeBody } from './stream/collect.ts'

export type ArtifactTheme = 'light' | 'dark'

/** Content-Security-Policy for artifact documents: no network to the host, no
 *  frames/objects/forms; scripts/styles may be inline; https/http resources
 *  (images, fonts, styles, fetches) are allowed. Shared by the settled
 *  surface (sandbox.ts) and the streaming bridge (stream/bridge.ts). */
export const ARTIFACT_CSP = `default-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; img-src https: http: data: blob:; media-src https: http: data: blob:; font-src https: http: data:; style-src 'unsafe-inline' https: http:; script-src 'unsafe-inline' 'unsafe-eval' https: http: blob:; connect-src https: http:`

/**
 * CSS custom properties the artifact document exposes for the host theme.
 * These names are SCOPED TO THE PREVIEW DOCUMENT — they are not host page
 * tokens, and the host does not define them. (The canvas chrome once used the
 * same names for its own styling, which is exactly how it shipped a
 * light-in-dark-mode bug: the names resolved here and nowhere else. Keep the
 * two vocabularies separate — the chrome uses `--dsw-alias-*`.)
 *
 * Exported so the streaming bridge themes its documents from this single
 * source; it previously carried a hand-copied subset missing `--surface-1`,
 * `--text-muted` and `--accent`, so a draft that used those tokens rendered
 * differently while streaming than it did once settled.
 */
export const ARTIFACT_THEME_VARS: Record<ArtifactTheme, Record<string, string>> = {
  light: {
    '--surface-0': '#ffffff',
    '--surface-1': '#f5f4f1',
    '--text-primary': '#1a1a1a',
    '--text-secondary': '#52514e',
    '--text-muted': '#898781',
    '--border': '#e3e1da',
    '--accent': '#185fa5',
  },
  dark: {
    '--surface-0': '#161614',
    '--surface-1': '#2a2a28',
    '--text-primary': '#ffffff',
    '--text-secondary': '#c3c2b7',
    '--text-muted': '#898781',
    '--border': '#3a3a37',
    '--accent': '#85b7eb',
  },
}

/** The `:root` rule carrying one theme's variables, for both surfaces. */
export function themeRootCss(theme: ArtifactTheme): string {
  const vars = Object.entries(ARTIFACT_THEME_VARS[theme])
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  return `:root{color-scheme:${theme};font-family:system-ui,sans-serif;${vars}}`
}

/** Read the host theme the boot script set on <html> (color-scheme). */
export function hostArtifactTheme(): ArtifactTheme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.style.colorScheme === 'dark' ? 'dark' : 'light'
}

/**
 * The host theme as live React state.
 *
 * `hostArtifactTheme()` reads `<html>`'s inline `color-scheme`, which the
 * layout plugin assigns directly (`documentElement.style.colorScheme =
 * scheme`). There is no subscription to use: the Theme inspect provider
 * exposes token names but no change event, and the app sets neither a
 * `data-theme` attribute nor a class. A MutationObserver on `<html>`'s `style`
 * attribute is therefore the only faithful way to notice a light/dark switch.
 *
 * This exists because the panel previously did `useState(hostArtifactTheme)`,
 * freezing the scheme at mount: switch appearance and every artifact kept the
 * old scheme's colours until the tab was remounted.
 */
export function useArtifactTheme(): ArtifactTheme {
  const [theme, setTheme] = useState(hostArtifactTheme)
  useEffect(() => {
    const sync = (): void => {
      setTheme(previous => {
        const next = hostArtifactTheme()
        return next === previous ? previous : next
      })
    }
    // The scheme can change between render and effect (or before mount).
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    return () => { observer.disconnect() }
  }, [])
  return theme
}

/** In-memory localStorage/sessionStorage for the opaque-origin sandbox. */
function storageShimScript(): string {
  return `<script>${'(function(){const create=function(){const values=new Map();return{get length(){return values.size},key:index=>Array.from(values.keys())[index]??null,getItem:key=>values.get(String(key))??null,setItem:(key,value)=>{values.set(String(key),String(value))},removeItem:key=>{values.delete(String(key))},clear:()=>values.clear()}};for(const name of["localStorage","sessionStorage"]){try{window[name].getItem("__dsh_probe__");continue}catch(e){}try{Object.defineProperty(window,name,{configurable:true,enumerable:true,value:create()})}catch(e){}}}())'}</script>`
}

/** Theme bridge: applies a `dsh-artifact-theme` postMessage to the document. */
function themeApplyScript(theme: ArtifactTheme): string {
  const themes = JSON.stringify(ARTIFACT_THEME_VARS)
  return `<script>(function(){var themes=${themes};var build=function(theme){var vars=Object.entries(themes[theme]).map(function(e){return e[0]+":"+e[1]}).join(";");return ":root{color-scheme:"+theme+";font-family:system-ui,sans-serif;"+vars+"}"};var apply=function(theme){var root=document.documentElement;root.style.colorScheme=theme;var style=document.getElementById("dsh-artifact-theme");if(style){style.textContent=build(theme)}dispatchEvent(new Event("resize"))};addEventListener("message",function(event){var data=event.data;if(data&&data.type==="dsh-artifact-theme"&&(data.theme==="light"||data.theme==="dark")){apply(data.theme)}})})()</script>`
}

/** Submit-intent notifier: pings the host ONLY on explicitly declared submit
 *  points — ordinary controls (game buttons, on-screen D-pads, sliders, plain
 *  inputs) must NEVER send data to the model on their own. Two explicit
 *  triggers inside the page:
 *   1. a click on any element carrying `data-artifact-submit` (or a
 *      descendant — design a 提交 button with that attribute);
 *   2. a genuine <form> submission (default navigation is suppressed so the
 *      page survives; the page's own submit handlers still run normally).
 *  A click on a [data-artifact-submit] submit button INSIDE a <form> fires
 *  BOTH listeners for the same gesture — the 80ms latch merges them into one
 *  notification so a single gesture never double-submits.
 *  Everything else stays silent: the header「提交交互」button on the host side
 *  is the other, chrome-level trigger. */
function interactScript(postMessageId: string): string {
  return `<script>(function(){var id=${JSON.stringify(postMessageId)};var last=0;var notify=function(){var now=Date.now();if(now-last<80){return}last=now;try{parent.postMessage({type:"dsh-artifact-submit-intent",id:id},"*")}catch(e){}};document.addEventListener("click",function(e){var t=e.target;var el=t&&t.closest?t.closest("[data-artifact-submit]"):null;if(el)notify()},true);document.addEventListener("submit",function(e){e.preventDefault();notify()},true)})()</script>`
}

/** Collect handler: scans the artifact body on a `dsh-artifact-collect`
 *  request and reports the interaction data back to the requester. */
function collectScript(postMessageId: string, collectBody: string): string {
  return `<script>(function(){var id=${JSON.stringify(postMessageId)};${collectBody}addEventListener("message",function(event){var d=event.data;if(d&&d.type==="dsh-artifact-collect"&&d.id===id){var data=collect(document.body);event.source.postMessage({type:"dsh-artifact-collect-result",id:id,data:data},"*")}})})()</script>`
}

export interface SurfaceOptions {
  /** Let the document scroll instead of clipping (the canvas panel body). */
  scrollable?: boolean
}

/**
 * Build the srcdoc for one artifact preview: the artifact source merged into a
 * host-owned document (CSP head, theme variables, storage shim, theme and
 * collect bridges). The source is parsed with DOMParser so a `</body>` or
 * `<head>` inside it cannot break out of the wrapper structure.
 * @param source - the artifact's HTML source.
 * @param postMessageId - stable per-surface id echoed back by the bridges; it
 *   is how a surface recognizes messages from ITS OWN document.
 * @param theme - initial host theme for the document.
 * @returns the complete standalone document string.
 */
export function buildSandboxedHtmlDocument(
  source: string,
  postMessageId: string,
  theme: ArtifactTheme,
  options: SurfaceOptions = {},
): string {
  const scrollable = options.scrollable === true
  const doc = new DOMParser().parseFromString(source, 'text/html')
  const securityHead = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1">`
  const overflow = scrollable ? 'overflow:auto' : 'overflow:hidden'
  const themeHead = `<style id="dsh-artifact-theme">html,body{margin:0;${overflow};background:transparent}${themeRootCss(theme)}</style>`
  const bridges = [themeApplyScript(theme)]
  bridges.push(collectScript(postMessageId, collectBridgeBody()))
  bridges.push(interactScript(postMessageId))
  doc.head.insertAdjacentHTML('afterbegin', `${securityHead}${themeHead}${storageShimScript()}`)
  doc.body.insertAdjacentHTML('afterbegin', bridges.join(''))
  return `<!doctype html>${doc.documentElement.outerHTML}`
}