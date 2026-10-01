/**
 * Minimal inline SVG icon set for the artifact UI (16px grid, currentColor
 * strokes). Kept local so the client bundle never value-imports a host
 * primitives package.
 * @module
 */
import type { JSX, ReactNode } from 'react'

interface IconProps {
  size?: number
}

function svg(path: ReactNode): (props: IconProps) => JSX.Element {
  return function Icon({ size = 14 }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {path}
      </svg>
    )
  }
}

/** Code brackets (the artifact mark). */
export const IconCode = svg(<><path d="M8 6 2 12l6 6" /><path d="m16 6 6 6-6 6" /></>)

/** Download to file. */
export const IconDownload = svg(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>)

/** Eye (preview). */
export const IconEye = svg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>)

/** Refresh / reload (reinitialize page state). */
export const IconRefresh = svg(<><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" /><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></>)

/** File with code (open in the external editor). */
export const IconFileCode = svg(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="m10 13-2 2 2 2" /><path d="m14 13 2 2-2 2" /></>)

/** Copy to clipboard. */
export const IconCopy = svg(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>)

/** Checkmark (success feedback). */
export const IconCheck = svg(<path d="M20 6 9 17l-5-5" />)

/** Chevron left (older version). */
export const IconChevronLeft = svg(<path d="m15 18-6-6 6-6" />)

/** Chevron right (newer version). */
export const IconChevronRight = svg(<path d="m9 18 6-6-6-6" />)

/** Open-in-canvas arrow. */
export const IconOpen = svg(<><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>)

/** History / revert arrow. */
export const IconRevert = svg(<><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-15-6.7L3 13" /></>)

/** Send / submit interaction data. */
export const IconSend = svg(<><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>)
