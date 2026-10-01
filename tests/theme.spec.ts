/**
 * The stylesheet's colour contract.
 *
 * This is the regression test for the bug where the canvas panel stayed light
 * in dark mode: `artifact.module.css` referenced `--surface-0/1/2`,
 * `--text-primary/secondary/muted`, `--border` and `--accent` — none of which
 * the host page defines. Every `var()` silently fell back to its hardcoded
 * `#ffffff`/`#1a1a1a` default, so no amount of theme switching changed
 * anything, and nothing failed loudly.
 *
 * The trap is that those names are REAL in this repo: `sandbox.ts` defines
 * exactly that 7-token set for the artifact iframe (ARTIFACT_THEME_VARS), so a
 * grep for the names finds definitions and the mistake looks deliberate. The
 * two vocabularies are scoped differently (host page vs. preview document) and
 * must not be mixed. This test pins the host-page side.
 *
 * A stylesheet is data, not behaviour, so there is nothing to render here — we
 * assert on the source text directly.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS_PATH = fileURLToPath(new URL('../src/client/artifact.module.css', import.meta.url))

/**
 * The tokens the host actually exposes on the page, mirroring
 * `cordis_inspect_query` → platform `client`, provider `Theme`, method
 * `listTokens` (14 entries). If the host gains tokens, add them here
 * deliberately — that is the point of the list being explicit.
 */
const HOST_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
])

/**
 * Not in the host's exposed list, but it does appear in the host's built
 * bundles, so it may exist. Because that is unresolved, it is only ever
 * allowed WITH a fallback — which keeps the panel correct either way.
 */
const UNLISTED_BUT_TOLERATED = '--dsw-alias-label-tertiary'

/** Marks where the deliberate syntax-highlight palette exception begins. */
const PALETTE_MARKER = 'highlight.js token palette'

const source = readFileSync(CSS_PATH, 'utf8')
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Slice the file into two disjoint regions. The palette is a contiguous block
 * of `.hljs-` rules in the MIDDLE of the file (chrome CSS follows it), so it
 * must be bounded on both sides rather than merely "from the marker onwards":
 *  - the marker lives inside a block comment, so start after that comment
 *    closes. Slicing at the marker itself leaves an unterminated comment,
 *    which stripComments cannot remove.
 *  - end at the close of the last `.hljs-` rule, so later chrome rules such as
 *    `.tabEmpty` are not misclassified as palette.
 */
const markerAt = source.indexOf(PALETTE_MARKER)
if (markerAt < 0) throw new Error(`theme.spec: "${PALETTE_MARKER}" marker missing from the CSS`)

const paletteCommentEnd = source.indexOf('*/', markerAt) + 2
const lastHljs = source.lastIndexOf('.hljs-')
const paletteBlockEnd = source.indexOf('}', source.indexOf('{', lastHljs)) + 1

const chrome = stripComments(source.slice(0, paletteCommentEnd))
const palette = stripComments(source.slice(paletteCommentEnd, paletteBlockEnd))

// `noUncheckedIndexedAccess` widens a capture group to `string | undefined`,
// so narrow once here and keep every downstream use plain `string[]`.
const usedTokens: string[] = [...chrome.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)]
  .map((match) => match[1])
  .filter((token): token is string => token !== undefined)

describe('artifact.module.css — host theme contract', () => {
  it('splits the file into a chrome section and the palette exception', () => {
    expect(markerAt).toBeGreaterThan(0)
    expect(chrome.length).toBeGreaterThan(0)
    expect(palette.length).toBeGreaterThan(0)
    // The palette slice must be the .hljs rules and nothing else.
    expect(palette).toMatch(/\.hljs-keyword/)
    expect(palette).not.toMatch(/\.canvas\b|\.tabEmpty\b|\.pickCard\b/)
    // ...and the chrome slice must not swallow it.
    expect(chrome).not.toMatch(/\.hljs-keyword/)
  })

  it('references at least one token (guards against a silent rewrite)', () => {
    expect(usedTokens.length).toBeGreaterThan(10)
  })

  it('uses ONLY tokens the host exposes, apart from the documented fallback', () => {
    // `noUncheckedIndexedAccess` makes Set.has's argument plain string; the
    // capture group is `string | undefined` only because matchAll is generic.
    const unknown = [...new Set(usedTokens)].filter(
      (t) => !HOST_TOKENS.has(t) && t !== UNLISTED_BUT_TOLERATED,
    )
    expect(unknown).toEqual([])
  })

  it('never uses a bare legacy variable name', () => {
    // The exact names that shipped the light-in-dark-mode bug.
    const legacy = [
      '--surface-0',
      '--surface-1',
      '--surface-2',
      '--text-primary',
      '--text-secondary',
      '--text-muted',
      '--border',
      '--accent',
    ]
    for (const name of legacy) {
      expect(chrome).not.toContain(`var(${name}`)
      expect(chrome).not.toContain(`var( ${name}`)
    }
  })

  it('always gives the unlisted token a fallback', () => {
    const uses = [...chrome.matchAll(/var\(\s*(--dsw-alias-label-tertiary)([^)]*)\)/g)]
    expect(uses.length).toBeGreaterThan(0)
    for (const match of uses) {
      expect((match[2] ?? '').trim().startsWith(',')).toBe(true)
    }
  })

  it('hardcodes no colour in the chrome section', () => {
    // Comments are stripped above, so prose mentioning #ffffff cannot fail this.
    const literals = chrome.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []
    expect(literals).toEqual([])
  })

  it('carries no local dark-mode rules — the host owns the scheme', () => {
    // A prefers-color-scheme block here would follow the OS, not the user's
    // ui-theme preference. The tokens (and light-dark in the palette) are the
    // only mechanisms this file may use to follow the theme.
    // Comments are stripped: the header comment deliberately NAMES these
    // mechanisms while explaining why not to use them.
    const rules = stripComments(source)
    expect(rules).not.toMatch(/prefers-color-scheme/)
    expect(rules).not.toMatch(/^\s*:root\s*\{/m)
    expect(rules).not.toMatch(/\[data-theme/)
    expect(rules).not.toMatch(/^\s*\.dark\b/m)
  })
})

describe('artifact.module.css — syntax palette exception', () => {
  it('keeps every palette colour inside light-dark(), never a fixed scheme', () => {
    const withoutLightDark = palette.replace(/light-dark\([^)]*\)/g, '')
    const escaped = withoutLightDark.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []
    expect(escaped).toEqual([])
  })

  it('uses light-dark for the palette', () => {
    expect(palette).toMatch(/light-dark\(/)
  })

  it('does not refer to host tokens (a syntax palette is not chrome)', () => {
    expect(palette).not.toMatch(/var\(--dsw-/)
  })
})