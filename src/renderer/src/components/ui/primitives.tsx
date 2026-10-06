import { X } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { forwardRef, useEffect, useState } from 'react'

import { cn } from '../../lib/cn'
import type { Tone } from '../../lib/labels'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

export const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
  info: 'bg-info/15 text-info',
  muted: 'bg-faint/15 text-muted',
  brand: 'bg-brand/15 text-brand'
}

export const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  muted: 'bg-faint',
  brand: 'bg-brand'
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'icon'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-fg hover:brightness-110 active:brightness-95',
  secondary: 'bg-elevated text-fg border border-line hover:bg-line/60',
  ghost: 'text-muted hover:text-fg hover:bg-line/50',
  danger: 'bg-danger/15 text-danger hover:bg-danger/25'
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[12px] gap-1.5',
  md: 'h-9 px-3.5 text-[13px] gap-2',
  icon: 'h-8 w-8 justify-center'
}

/**
 * Both button primitives forward their ref: Radix composes `asChild` triggers
 * (a dropdown trigger wrapping one of these) by cloning the child and attaching
 * a ref to it, which a plain function component silently drops.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-lg font-medium transition-[background-color,filter,color] duration-150',
        'disabled:cursor-not-allowed disabled:opacity-40',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: ReactNode }
>(function IconButton({ label, icon, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors',
        'hover:bg-line/60 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent',
        className
      )}
      {...rest}
    >
      {icon}
    </button>
  )
})

export function Badge({
  tone = 'muted',
  children,
  className,
  dot = false
}: {
  tone?: Tone
  children: ReactNode
  className?: string
  dot?: boolean
}): JSX.Element {
  return (
    <span className={cn('chip whitespace-nowrap', TONE_CLASS[tone], className)}>
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[tone])} />}
      {children}
    </span>
  )
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-lg border border-line bg-elevated px-3 text-[13px] text-fg',
        'placeholder:text-faint focus:border-brand/60 focus:outline-none',
        'disabled:opacity-50',
        className
      )}
      {...rest}
    />
  )
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return (
    <textarea
      className={cn(
        'w-full resize-y rounded-lg border border-line bg-elevated p-3 font-mono text-[12px] leading-relaxed text-fg',
        'placeholder:text-faint focus:border-brand/60 focus:outline-none',
        className
      )}
      {...rest}
    />
  )
}

interface SelectOption {
  value: string
  label: string
}

/**
 * A labelled dropdown for the common case, composing the shadcn `Select` with
 * `Field`. Values must be non-empty: Radix rejects an empty string as an item
 * value, so a placeholder meaning ("automatic") needs a sentinel value that the
 * caller maps back on change.
 */
export function SelectField({
  label,
  hint,
  value,
  options,
  onValueChange,
  placeholder,
  className,
  disabled
}: {
  label: string
  hint?: string
  value: string
  options: SelectOption[]
  onValueChange(value: string): void
  placeholder?: string
  className?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <Field label={label} hint={hint} className={className}>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder} className="min-w-0 truncate" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange(next: boolean): void
  disabled?: boolean
  label: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200',
        checked ? 'bg-brand' : 'bg-line',
        disabled && 'cursor-not-allowed opacity-40'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] duration-200',
          checked ? 'left-[1.15rem]' : 'left-0.5'
        )}
      />
    </button>
  )
}

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="text-[12px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-[11px] leading-relaxed text-faint">{hint}</span>}
    </label>
  )
}

export function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-faint">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/**
 * A labelled range input.
 *
 * Two callbacks rather than one because a drag emits an event per pixel:
 * `onPreview` paints the change straight away (a CSS variable, no round trip),
 * and `onCommit` writes it once the drag ends — otherwise one two-second drag
 * would turn into a hundred writes of settings.json.
 *
 * The handle keeps following the draft until settings report the committed
 * value, so it never snaps back during the moment between release and the write
 * landing.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onPreview,
  onCommit
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onPreview?: (value: number) => void
  onCommit: (value: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? value

  useEffect(() => {
    if (draft !== null && value === draft) setDraft(null)
  }, [draft, value])

  const commit = (): void => {
    if (draft === null) return
    if (draft === value) setDraft(null)
    else onCommit(draft)
  }

  return (
    <label className="block space-y-1.5">
      <span className="flex items-center justify-between text-[12px] font-medium text-muted">
        <span>{label}</span>
        <span className="text-tabular text-fg">
          {shown}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(event) => {
          const next = Number(event.target.value)
          setDraft(next)
          onPreview?.(next)
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line accent-brand"
      />
    </label>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }): JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-faint">{children}</h3>
      {action}
    </div>
  )
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 'max-w-2xl'
}: {
  open: boolean
  title: string
  subtitle?: string
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  width?: string
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return undefined
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // A Radix popup opened from inside the dialog (a select list, a menu) is
      // portalled next to the dialog and closes on this very key event, which it
      // does not stop from reaching the window. Closing the dialog as well would
      // throw away everything the user typed, so the key is left to the popup.
      //
      // The check reads the event target rather than the DOM because React may
      // already have committed the popup's removal by the time this listener
      // runs; listening in the capture phase keeps the target intact.
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-radix-popper-content-wrapper]')) return
      onClose()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 animate-fade-in bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl',
          'animate-slide-up',
          width
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[12px] text-muted">{subtitle}</p>}
          </div>
          <IconButton label="關閉" icon={<X size={16} />} onClick={onClose} />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</footer>}
      </div>
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  body,
  action
}: {
  icon: ReactNode
  title: string
  body: string
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-line/60 text-faint">{icon}</div>
      <div>
        <p className="text-[14px] font-medium text-fg">{title}</p>
        <p className="mt-1 max-w-sm text-[12px] leading-relaxed text-muted">{body}</p>
      </div>
      {action}
    </div>
  )
}

export function Spinner({ className }: { className?: string }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent',
        className
      )}
    />
  )
}
