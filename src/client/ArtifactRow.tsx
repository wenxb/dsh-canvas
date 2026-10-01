/**
 * The in-chat artifact card: a COMPACT row (icon + title + one-line Chinese
 * status + actions) instead of an embedded preview iframe. Clicking anywhere
 * on the row opens the canvas panel — the Gemini-canvas pattern, and the fix
 * for the old inline previews squashing to ~120px. The full document lives in
 * the panel; the chat keeps a lightweight pointer to it.
 * @module
 */
import { useEffect, useRef, useState } from 'react'
import type { ArtifactCardView, ArtifactHtmlCard } from './contract.ts'
import type { ToolCallOwnerProps } from './contract.ts'

/**
 * The subset of {@link ToolCallOwnerProps} this row actually consumes.
 *
 * Deliberately NARROW: the row renders a pointer to the canvas and never loads
 * an image, so requiring the full owner contract would force the streaming
 * draft node (whose props come from the chat-node slot, not the tool-call
 * slot) to fabricate a `loadImage` it has no way to honour. Still assignable
 * FROM the real owner, so the keyed `tool.call.toolview` registration accepts
 * it unchanged.
 */
export type ArtifactRowProps = Pick<ToolCallOwnerProps, 'callId' | 'toolName' | 'block' | 'cwd' | 'openFile' | 'inspect'> & {
  useToolCallArgumentsPartial?: () => string
}
import { artifactArgs, artifactCardModel, cardVersion } from './contract.ts'
import { canvasBridge, useCanvasState } from './canvas/state.ts'
import { extractStreamingHtml, extractStreamingTitle, isStreamingCreate } from './stream/extract.ts'
import { hideFlowItemAround, revealFlowItemAround } from './chat-flow.ts'
import { IconCheck, IconCode, IconCopy, IconOpen } from './icons.tsx'
import css from './artifact.module.css'

/** Byte counts as human-readable text. */
function formatBytes(html: string): string {
  const bytes = new TextEncoder().encode(html).byteLength
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** Copy button with transient success feedback (click stays in-row). */
function CopyButton({ html }: { html: string }) {
  const [copied, setCopied] = useState(false)
  /** Cleared on unmount so a 1.5s feedback timer cannot fire into a gone row. */
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    if (feedbackTimer.current !== undefined) clearTimeout(feedbackTimer.current)
  }, [])
  return (
    <button
      type="button"
      className={css.rowBtn}
      title="复制源码"
      onClick={(event) => {
        event.stopPropagation()
        void navigator.clipboard?.writeText(html).then(() => {
          setCopied(true)
          feedbackTimer.current = setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <IconCheck /> : <IconCopy />}
      {copied ? '已复制' : '复制源码'}
    </button>
  )
}

/** The Chinese status line for one settled source-bearing card. */
function statusLine(view: ArtifactHtmlCard): string {
  const version = cardVersion(view)
  const versionText = version === undefined ? '' : `版本 ${version}`
  switch (view.op) {
    // `create`/`read` always carry source, but the union allows its absence, so
    // the byte count is conditional rather than an unchecked `view.html`.
    case 'create':
      return `已创建${versionText === '' ? '' : ` · ${versionText}`}${view.html === undefined ? '' : ` · ${formatBytes(view.html)}`}`
    // A patch no longer ships its resulting source (the log keeps its cause),
    // so the line is complete without it.
    case 'patch':
      return `已修改 ${view.applied === undefined ? 1 : view.applied} 处 · 未保存新版本`
    case 'save':
      return view.unchanged === true && versionText !== '' ? `内容未变，仍为 ${versionText}` : `已保存为 ${versionText}`
    case 'revert':
      return `已回退到 ${versionText}`
    case 'read':
      return `读取源码${view.html === undefined ? '' : ` · ${formatBytes(view.html)}`}${view.truncated === true ? '（已截断）' : ''}`
    // Exhaustive over HtmlArtifactOp; unreachable, but keeps the function total
    // if the op vocabulary grows without this switch being updated.
    default:
      return view.id
  }
}

/**
 * A settled call that intentionally draws NOTHING — and, crucially, collapses
 * the chat flow item around it so a run of hidden calls leaves no blank band.
 * All the DOM knowledge lives in ../chat-flow.ts; this is just the mount hook.
 */
export function HiddenRow() {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => hideFlowItemAround(ref.current), [])
  return <div ref={ref} data-artifact-hidden="true" style={{ display: 'none' }} aria-hidden="true" />
}

/**
 * The keyed `tool.call.toolview` row for the artifact tool: a compact card;
 * click opens the canvas panel.
 * @param props - owner currency supplied by the stock ui-tool rows.
 */
export function ArtifactRow(props: ArtifactRowProps) {
  const { block } = props
  const model = artifactCardModel(block)
  const args = artifactArgs(block)
  const canvas = useCanvasState()

  const partial = typeof props.useToolCallArgumentsPartial === 'function' ? props.useToolCallArgumentsPartial() : undefined
  const rawArgs = partial ?? ('argsRaw' in block && typeof block.argsRaw === 'string' ? block.argsRaw : '')
  const partialTitle = rawArgs ? extractStreamingTitle(rawArgs) : undefined
  const partialHtml = rawArgs ? extractStreamingHtml(rawArgs)?.html : undefined
  const reportedTitle = canvas.reportedStream?.callId === props.callId ? canvas.reportedStream.title : undefined

  const op = args?.op
  const isCreate = op === 'create' || (op === undefined && isStreamingCreate(rawArgs))
  const target = args?.title ?? args?.id ?? partialTitle ?? reportedTitle

  useEffect(() => {
    if (partialHtml !== undefined && !('kind' in block)) {
      canvasBridge.reportStream({
        callId: props.callId,
        html: partialHtml,
        title: target,
      })
    }
  }, [props.callId, partialHtml, target, block])

  useEffect(() => () => {
    if (canvasBridge.getSnapshot().reportedStream?.callId === props.callId) {
      canvasBridge.reportStream(undefined)
    }
  }, [props.callId])

  // A row that becomes VISIBLE again (a running create settling into a real
  // card) must undo a hide another state of this same row performed.
  const rowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => revealFlowItemAround(rowRef.current))

  // Running calls:
  // - If op is non-create (patch/save/revert/read/destroy/list), hide it strictly.
  // - For create, render the in-flight generation hint until settled.
  if (model === null) {
    if (!('kind' in block)) {
      if (canvasBridge.isZombieCall(block.callId)) return <HiddenRow />
      const isNonCreate = op !== undefined
        ? op !== 'create'
        : (/"op"\s*:\s*"(?:patch|save|revert|read|destroy|list|interactive)"/u.test(rawArgs) || /"id"\s*:/u.test(rawArgs))
      if (isNonCreate) return <HiddenRow />

      const createTitle = args?.title ?? partialTitle ?? reportedTitle
      const label = createTitle === undefined || createTitle === '' ? '正在生成 HTML artifact…' : `正在生成「${createTitle}」…`
      return (
        <div ref={rowRef} className={css.row} onClick={() => canvasBridge.open()}>
          <span className={css.rowMark}><i className={css.pulse} /></span>
          <span className={css.rowMain}>
            <span className={css.rowTitle}>{label}</span>
            <span className={css.rowSub}>完成后可在画布中查看</span>
          </span>
          <span className={`${css.rowActions} ${css.openHint}`}><IconOpen /></span>
        </div>
      )
    }
    return <HiddenRow />
  }

  const view = model.view
  // Settled patches add NO conversation block — versions are the blocks
  // (create/save/revert); the RUNNING patch row already showed 正在修改…,
  // and the canvas's 未保存 badge tracks the unsaved state. HiddenRow also
  // erases the flex-gap flow item so a run of patches leaves no blank band.
  if (view.op === 'patch') return <HiddenRow />
  if (view.op === 'destroy') {
    return (
      <div className={`${css.row} ${css.rowMuted}`} onClick={() => canvasBridge.open(view.id)}>
        <span className={css.rowMark}><IconCode size={16} /></span>
        <span className={css.rowMain}>
          <span className={css.rowTitle}>HTML artifact 已删除</span>
          <span className={css.rowSub}>{view.id}</span>
        </span>
      </div>
    )
  }
  if (view.op === 'list') {
    const label = view.artifacts.length === 0 ? '没有 HTML artifact' : `共 ${view.artifacts.length} 个 HTML artifact`
    return (
      <div className={`${css.row} ${css.rowMuted}`}>
        <span className={css.rowMark}><IconCode size={16} /></span>
        <span className={css.rowMain}>
          <span className={css.rowTitle}>列出 artifact</span>
          <span className={css.rowSub}>{label}</span>
        </span>
      </div>
    )
  }

  if (view.op === 'interactive') {
    return (
      <div ref={rowRef} className={css.row} onClick={() => canvasBridge.open(view.id)}>
        <span className={css.rowMark}><IconCode size={16} /></span>
        <span className={css.rowMain}>
          <span className={css.rowTitle}>{view.title ?? view.id}</span>
          <span className={css.rowSub}>{view.interactive === true ? '交互数据已开启 · 画布显示提交按钮' : '交互数据已关闭 · 画布隐藏提交按钮'}</span>
        </span>
      </div>
    )
  }

  return (
    <div ref={rowRef} className={css.row} onClick={() => canvasBridge.open(view.id)}>
      <span className={css.rowMark}><IconCode size={16} /></span>
      <span className={css.rowMain}>
        <span className={css.rowTitle}>{view.title ?? view.id}</span>
        <span className={css.rowSub}>{statusLine(view)}</span>
      </span>
      <span className={css.rowActions}>
        {/* No source on a patch card, so there is nothing to copy. */}
        {view.html === undefined ? null : <CopyButton html={view.html} />}
        <span className={css.openHint}><IconOpen />画布</span>
      </span>
    </div>
  )
}
