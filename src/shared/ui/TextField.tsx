import {
  forwardRef,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react'
import { IconButton } from './Button'

interface Common {
  /** The field's name. Shown above it unless labelHidden. */
  label: string
  /** Keep the label for screen readers only (the unlock screen's single field). */
  labelHidden?: boolean
  /** Help shown under the field and linked to it. */
  hint?: ReactNode
  /** An error shown under the field in place of the hint, linked and announced. */
  error?: ReactNode
  /** Marks the field invalid when its error is shown elsewhere (pass aria-describedby to link it). */
  invalid?: boolean
  /** Geist Mono, for secret values. */
  mono?: boolean
  /** 36px with 14px text (the unlock screen) instead of 32px with 13px. */
  large?: boolean
  /** Something inside the field's right edge, such as the unlock arrow. */
  trailing?: ReactNode
}

type InputProps = Common &
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
    multiline?: false
    /** A password-style field with a show/hide toggle. */
    revealable?: boolean
  }
type AreaProps = Common &
  TextareaHTMLAttributes<HTMLTextAreaElement> & {
    multiline: true
    /**
     * Mask the text as dots with a show/hide toggle. A textarea keeps line
     * breaks and edge spaces exactly as typed, which a password input would
     * strip; WebKit's text-security draws the dots.
     */
    revealable?: boolean
  }

const BOX = 'flex rounded-6 bg-field transition-[box-shadow] duration-150'
// One or the other, never both: two focus-within shadows would be decided
// by CSS order, and an invalid field must stay red while focused.
const VALID = 'shadow-[inset_0_0_0_1px_var(--g6)] focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)]'
const INVALID = 'shadow-[inset_0_0_0_1px_var(--danger),0_0_0_3px_var(--danger-soft)]'
const CONTROL = 'min-w-0 flex-1 bg-transparent text-g1 outline-none placeholder:text-g4 disabled:opacity-55'

/**
 * A labelled text field. The label, hint and error are tied to the control
 * (for, aria-describedby, aria-invalid), so screen readers announce them.
 */
export const TextField = forwardRef<HTMLInputElement | HTMLTextAreaElement, InputProps | AreaProps>(function TextField(props, ref) {
  const { label, labelHidden, hint, error, invalid, mono, large, trailing, className, ...rest } = props
  const id = useId()
  const isInvalid = Boolean(error) || Boolean(invalid)
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  const [shown, setShown] = useState(false)
  const text = `${large ? 'text-14 px-3' : 'text-13 px-2.5'} ${mono ? 'font-mono' : ''}`

  let control: ReactNode
  const revealable = rest.revealable
  if (rest.multiline) {
    const { multiline: _multiline, revealable: _revealable, ...area } = rest as AreaProps
    control = (
      <textarea
        ref={ref as Ref<HTMLTextAreaElement>}
        id={id}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy}
        className={`${CONTROL} ${text} resize-none py-2 leading-[1.5] ${revealable && !shown ? '[-webkit-text-security:disc]' : ''}`}
        {...area}
      />
    )
  } else {
    const { multiline: _multiline, revealable: _revealable, type, ...input } = rest as InputProps
    control = (
      <input
        ref={ref as Ref<HTMLInputElement>}
        id={id}
        type={revealable ? (shown ? 'text' : 'password') : type}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy}
        className={`${CONTROL} ${text} h-full`}
        {...input}
      />
    )
  }
  const reveal = revealable ? (
    <IconButton
      icon={shown ? 'eye-off' : 'eye'}
      label={`Show ${label.toLowerCase()}`}
      aria-pressed={shown}
      size="sm"
      className={rest.multiline ? 'mt-1 mr-1' : 'mr-1 self-center'}
      onClick={() => setShown((s) => !s)}
    />
  ) : null

  return (
    <div data-ui="" className={`flex flex-col gap-2 ${className ?? ''}`}>
      <label htmlFor={id} className={labelHidden ? 'sr-only' : 'text-12 font-medium text-g3'}>
        {label}
      </label>
      <div className={`${BOX} ${isInvalid ? INVALID : VALID} ${rest.multiline ? 'items-start' : `items-center ${large ? 'h-9' : 'h-8'}`}`}>
        {control}
        {reveal}
        {trailing}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-12 leading-[1.4] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-12 leading-[1.4] text-g4">
          {hint}
        </p>
      ) : null}
    </div>
  )
})
