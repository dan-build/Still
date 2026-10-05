import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Icon, type IconName } from './Icon'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BASE =
  'focus-ring inline-flex items-center justify-center gap-1.5 rounded-6 text-13 font-medium whitespace-nowrap select-none ' +
  'transition-[background-color,color,box-shadow,transform] duration-150 ' +
  'active:scale-[0.97] motion-reduce:active:scale-100 ' +
  'disabled:opacity-45 disabled:active:scale-100'

const VARIANTS: Record<Variant, string> = {
  // The accent's deep fill, white text in both themes.
  primary: 'bg-accent-fill text-on-accent hover:bg-accent-fill-hover',
  secondary: 'text-g1 shadow-[inset_0_0_0_1px_var(--g7)] hover:bg-wash',
  ghost: 'text-g3 hover:bg-wash hover:text-g1',
  danger: 'bg-danger text-on-danger hover:bg-danger-hover',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  /** sm is 28px tall (bars, rows, dialogs); md is 32px (screens and forms). */
  size?: 'sm' | 'md'
  /** Fill the width of the container. */
  block?: boolean
  /** An icon before the label. */
  icon?: IconName
}

/** A text button. Its label is its accessible name. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', block, icon, className, children, type = 'button', ...rest },
  ref,
) {
  const sizing = size === 'md' ? 'h-8 px-4' : 'h-7 px-3'
  return (
    <button
      ref={ref}
      type={type}
      data-ui=""
      className={[BASE, sizing, VARIANTS[variant], block ? 'w-full' : '', className ?? ''].join(' ')}
      {...rest}
    >
      {icon && <Icon name={icon} className="-ml-0.5" />}
      {children}
    </button>
  )
})

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  icon: IconName
  /** The accessible name, required: the icon alone says nothing to a screen reader. */
  label: string
  size?: 'sm' | 'md'
  /** Turns red on hover, for destructive actions. */
  danger?: boolean
}

/**
 * A square button showing one icon. Toggles pass aria-pressed, which colours
 * the icon with the accent while pressed.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', danger, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      data-ui=""
      className={[
        'focus-ring inline-flex shrink-0 items-center justify-center rounded-6 text-g5',
        'transition-[background-color,color] duration-150 hover:bg-wash hover:text-g1',
        'aria-pressed:text-accent disabled:opacity-45',
        danger ? 'hover:text-danger' : '',
        size === 'sm' ? 'size-6' : 'size-7',
        className ?? '',
      ].join(' ')}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  )
})
