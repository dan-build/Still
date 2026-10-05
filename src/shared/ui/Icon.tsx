import { useId, type ReactNode } from 'react'

/*
  Still's own icon set, drawn for the app (no icon library). Approved on the
  design mockup, 2026-10-05.

  Every icon follows the same rules, which this component enforces:
  - a 16×16 grid, drawn at 16px, 1.5px stroke, round caps and joins,
    currentColor, outline only; a dot is a filled circle of radius 1;
  - straight horizontal and vertical strokes sit on .25 or .75, so both edges
    land on device pixels at 2×. Glyphs symmetric about the centre (plus,
    the warning stem, the arrow) sit on 8, trading crispness for symmetry;
  - a live area of 1.75–14.25, and a corner radius of 2 for bodies (1 for
    small parts such as lids and handles).
*/

const dot = (cx: number, cy: number) => <circle cx={cx} cy={cy} r={1} fill="currentColor" stroke="none" />

const EYE = 'M1.75 8C3.1 5.1 5.35 3.75 8 3.75S12.9 5.1 14.25 8C12.9 10.9 10.65 12.25 8 12.25S3.1 10.9 1.75 8Z'

const ICONS = {
  lock: () => (
    <>
      <rect x="3.25" y="7.25" width="9.5" height="6.5" rx="2" />
      <path d="M5.25 7.25V5.25a2.75 2.75 0 0 1 5.5 0v2" />
    </>
  ),
  unlock: () => (
    <>
      <rect x="3.25" y="7.25" width="9.5" height="6.5" rx="2" />
      <path d="M5.25 7.25V5.25a2.75 2.75 0 0 1 5.32-.98" />
    </>
  ),
  password: () => (
    <>
      <rect x="1.75" y="4.75" width="12.5" height="6.5" rx="2" />
      {dot(5, 8)}
      {dot(8, 8)}
      {dot(11, 8)}
    </>
  ),
  key: () => (
    <>
      <circle cx="5" cy="8.25" r="3.25" />
      <path d="M8.25 8.25h5.5M11.75 8.25v2M13.75 8.25v1.5" />
    </>
  ),
  note: () => (
    <>
      <rect x="3.25" y="2.25" width="9.5" height="12" rx="2" />
      <path d="M5.75 5.25h4.5M5.75 8.25h4.5M5.75 11.25h2.5" />
    </>
  ),
  eye: () => (
    <>
      <path d={EYE} />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  // The slash cuts a gap through the eye, through a mask with its own id.
  'eye-off': (id: string) => (
    <>
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
        <rect width="16" height="16" fill="#fff" />
        <path d="M2.75 2.75l10.5 10.5" stroke="#000" strokeWidth="3.5" />
      </mask>
      <g mask={`url(#${id})`}>
        <path d={EYE} />
        <circle cx="8" cy="8" r="2" />
      </g>
      <path d="M2.75 2.75l10.5 10.5" />
    </>
  ),
  copy: () => (
    <>
      <rect x="6.25" y="6.25" width="8" height="8" rx="2" />
      <path d="M3.75 9.75a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2" />
    </>
  ),
  check: () => <path d="M3.25 8.5l3.25 3.25 6.25-7" />,
  trash: () => (
    <>
      <path d="M2.25 4.25h11.5" />
      <path d="M5.75 4.25v-1a1 1 0 0 1 1-1h2.5a1 1 0 0 1 1 1v1" />
      <path d="M3.75 4.25v7.5a2 2 0 0 0 2 2h4.5a2 2 0 0 0 2-2v-7.5" />
    </>
  ),
  archive: () => (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="3.5" rx="1" />
      <path d="M2.75 6.25v5.5a2 2 0 0 0 2 2h6.5a2 2 0 0 0 2-2v-5.5" />
      <path d="M6.25 9.25h3.5" />
    </>
  ),
  // A return arrow (back to where it was), not the circular "undo" arrow.
  restore: () => (
    <>
      <path d="M5.25 4.25L2.75 6.75l2.5 2.5" />
      <path d="M2.75 6.75H10a3.25 3.25 0 0 1 0 6.5H7.75" />
    </>
  ),
  plus: () => <path d="M8 3.25v9.5M3.25 8h9.5" />,
  close: () => <path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5" />,
  back: () => <path d="M10.5 3.25L5.75 8l4.75 4.75" />,
  'arrow-right': () => <path d="M2.75 8h10M8.75 3.75L13 8l-4.25 4.25" />,
  more: () => (
    <>
      {dot(4, 8)}
      {dot(8, 8)}
      {dot(12, 8)}
    </>
  ),
  warning: () => (
    <>
      <path d="M6.27 3.39a2 2 0 0 1 3.46 0l4.25 7.36a2 2 0 0 1-1.73 3H3.75a2 2 0 0 1-1.73-3Z" />
      <path d="M8 6.25v2.25" />
      {dot(8, 11)}
    </>
  ),
  // A Lens: a round glass with a highlight on it.
  lens: () => (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M4.75 8a3.25 3.25 0 0 1 3.25-3.25" />
    </>
  ),
} satisfies Record<string, (id: string) => ReactNode>

export type IconName = keyof typeof ICONS

export const ICON_NAMES = Object.keys(ICONS) as IconName[]

interface IconProps {
  name: IconName
  /**
   * What the icon means, when nothing next to it says so. Without a label the
   * icon is decorative and hidden from assistive technology.
   */
  label?: string
  className?: string
}

/** One of Still's icons, always 16px with a 1.5px stroke. */
export function Icon({ name, label, className }: IconProps) {
  const id = useId()
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `shrink-0 ${className}` : 'shrink-0'}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      focusable="false"
    >
      {ICONS[name](`icon-mask${id.replace(/:/g, '')}`)}
    </svg>
  )
}

/**
 * The Still mark: a half sun on a level horizon, with its reflection below in
 * two shorter lines. Drawn with its own stroke at each size, so it never
 * looks heavy when large or faint when small.
 */
export function Mark({ size, stroke, className }: { size: number; stroke: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={(stroke * 16) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      focusable="false"
    >
      <path d="M3 8.25a5 5 0 0 1 10 0" />
      <path d="M1.75 8.25h12.5M4.25 10.75h7.5M6.5 13.25h3" />
    </svg>
  )
}
