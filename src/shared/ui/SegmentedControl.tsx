import { useId, useRef, type KeyboardEvent } from 'react'
import { Icon, type IconName } from './Icon'

interface Option<T extends string> {
  value: T
  label: string
  icon?: IconName
}

interface SegmentedControlProps<T extends string> {
  /** Names the group (shown above it). */
  label: string
  options: readonly Option<T>[]
  value: T
  onChange: (value: T) => void
}

/**
 * A choice of a few options shown side by side, such as a secret's type.
 * A radio group: one tab stop, arrow keys move the choice.
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange }: SegmentedControlProps<T>) {
  const id = useId()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    let next = step === undefined ? undefined : (index + step + options.length) % options.length
    if (e.key === 'Home') next = 0
    if (e.key === 'End') next = options.length - 1
    if (next === undefined) return
    e.preventDefault()
    onChange(options[next].value)
    buttons.current[next]?.focus()
  }

  return (
    <div className="flex flex-col gap-2">
      <span id={`${id}-label`} className="text-12 font-medium text-g3">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        className="grid gap-0.5 rounded-8 bg-field p-0.5 shadow-[inset_0_0_0_1px_var(--g7)]"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option, index) => {
          const checked = option.value === value
          return (
            <button
              key={option.value}
              ref={(el) => {
                buttons.current[index] = el
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(option.value)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={[
                'focus-ring inline-flex h-7 items-center justify-center gap-1.5 rounded-6 text-13 font-medium',
                'transition-[background-color,color] duration-150',
                checked
                  ? 'bg-raised text-g1 shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_1px_2px_rgb(0_0_0/0.08)] dark:shadow-[0_0_0_1px_rgb(0_0_0/0.5),inset_0_1px_0_rgb(255_255_255/0.06)]'
                  : 'text-g3 hover:text-g1',
              ].join(' ')}
            >
              {option.icon && <Icon name={option.icon} className={checked ? 'text-accent' : 'text-g5'} />}
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
