/**
 * The artifact CANVAS: the DSH native right-sidebar tab body. Gemini-canvas
 * behavior:
 *
 * - AUTO-OPEN: the bridge opens the tab whenever a new version is generated;
 * - header controls (all Chinese): artifact switcher, 前进/后退 through saved
 *   versions, 回退此版本 (runs /artifact-revert), 提交交互, 编辑器, 刷新, 源码;
 *   the panel's own chrome owns 关闭/全屏/宽度 (native sidebar-right);
 * - the body iframe owns its height (flex fill + document scroll) — content
 *   measuring is deliberately skipped, which is what fixes the squashed
 *   ~120px preview;
 * - during generation a PERSISTENT bridge iframe streams the partial html by
 *   postMessage (no reloads); once settled, the full sandboxed document runs
 *   the artifact's scripts.
 *
 * WIDTH and FULLSCREEN are the NATIVE panel's own (dsh-client-ui-sidebar-right:
 * drag sash + fullscreen chrome). The plugin used to override the frame's grid
 * template with `!important` and hijack the native sash; both are gone — the
 * override fought the native collapsed state (a closed sidebar kept its
 * column), and the native panel does the same job better.
 * @module
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { canvasBridge, submitInteraction, submitRevert, useCanvasState, type CanvasSnapshot } from './state.ts'
import { buildSandboxedHtmlDocument, hostArtifactTheme } from '../sandbox.ts'
import { buildStreamingBridgeDocument } from '../stream/bridge.ts'
import { IconCheck, IconChevronLeft, IconChevronRight, IconCode, IconDownload, IconEye, IconFileCode, IconRefresh, IconRevert, IconSend } from '../icons.tsx'
import css from '../artifact.module.css'
import { highlightHtml } from '../highlight.ts'

/** Ask a settled surface's collect bridge for its interaction data. */
function collectFrame(frame: HTMLIFrameElement | null, resizeId: string, timeoutMs = 2500): Promise<unknown | undefined> {
  const win = frame === null ? undefined : frame.contentWindow
  if (frame === null || win === undefined || win === null) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: unknown): void => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(value)
    }
    const onMessage = (event: MessageEvent): void => {
      const data: unknown = event.data
      if (data === null || typeof data !== 'object') return
      const record = data as Record<string, unknown>
      if (record.type !== 'dsh-artifact-collect-result' || record.id !== resizeId) return
      // Only OUR frame may answer. `resizeId` is a predictable React useId
      // value, so without this check any other sandboxed artifact iframe on
      // the page could forge a collect result.
      if (event.source !== frame.contentWindow) return
      finish(record.data)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    window.addEventListener('message', onMessage)
    win.postMessage({ type: 'dsh-artifact-collect', id: resizeId }, '*')
  })
}

/**
 * The artifact picker: card list of the session's known artifacts. Used at
 * both empty states — canvas open but nothing selected, and the reopened tab
 * after a close. Clicking goes through open() (not select()), so the canvas
 * state also re-opens when the tab was closed in between.
 */
function ArtifactPicker({ state }: { state: CanvasSnapshot }) {
  return (
    <div className={css.pickList} role="list" aria-label="可选 artifact 列表">
      {state.order.filter(id => state.timelines.get(id)?.destroyed !== true).map(id => {
        const t = state.timelines.get(id)
        const latestVersion = t?.checkpoints.at(-1)?.version
        return (
          <button
            key={id}
            type="button"
            className={css.pickCard}
            onClick={() => canvasBridge.open(id)}
          >
            <span className={css.pickCardTop}>
              <span className={css.pickCardIcon}><IconCode size={16} /></span>
              <span className={css.pickCardTitle}>{t?.title ?? id}</span>
              {latestVersion !== undefined && <span className={css.pickCardVer}>版本 {latestVersion}</span>}
            </span>
            <span className={css.pickCardBottom}>
              <span className={css.pickCardId}>{id}</span>
              {t?.workingDirty === true && <span className={css.pickCardDirty}>有未保存的修改</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The canvas panel body (shared by both mounts).
 * @param props - state + fullscreen flag.
 */
function CanvasBody({ state }: { state: CanvasSnapshot }) {
  const [theme] = useState(hostArtifactTheme)
  const [submitPhase, setSubmitPhase] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle')
  const [revertPhase, setRevertPhase] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle')
  /** Body view: live preview iframe vs. the raw source of the VIEWED version. */
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview')
  const settledFrameRef = useRef<HTMLIFrameElement | null>(null)
  const streamFrameRef = useRef<HTMLIFrameElement | null>(null)
  /** Synchronous submit re-entrancy lock (state updates can't gate same-tick
   *  duplicate intents — see onSubmit). */
  const submittingRef = useRef(false)
  /** Bumped to force-remount the settled iframe — 刷新 preview AND the
   *  post-submit state reset (a remount re-runs the page's scripts, which is
   *  exactly the artifact's initial state). */
  const [refreshTick, setRefreshTick] = useState(0)
  const settledResizeId = useId()
  const streamResizeId = useId()

  const timeline = state.selectedId === undefined ? undefined : state.timelines.get(state.selectedId)
  // Live preview whenever a generation is in flight (auto-open OR the user
  // opened the panel manually during generation).
  const streaming = state.reportedStream ?? state.runningStream

  // The persistent stream bridge receives html by postMessage — the iframe
  // never reloads while the model writes.
  // The panel body owns its height — skip the stream doc's measure probe
  // (it walks every element on each streamed chunk for nothing).
  const streamSrcDoc = useMemo(() => buildStreamingBridgeDocument(streamResizeId, theme, { scrollable: true, measure: false }), [streamResizeId, theme])
  useEffect(() => {
    if (streaming === undefined) return
    streamFrameRef.current?.contentWindow?.postMessage({ type: 'dsh-artifact-stream', html: streaming.html }, '*')
  }, [streaming, streamSrcDoc])

  const checkpoints = timeline?.checkpoints ?? []
  const count = checkpoints.length
  const index = count === 0 ? -1 : Math.min(Math.max(state.viewIndex, 0), count - 1)
  const viewedCheckpoint = index >= 0 ? checkpoints[index] : undefined
  const viewingLatest = index >= 0 && index === count - 1
  const workingHtml = timeline?.workingHtml
  const dirtyWorking = timeline?.workingDirty === true
  // "当前状态" = 内容等于工作副本的那个检查点：回退后它常常是个旧版本；
  // 只有工作副本上压着未保存的 patch 时，"当前"才退化到最新版本的槽位。
  const matchIdx = checkpoints.findIndex(checkpoint => checkpoint.html === workingHtml)
  const currentIdx = dirtyWorking || matchIdx < 0 ? count - 1 : matchIdx
  const displayHtml = index < 0
    ? workingHtml
    : (dirtyWorking && viewingLatest ? workingHtml : viewedCheckpoint?.html)
  /** Highlighted source for the 源码 view — memoized per content so a big
   *  artifact is tokenized once per patch, not per render. */
  const displayHighlighted = useMemo(
    () => displayHtml === undefined ? '' : highlightHtml(displayHtml),
    [displayHtml],
  )
  const streamingHighlighted = useMemo(
    () => streaming === undefined || viewMode !== 'source' ? '' : highlightHtml(streaming.html),
    [streaming, viewMode],
  )
  const dirty = dirtyWorking && (viewingLatest || index < 0)

  // 回退 only makes sense when the viewed checkpoint differs from the current
  // working copy (older version, or unsaved edits on top of the newest).
  const revertRelevant = viewedCheckpoint !== undefined
    && timeline !== undefined
    && timeline.workingHtml !== undefined
    && viewedCheckpoint.html !== timeline.workingHtml
  const pendingHere = state.pending !== undefined
    && state.selectedId !== undefined
    && state.pending.id === state.selectedId
  const pendingLabel = state.pending === undefined ? ''
    : state.pending.op === 'patch' ? '修改'
      : state.pending.op === 'save' ? '保存版本'
        : state.pending.op === 'revert' ? '回退'
          : state.pending.op
  const settledSrcDoc = useMemo(
    () => displayHtml === undefined ? undefined : buildSandboxedHtmlDocument(displayHtml, settledResizeId, theme, { scrollable: true }),
    [displayHtml, settledResizeId, theme],
  )

  useEffect(() => {
    if (submitPhase !== 'ok' && submitPhase !== 'fail') return
    const handle = setTimeout(() => setSubmitPhase('idle'), 1600)
    return () => clearTimeout(handle)
  }, [submitPhase])
  useEffect(() => {
    if (revertPhase !== 'ok' && revertPhase !== 'fail') return
    const handle = setTimeout(() => setRevertPhase('idle'), 1600)
    return () => clearTimeout(handle)
  }, [revertPhase])

  // SUBMIT-INTENT auto-push: for artifacts the model declared `interactive`,
  // a click on an in-page [data-artifact-submit] element or a genuine form
  // submission inside the iframe collects + submits immediately (the sandbox
  // pings us per such event — plain controls stay silent by design). The
  // header「提交交互」button is the other, chrome-level trigger.
  const interactive = timeline?.interactive === true
  // NO dependency array on purpose: re-subscribing every render keeps the
  // captured `onSubmit` current (it closes over the latest timeline/pending
  // state). Replacing it with deps + a ref is a refactor, not a fix; adding
  // deps naively would freeze a stale `onSubmit` into the listener.
  useEffect(() => {
    if (!interactive) return
    const onMessage = (event: MessageEvent): void => {
      const data: unknown = event.data
      if (data === null || typeof data !== 'object') return
      const record = data as Record<string, unknown>
      if (record.type !== 'dsh-artifact-submit-intent' || record.id !== settledResizeId) return
      if (event.source !== settledFrameRef.current?.contentWindow) return
      void onSubmit()
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
    }
  })

  const onSubmit = async (): Promise<void> => {
    if (state.selectedId === undefined || settledFrameRef.current === null) return
    if (pendingHere || streaming !== undefined) return
    // Synchronous re-entrancy lock: the sandbox's 80ms latch merges the
    // click+form-submit pair of one gesture, but any other same-tick double
    // intent (two windows, programmatic duplicates) must not issue two
    // /artifact-submit commands either — one gesture, one message.
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitPhase('busy')
    try {
      const data = await collectFrame(settledFrameRef.current, settledResizeId)
      const ok = data === undefined
        ? false
        : await submitInteraction(state.selectedId, timeline?.title, data)
      setSubmitPhase(ok ? 'ok' : 'fail')
      if (ok) {
        // 提交完成后把 artifact 初始化:重新挂载 iframe 重跑脚本 —— 表单清空、
        // 游戏回到初始状态,__dshArtifactData 回到初值。
        setRefreshTick(tick => tick + 1)
      }
    } finally {
      submittingRef.current = false
    }
  }

  const onRevert = async (): Promise<void> => {
    const checkpoint = viewedCheckpoint
    if (timeline === undefined || checkpoint === undefined) return
    setRevertPhase('busy')
    const ok = await submitRevert(timeline.id, checkpoint.version, timeline.title)
    setRevertPhase(ok ? 'ok' : 'fail')
    if (ok) {
      // Server-side silently wrote the new working copy; sync the canvas
      // NOW — otherwise the panel keeps rendering the pre-revert version
      // until the model's next op (and shows a stale label on top).
      canvasBridge.applyLocalRevert(timeline.id, checkpoint.version)
    }
  }

  /** Download the version the canvas is currently showing: a browsed-old
   *  checkpoint downloads that saved version; the newest view downloads the
   *  working copy (unsaved patches included). Hidden entirely while the
   *  canvas shows nothing. */
  const onDownload = (): void => {
    if (displayHtml === undefined) return
    const base = timeline?.title ?? timeline?.id ?? 'artifact'
    const suffix = viewedCheckpoint !== undefined && !viewingLatest ? `-版本${viewedCheckpoint.version}` : ''
    const blob = new Blob([displayHtml], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${base}${suffix}.html`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const selectedLabel = (id: string): string => {
    const entry = state.timelines.get(id)
    return entry?.title ?? id
  }


  return (
    <div
      className={`${css.canvas} ${css.canvasDock}`}
      role="complementary"
      aria-label="HTML artifact 画布"
    >
      <header className={css.canvasHead}>
        <div className={css.headRow}>
          {state.order.length > 0 ? (
            <select
              className={css.artifactSelect}
              value={state.selectedId ?? ''}
              onChange={(event) => {
                if (event.target.value !== '') canvasBridge.select(event.target.value)
              }}
            >
              {streaming !== undefined && state.selectedId === undefined
                ? <option value="">正在生成…</option>
                : null}
              {state.order.filter(id => state.timelines.get(id)?.destroyed !== true).map(id => <option key={id} value={id}>{selectedLabel(id)}</option>)}
            </select>
          ) : <span className={css.headNote}>{streaming === undefined ? '尚无 artifact' : '正在生成…'}</span>}
          {count > 0 && (
            <span className={css.verBadge}>
              版本 {viewedCheckpoint?.version ?? '–'}
              {dirty && <i className={css.dirtyDot} title="有未保存的修改">未保存</i>}
            </span>
          )}
        </div>
        <div className={css.headRow}>
          {count > 0 && (
            <span className={css.navCluster}>
              <button
                type="button" className={css.iconBtn} title="后退（更早的版本）"
                disabled={index <= 0} onClick={() => canvasBridge.navigate(-1)}
              ><IconChevronLeft /></button>
              <span className={css.count}>{`${index + 1}/${count}`}</span>
              <button
                type="button" className={css.iconBtn} title="前进（更新的版本）"
                disabled={viewingLatest} onClick={() => canvasBridge.navigate(1)}
              ><IconChevronRight /></button>
            </span>
          )}
          {count > 0 && (
            <button
              type="button" className={css.textBtn} onClick={onDownload}
              title={(dirtyWorking && (viewingLatest || index < 0)) ? '下载当前内容（含未保存的修改）' : `下载版本 ${viewedCheckpoint?.version ?? ''}`}
            >
              <IconDownload />下载
            </button>
          )}
          {displayHtml !== undefined && streaming === undefined && (
            <button
              type="button" className={css.textBtn}
              onClick={() => setRefreshTick(tick => tick + 1)}
              title="刷新预览:重载页面并重新运行脚本(回到初始状态)"
            >
              <IconRefresh />刷新
            </button>
          )}
          {(streaming !== undefined || displayHtml !== undefined) && (
            <button
              type="button" className={css.textBtn}
              onClick={() => setViewMode(mode => mode === 'source' ? 'preview' : 'source')}
              title={viewMode === 'source' ? '回到实时预览' : '查看当前内容的纯文本源码'}
            >
              {viewMode === 'source' ? <><IconEye />预览</> : <><IconCode />源码</>}
            </button>
          )}
          {displayHtml !== undefined && state.persistDir !== undefined && (
            <button
              type="button" className={css.textBtn}
              onClick={() => canvasBridge.openInEditor()}
              title="在侧边栏编辑器中打开该文件（带语法高亮）"
            >
              <IconFileCode />编辑器
            </button>
          )}
          {count > 0 && revertRelevant && (
            <button type="button" className={css.textBtn} onClick={() => void onRevert()} disabled={revertPhase === 'busy'}>
              {revertPhase === 'ok' ? <><IconCheck />已回退</>
                : revertPhase === 'fail' ? '回退失败'
                  : <><IconRevert />回退此版本</>}
            </button>
          )}
          {count > 0 && timeline?.interactive === true && (
            <button
              type="button" className={css.textBtn} onClick={() => void onSubmit()}
              disabled={submitPhase === 'busy' || streaming !== undefined}
              title={streaming !== undefined ? '生成完成后才能收集交互数据' : '收集表单与点击数据并发给模型'}
            >
              {submitPhase === 'ok' ? <><IconCheck />已提交</>
                : submitPhase === 'fail' ? '提交失败'
                  : <><IconSend />提交交互</>}
            </button>
          )}
        </div>
      </header>

      {streaming !== undefined ? (
        <div className={css.canvasBody}>
          <div className={css.genBar}>
            <i className={css.pulse} />
            正在生成 HTML artifact{streaming.title === undefined ? '' : `「${streaming.title}」`}…嵌入脚本会在生成完成后运行。
          </div>
          {/* Like the settled surface: keep the streaming bridge MOUNTED in
              source mode — remounting it would lose the accumulated srcDoc
              until the next streamed chunk re-fires the push effect. */}
          <iframe
            ref={streamFrameRef}
            className={css.canvasFrame}
            style={viewMode === 'source' ? { display: 'none' } : undefined}
            sandbox="allow-scripts"
            srcDoc={streamSrcDoc}
            title="artifact 生成预览"
          />
          {viewMode === 'source' && (
            <pre
              className={`${css.srcPre} hljs`}
              // highlight.js output is safe: every literal char is escaped
              // before token spans are added.
              dangerouslySetInnerHTML={{ __html: streamingHighlighted }}
            />
          )}
        </div>
      ) : pendingHere ? (
        <div className={css.canvasBody}>
          <div className={css.pending}>
            <i className={css.pulse} />
            <p>正在{pendingLabel}…</p>
            <p className={css.emptyHint}>完成后自动更新预览。</p>
          </div>
        </div>
      ) : timeline === undefined || displayHtml === undefined ? (
        <div className={css.empty}>
          <IconCode size={28} />
          {state.order.some(id => state.timelines.get(id)?.destroyed !== true) ? (
            <>
              <p>选择要查看的 artifact：</p>
              <ArtifactPicker state={state} />
            </>
          ) : (
            <>
              <p>还没有可预览的 HTML artifact。</p>
              <p className={css.emptyHint}>让模型调用 artifact 工具创建一个，这里会自动打开并实时预览；每个保存的版本都可以在这里回看与回退。</p>
            </>
          )}
        </div>
      ) : (
        <div className={css.canvasBody}>
          {timeline.destroyed && <div className={css.warnBar}>该 artifact 已被删除，以下为最后的内容。</div>}
          {index >= 0 && index !== currentIdx && viewedCheckpoint !== undefined && (
            <div className={css.historyBar}>
              正在查看历史 · 版本 {viewedCheckpoint.version}（共 {count} 个）
              <button type="button" className={css.miniBtn} onClick={() => canvasBridge.jumpCurrent()}>回到当前</button>
              {revertRelevant && <button type="button" className={css.miniBtn} onClick={() => void onRevert()}>回退到此版本</button>}
            </div>
          )}
          {/* Source view keeps the iframe MOUNTED (hidden) so a page's script
              state survives a 预览↔源码 round-trip. */}
          <iframe
            key={`${state.selectedId}:${refreshTick}`}
            ref={settledFrameRef}
            className={css.canvasFrame}
            style={viewMode === 'source' ? { display: 'none' } : undefined}
            sandbox="allow-scripts"
            srcDoc={settledSrcDoc ?? ''}
            title={`artifact 预览：${timeline.title ?? timeline.id}`}
          />
          {viewMode === 'source' && (
            <pre
              className={`${css.srcPre} hljs`}
              // eslint-disable-next-line react/no-danger -- same safe pipeline.
              dangerouslySetInnerHTML={{ __html: displayHighlighted }}
            />
          )}
        </div>
      )}
    </div>
  )
}


/**
 * The canvas TAB BODY (the DSH native right-sidebar tab registered by
 * better-sidebar). Native fullscreen and width are the panel's own chrome; the
 * tab body only owns its content.
 *
 * MOUNT = OPEN: dockkit renders the ACTIVE tab's body alone, so this component
 * being mounted means the native tab exists and is frontmost. The bridge's
 * `open` flag never gates this render — it only drives auto-open and rebind
 * restore — which is what keeps selection/state alive across tab switches and
 * session switches (both unmount the body without closing the tab).
 */
export function CanvasTabContent() {
  const state = useCanvasState()
  // First render with no selection: exactly one artifact → open it directly
  // (the model just created it — the user wants the canvas, not a picker);
  // multiple → the picker; none → the empty hint.
  useEffect(() => {
    // The host index covers artifacts the truncated window lost; ask for it on
    // mount (the tab can be opened straight from the "+" guide, never passing
    // through openUi).
    canvasBridge.ensureHostIndex()
  }, [])
  useEffect(() => {
    if (state.selectedId !== undefined) return
    const alive = state.order.filter(id => state.timelines.get(id)?.destroyed !== true)
    const only = alive[0]
    if (alive.length === 1 && only !== undefined) canvasBridge.select(only)
  }, [state.selectedId, state.order])
  if (state.selectedId === undefined) {
    if (state.order.some(id => state.timelines.get(id)?.destroyed !== true)) {
      return (
        <div className={css.tabEmpty}>
          <IconCode size={20} />
          <p className={css.pickCardHint}>选择要查看的 artifact：</p>
          <ArtifactPicker state={state} />
        </div>
      )
    }
    return <div className={css.tabEmpty}>会话里还没有 HTML artifact — 让模型调用 artifact 工具创建一个。</div>
  }
  return <CanvasBody state={state} />
}
