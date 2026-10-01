/*
 * In-canvas source highlighting: highlight.js html grammar output carries
 * hljs-* spans AND escapes every literal < > &, so danger-injection stays safe.
 */
import { describe, expect, it } from 'vitest'
import { highlightHtml } from '../src/client/highlight.ts'

describe('highlightHtml', () => {
  it('wraps tags in hljs spans', () => {
    const out = highlightHtml('<html lang="zh"><body>你好</body></html>')
    expect(out).toContain('hljs-tag')
    expect(out).toContain('hljs-attr')
    expect(out).toContain('hljs-string')
    expect(out).toContain('你好')
  })

  it('escapes raw angle brackets and ampersands (no live elements)', () => {
    const out = highlightHtml('<script>if (a < b && "x&y") {}</script>')
    expect(out).not.toContain('<script>if')
    expect(out).toContain('&lt;')
    expect(out).toContain('&amp;')
  })

  it('returns empty for empty input, and handles unclosed markup', () => {
    expect(highlightHtml('')).toBe('')
    expect(highlightHtml('<div class="half')).toContain('hljs')
  })
})
