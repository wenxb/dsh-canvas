/**
 * In-canvas source highlighting: highlight.js with the three grammars an
 * artifact actually mixes (html + css + javascript), registered against the
 * CORE build (no file-based grammars pulled in). The html grammar highlights
 * embedded <script>/<style> with the two sub-grammars automatically.
 *
 * Output is injected with dangerouslySetInnerHTML — safe: highlight.js escapes
 * every literal `<`/`&` in the source before wrapping tokens in spans.
 * @module
 */
import hljs from 'highlight.js/lib/core'
import cssGrammar from 'highlight.js/lib/languages/css'
import jsGrammar from 'highlight.js/lib/languages/javascript'
import xmlGrammar from 'highlight.js/lib/languages/xml'

hljs.registerLanguage('xml', xmlGrammar)
hljs.registerLanguage('css', cssGrammar)
hljs.registerLanguage('javascript', jsGrammar)

/**
 * Highlight one HTML source string into highlight.js's escaped HTML markup.
 * @param source - the raw HTML (working copy or a saved version).
 * @returns HTML string with `hljs-*` spans, ready for innerHTML.
 */
export function highlightHtml(source: string): string {
  if (source === '') return ''
  return hljs.highlight(source, { language: 'xml' }).value
}
