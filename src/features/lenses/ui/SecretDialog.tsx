import { useContext, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { URL_MAX, USERNAME_MAX, type GeneratorOptions, type NewItem } from '@/features/vault/model/types'
import { GeneratorContext, MAX_LENGTH, MIN_LENGTH, strengthWord } from '@/features/lenses/model/generator'
import { Button, IconButton } from '@/shared/ui/Button'
import { Dialog } from '@/shared/ui/Dialog'
import { Kbd } from '@/shared/ui/Kbd'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { TextField } from '@/shared/ui/TextField'

type ItemType = NewItem['type']

const TYPES = [
  { value: 'password', label: 'Password', icon: 'password' },
  { value: 'key', label: 'API key', icon: 'key' },
  { value: 'note', label: 'Note', icon: 'note' },
] as const

interface SecretDialogProps {
  open: boolean
  onClose: () => void
  /**
   * The secret being edited. Without it the dialog adds a new one. When
   * editing, the value starts empty and is only sent if a new one is typed,
   * so the current secret is never decrypted into the page to edit a label.
   * The caller keys the dialog by the secret, so its fields start fresh.
   */
  editing?: { label: string; type: ItemType; username?: string; url?: string }
  /**
   * Saves the secret; throws if it couldn't be saved. A password's username
   * and website are always sent (blank for none, and for other types).
   */
  onSave: (secret: { label: string; type: ItemType; value?: string; username: string; url: string }) => Promise<void>
  /** Reports a save that failed. */
  onFailed: () => void
}

/** Add secret, or Edit secret: one dialog, as on the approved mockup. */
export default function SecretDialog({ open, onClose, editing, onSave, onFailed }: SecretDialogProps) {
  const [type, setType] = useState<ItemType>(editing?.type ?? 'password')
  const [label, setLabel] = useState(editing?.label ?? '')
  const [value, setValue] = useState('')
  const [username, setUsername] = useState(editing?.username ?? '')
  const [url, setUrl] = useState(editing?.url ?? '')
  const [saving, setSaving] = useState(false)
  const labelField = useRef<HTMLInputElement>(null)
  // The generator (Rust's, through App) for passwords; null when not offered.
  const generator = useContext(GeneratorContext)
  const canGenerate = generator !== null && type === 'password'
  // The strength of the generated password in the field, while it's there.
  const [generatedBits, setGeneratedBits] = useState<number | null>(null)
  const [generateFailed, setGenerateFailed] = useState(false)

  const onlyBlank = value !== '' && value.trim() === ''
  const edgeSpace = value.trim() !== '' && value !== value.trim()
  // Counted as Rust counts them (UTF-16, as .length does), after trimming.
  const isPassword = type === 'password'
  const usernameTooLong = isPassword && username.trim().length > USERNAME_MAX
  const urlTooLong = isPassword && url.trim().length > URL_MAX
  // Adding needs a value; editing may keep the current one.
  const ready =
    label.trim() !== '' && (editing ? !onlyBlank : value.trim() !== '') && !usernameTooLong && !urlTooLong && !saving
  const formId = editing ? 'edit-secret' : 'add-secret'

  const reset = () => {
    setLabel(editing?.label ?? '')
    setValue('')
    setUsername(editing?.username ?? '')
    setUrl(editing?.url ?? '')
    setType(editing?.type ?? 'password')
    setGeneratedBits(null)
    setGenerateFailed(false)
  }

  const generate = async (options: GeneratorOptions) => {
    if (!generator) return
    try {
      const { value: password, bits } = await generator.generate(options)
      setValue(password)
      setGeneratedBits(bits)
      setGenerateFailed(false)
    } catch {
      setGenerateFailed(true)
    }
  }

  // A changed option makes a new password at once, and is kept until Still quits.
  const changeOptions = (change: Partial<GeneratorOptions>) => {
    if (!generator) return
    const options = { ...generator.options, ...change }
    generator.setOptions(options)
    void generate(options)
  }

  const close = () => {
    if (saving) return
    reset()
    onClose()
  }

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!ready) return
    setSaving(true)
    try {
      // The value is stored exactly as typed; only the label is trimmed.
      // An empty value while editing keeps the current one.
      await onSave({
        label: label.trim(),
        type,
        value: editing && value === '' ? undefined : value,
        // Only passwords have them; Rust trims them and drops blank ones.
        username: isPassword ? username : '',
        url: isPassword ? url : '',
      })
    } catch {
      setSaving(false)
      onFailed()
      return
    }
    setSaving(false)
    reset()
    onClose()
  }

  // ⌘↵ adds from either field, including the multi-line value.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!saving}
      title={editing ? 'Edit secret' : 'Add secret'}
      initialFocus={labelField}
      footerStart={
        <>
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={!ready}>
            {editing ? (saving ? 'Saving…' : 'Save') : saving ? 'Adding…' : 'Add secret'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
        <SegmentedControl label="Type" options={TYPES} value={type} onChange={setType} />
        <TextField
          ref={labelField}
          label="Label"
          placeholder="What is this for?"
          onKeyDown={onKeyDown}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        {isPassword && (
          <TextField
            label="Username"
            placeholder="Optional"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onKeyDown={onKeyDown}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            error={usernameTooLong ? `A username can be up to ${USERNAME_MAX} characters.` : undefined}
          />
        )}
        <TextField
          label={editing ? 'New value' : 'Value'}
          multiline
          // Passwords and keys are masked as you type, notes are not.
          revealable={type !== 'note'}
          mono={type !== 'note'}
          rows={type === 'note' ? 4 : 1}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={editing ? 'Leave empty to keep the current value' : 'Paste or type the secret here…'}
          onKeyDown={onKeyDown}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            // Typing makes it a different password: its strength no longer applies.
            setGeneratedBits(null)
          }}
          trailing={
            canGenerate ? (
              <IconButton
                icon="dice"
                label="Generate a password"
                title="Generate a password"
                size="sm"
                className="mt-1 mr-1"
                onClick={() => void generate(generator.options)}
              />
            ) : undefined
          }
          error={
            onlyBlank
              ? "A secret can't be only spaces or line breaks."
              : canGenerate && generateFailed
                ? "Couldn't make a password. Try again."
                : undefined
          }
          hint={
            edgeSpace ? (
              <span className="flex items-start justify-between gap-3">
                <span>This secret starts or ends with a space or line break. It will be kept exactly as typed.</span>
                <button
                  type="button"
                  onClick={() => setValue(value.trim())}
                  className="focus-ring shrink-0 rounded-4 font-medium text-accent-text underline underline-offset-2"
                >
                  Remove them
                </button>
              </span>
            ) : editing ? (
              'The current value stays hidden. Type a new one only to replace it.'
            ) : (
              'Kept exactly as typed, including spaces.'
            )
          }
        />
        {canGenerate && generatedBits !== null && (
          <GeneratorOptionsRow options={generator.options} bits={generatedBits} onChange={changeOptions} />
        )}
        {isPassword && (
          <TextField
            label="Website"
            placeholder="Optional, such as https://example.com"
            type="url"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onKeyDown={onKeyDown}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            error={urlTooLong ? `A website can be up to ${URL_MAX} characters.` : undefined}
          />
        )}
      </form>
    </Dialog>
  )
}

const KINDS = [
  { key: 'lower', text: 'a–z', label: 'Lowercase letters' },
  { key: 'upper', text: 'A–Z', label: 'Uppercase letters' },
  { key: 'digits', text: '0–9', label: 'Digits' },
  { key: 'symbols', text: '!#$', label: 'Symbols' },
] as const

const CHIP =
  'focus-ring h-6 rounded-4 px-2 text-12 font-medium text-g4 shadow-[inset_0_0_0_1px_var(--g6)] ' +
  'transition-[background-color,color,box-shadow] duration-150 hover:text-g2 ' +
  'aria-pressed:bg-selected aria-pressed:text-g1 aria-pressed:shadow-none disabled:opacity-45'

/** The generator's options, under the field once a password was generated. */
function GeneratorOptionsRow({
  options,
  bits,
  onChange,
}: {
  options: GeneratorOptions
  bits: number
  onChange: (change: Partial<GeneratorOptions>) => void
}) {
  const chosen = KINDS.filter((kind) => options[kind.key]).length
  const lengthId = useId()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <label htmlFor={lengthId} className="text-12 font-medium text-g3">
          Length
        </label>
        <input
          id={lengthId}
          type="range"
          min={MIN_LENGTH}
          max={MAX_LENGTH}
          value={options.length}
          onChange={(e) => onChange({ length: Number(e.target.value) })}
          className="focus-ring min-w-0 flex-1 rounded-4 accent-accent-fill"
        />
        <span className="w-6 text-right font-mono text-12 text-g2 tabular-nums">{options.length}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {KINDS.map((kind) => (
          <button
            key={kind.key}
            type="button"
            aria-label={kind.label}
            title={kind.label}
            aria-pressed={options[kind.key]}
            // At least one kind stays chosen.
            disabled={options[kind.key] && chosen === 1}
            onClick={() => onChange({ [kind.key]: !options[kind.key] })}
            className={CHIP}
          >
            {kind.text}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={options.avoidLookAlikes}
          title="Leave out 0 O o 1 l I, easy to misread"
          onClick={() => onChange({ avoidLookAlikes: !options.avoidLookAlikes })}
          className={CHIP}
        >
          No look-alikes
        </button>
        <p className="ml-auto text-12 text-g4" aria-live="polite">
          About {bits} bits: {strengthWord(bits)}
        </p>
      </div>
    </div>
  )
}
