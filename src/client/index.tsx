/**
 * Registers the artifact plugin's browser half:
 * - the compact artifact card into the keyed `tool.call.toolview` slot
 *   (click opens the canvas; no inline preview);
 * - the CANVAS as a tab in DSH's NATIVE right sidebar (registered through
 *   dsh-better-sidebar, the required peer: width / fullscreen / collapse /
 *   per-session layout are the native panel's own);
 * - the `artifact-draft` chat node (Definition on the runtime's
 *   `conversationEvents` service + a keyed `conversation.chat.node` renderer)
 *   that reports the streaming create to the canvas bridge;
 * - the canvas bridge singleton (sessions tracking, timeline scan, submission
 *   and revert command delivery).
 * @module
 */
import { useEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { ArtifactRow } from './ArtifactRow.tsx'
import { CanvasTabContent } from './canvas/panel.tsx'
import { CANVAS_TAB_TYPE, canvasBridge, type SidebarFace } from './canvas/state.ts'
import { IconCode } from './icons.tsx'
import { ARTIFACT_TOOL_NAMES } from '../tool-name.ts'

/** The canvas tab body with the native-close tracker. better-sidebar ≥0.19
 *  mounts tabs in the DSH native sidebar-right panel, whose adapter fires NO
 *  lifecycle callbacks (`onClose` never runs on a native close) — so the body
 *  unmount is the close signal: on unmount the bridge marks THIS tab's session
 *  closed, which stops the stale-open auto-re-open (session switch / next
 *  version event). Panel collapse keeps the body mounted (`visible: false`),
 *  so a collapse is never misread as a close. */
function CanvasTabBody(props: { sessionId?: string }): React.ReactNode {
  const sessionId = props.sessionId
  useEffect(() => () => {
    if (sessionId !== undefined) canvasBridge.onTabUnmount(sessionId as never)
  }, [sessionId])
  return <CanvasTabContent />
}

/** Required services: the slot registry, the conversation-node registry, the
 *  sessions service (the canvas bridge follows the current session), and the
 *  dsh-better-sidebar workbench — the canvas's REQUIRED host (declare it as
 *  a peer in practice: install dsh-better-sidebar alongside this plugin). */
export const inject = ['slots', 'uiConversation', 'sessions', 'betterSidebar']


/**
 * Mount the artifact cards, the draft node, and the canvas panel.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('tool.call.toolview', function* () {
    // ONE registration PER NAME: this slot is keyed by tool name, so a card for a
    // call logged before the rename needs its own key to keep rendering.
    for (const key of ARTIFACT_TOOL_NAMES) {
      yield ctx.slots.register({
        name: 'tool.call.toolview',
        key,
      }, ArtifactRow)
    }
  })
  // The canvas bridge: current-session tracking + command delivery for the
  // plugin lifetime. Also exposed for manual debugging / e2e probing.
  ctx.effect(() => canvasBridge.init(ctx), 'dsh-canvas: canvas bridge')
  ;(globalThis as { __dshArtifactCanvas?: unknown }).__dshArtifactCanvas = canvasBridge
  // The canvas lives in the better-sidebar workbench as a native tab
  // (panes/splits/float/resize and per-session isolation are the sidebar's
  // own). betterSidebar is injected — the service is real (its client bundle
  // publishes ctx.provide("betterSidebar", service) before we load); the
  // Context TYPE just doesn't know it, hence the structural cast.
  const sidebar = (ctx as unknown as { betterSidebar: SidebarFace }).betterSidebar
  canvasBridge.attachSidebar(sidebar)
  ctx.effect(() => sidebar.registerTab({
    id: CANVAS_TAB_TYPE,
    title: '画布',
    icon: <IconCode size={14} />,
    single: true,
    order: 60,
    component: (props) => {
      // The tab body's scope carries the session id — the unmount tracker
      // needs it to mark the RIGHT session closed (see CanvasTabBody).
      const sessionId = (props as { scope?: { sessionId?: string } } | undefined)?.scope?.sessionId
      return sessionId === undefined ? <CanvasTabBody /> : <CanvasTabBody sessionId={sessionId} />
    },
  }), 'dsh-canvas: sidebar tab')
}
