// @vitest-environment jsdom
/*
 * Sandbox submit-intent contract: the in-page notifier pings the host ONLY on
 * explicit submit points ([data-artifact-submit] clicks, real form submits) —
 * never on ordinary controls — and every document carries the host bridges.
 */
import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_THEME_VARS,
  buildSandboxedHtmlDocument,
  themeRootCss,
} from '../src/client/sandbox.ts'
import { buildStreamingBridgeDocument } from '../src/client/stream/bridge.ts'

const doc = (html: string): string => buildSandboxedHtmlDocument(html, 'rid-x', 'light')

describe('sandbox submit-intent bridge', () => {
  it('emits dsh-artifact-submit-intent only from [data-artifact-submit] clicks', () => {
    const built = doc('<button>plain</button>')
    expect(built).toContain('dsh-artifact-submit-intent')
    expect(built).toContain('[data-artifact-submit]')
    // The old broad selector auto-submitted on ANY control click — gone.
    expect(built).not.toContain('dsh-artifact-interacted')
    expect(built).not.toContain("closest('button,input,select,textarea,a,label")
    expect(built).not.toContain('closest("button,input,select,textarea,a,label')
  })

  it('treats genuine form submits as intent and suppresses navigation', () => {
    const built = doc('<form><input name="a"></form>')
    expect(built).toContain('"submit"')
    expect(built).toContain('preventDefault')
  })

  it('keeps the collect + theme bridges alongside the notifier', () => {
    const built = doc('<p>x</p>')
    expect(built).toContain('dsh-artifact-collect')
    expect(built).toContain('dsh-artifact-theme')
  })

  it('latches one gesture so click+form-submit never double-submit', () => {
    // A [data-artifact-submit] submit button inside a <form> fires BOTH the
    // click and submit listeners for the same click; the 80ms latch must exist
    // so one gesture yields exactly one dsh-artifact-submit-intent.
    const built = doc('<form><button data-artifact-submit>go</button></form>')
    expect(built).toContain('now-last<80')
  })
})

/*
 * Auto-height probe removal. The probe reported a content height that NOTHING
 * consumed (both surfaces give the iframe flex:1), while costing a
 * getComputedStyle + getBoundingClientRect sweep over every element on each
 * render and on every ResizeObserver tick. These tests pin the removal so it
 * cannot creep back without its consumer.
 */
describe('no auto-height probe without a consumer', () => {
  it('never posts dsh-artifact-resize from either surface', () => {
    expect(doc('<p>x</p>')).not.toContain('dsh-artifact-resize')
    expect(buildStreamingBridgeDocument('sid', 'light')).not.toContain('dsh-artifact-resize')
  })

  it('never sweeps the document with getComputedStyle', () => {
    expect(doc('<p>x</p>')).not.toContain('getComputedStyle')
    expect(buildStreamingBridgeDocument('sid', 'light')).not.toContain('getComputedStyle')
  })

  it('accepts no measure option on either builder', () => {
    // @ts-expect-error -- the option was removed; passing it must not compile.
    buildSandboxedHtmlDocument('<p>x</p>', 'rid-x', 'light', { measure: false })
    // @ts-expect-error -- same.
    buildStreamingBridgeDocument('sid', 'light', { measure: false })
  })
})

/*
 * The two surfaces must theme identically. The streaming bridge used to carry
 * a hand-copied subset of the variables (missing --surface-1, --text-muted and
 * --accent), so a draft using those tokens rendered differently while
 * streaming than after it settled.
 */
describe('theme parity across surfaces', () => {
  const VAR_NAMES = Object.keys(ARTIFACT_THEME_VARS.light)

  it('covers all seven documented preview tokens in both schemes', () => {
    expect(VAR_NAMES).toEqual([
      '--surface-0',
      '--surface-1',
      '--text-primary',
      '--text-secondary',
      '--text-muted',
      '--border',
      '--accent',
    ])
    expect(Object.keys(ARTIFACT_THEME_VARS.dark)).toEqual(VAR_NAMES)
  })

  it('emits every variable into the streaming document, for both schemes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const streaming = buildStreamingBridgeDocument('sid', theme)
      const settled = buildSandboxedHtmlDocument('<p>x</p>', 'sid', theme)
      for (const name of VAR_NAMES) {
        expect(streaming).toContain(`${name}:`)
        expect(settled).toContain(`${name}:`)
      }
    }
  })

  it('shares one themeRootCss between the two surfaces', () => {
    const css = themeRootCss('dark')
    expect(buildStreamingBridgeDocument('sid', 'dark')).toContain(css)
    expect(buildSandboxedHtmlDocument('<p>x</p>', 'sid', 'dark')).toContain(css)
  })

  it('sets color-scheme so UA defaults match the artifact variables', () => {
    expect(buildStreamingBridgeDocument('sid', 'dark')).toContain('color-scheme:dark')
    expect(buildStreamingBridgeDocument('sid', 'light')).toContain('color-scheme:light')
  })

  it('rebuilds the stylesheet on a theme message, not just colorScheme', () => {
    // Setting colorScheme alone leaves the variables at the stale scheme; the
    // handler must rewrite the theme <style> element too.
    const streaming = buildStreamingBridgeDocument('sid', 'light')
    expect(streaming).toContain('dsh-artifact-theme')
    expect(streaming).toMatch(/style\.textContent\s*=\s*build/)
  })
})
