// @vitest-environment jsdom
/*
 * Sandbox submit-intent contract: the in-page notifier pings the host ONLY on
 * explicit submit points ([data-artifact-submit] clicks, real form submits) —
 * never on ordinary controls — and every document carries the host bridges.
 */
import { describe, expect, it } from 'vitest'
import { buildSandboxedHtmlDocument } from '../src/client/sandbox.ts'

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
