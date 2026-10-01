/**
 * The `artifact-draft` chat node adapter:
 * Reports the delta-phase stream preview to the canvas bridge so the canvas
 * tab in the right sidebar updates live as the model generates HTML.
 *
 * It intentionally draws NO visible conversation card (and collapses its host
 * flow item) because DSH natively renders the in-flight tool call row via
 * `tool.call.toolview` (ArtifactRow). Rendering a second ArtifactRow here
 * caused duplicate conversation blocks in the chat list during generation.
 * @module
 */
import { useEffect } from 'react'
import type { ArtifactDraftData } from './draft.ts'
import { canvasBridge } from '../canvas/state.ts'
import { IconOpen } from '../icons.tsx'
import css from '../artifact.module.css'

export interface ChatNodeViewProps<Kind extends string = string> {
  node: { data: ArtifactDraftData; kind?: Kind }
  cwd?: string | undefined
  openFile?: (path: string) => void
  inspectCall?: ((callId: string) => void) | undefined
}

/** The keyed `artifact-draft` chat node view: renders the in-flight generation row
 * and streams preview HTML to the canvas bridge. */
export function ArtifactDraftNodeView({ node }: ChatNodeViewProps<'artifact-draft'>) {
  const data = node.data

  useEffect(() => {
    canvasBridge.reportStream({ callId: data.callId, html: data.html, title: data.title })
    return () => {
      canvasBridge.reportStream(undefined)
    }
  }, [data.callId, data.html, data.title])

  const label = data.title === undefined || data.title === '' ? '正在生成 HTML artifact…' : `正在生成「${data.title}」…`

  return (
    <div className={css.row} onClick={() => canvasBridge.open()}>
      <span className={css.rowMark}><i className={css.pulse} /></span>
      <span className={css.rowMain}>
        <span className={css.rowTitle}>{label}</span>
        <span className={css.rowSub}>完成后可在画布中查看</span>
      </span>
      <span className={`${css.rowActions} ${css.openHint}`}><IconOpen /></span>
    </div>
  )
}
