import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import type { ComponentPropsWithoutRef } from 'react'

import { cn } from '../../lib/cn'

/**
 * shadcn/ui Select, built on Radix.
 *
 * The app previously used native `<select>` elements, whose popup list is drawn
 * by the OS: in dark mode the options rendered as light text on a white popup.
 * Radix renders the list in our own portal, so `--elevated` / `--fg` decide the
 * colours and no OS styling leaks through.
 *
 * The colour names below intentionally match the rest of the app (`bg-elevated`,
 * `text-fg`, `border-line`) instead of shadcn's default `popover`/`accent`
 * tokens, so there is still a single source of truth for theming.
 */
export const Select = SelectPrimitive.Root
export const SelectGroup = SelectPrimitive.Group
export const SelectValue = SelectPrimitive.Value

export function SelectTrigger({
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>): JSX.Element {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-line bg-elevated px-3 text-left text-[13px] text-fg',
        'transition-colors hover:border-brand/40 focus:border-brand/60 focus:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[placeholder]:text-faint',
        className
      )}
      {...rest}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown size={14} className="shrink-0 text-faint" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  sideOffset = 4,
  ...rest
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Content>): JSX.Element {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={sideOffset}
        // Above Modal (z-50) and CommandPalette (z-60) so a select inside a
        // dialog never renders behind it.
        className={cn(
          'relative z-[80] overflow-hidden rounded-lg border border-line bg-elevated text-fg shadow-2xl',
          // The animations must be scoped to the state: an unconditional
          // `animation` declaration makes Radix's Presence wait for an
          // `animationend` that never fires on close, leaving the popup stuck open.
          'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
          className
        )}
        {...rest}
      >
        <SelectPrimitive.Viewport className="max-h-64 overflow-y-auto p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectLabel({
  className,
  ...rest
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Label>): JSX.Element {
  return (
    <SelectPrimitive.Label
      className={cn('px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint', className)}
      {...rest}
    />
  )
}

export function SelectItem({
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Item>): JSX.Element {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex cursor-default select-none items-center rounded-md py-1.5 pl-2.5 pr-8 text-[13px] text-fg outline-none',
        'data-[highlighted]:bg-line/60',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        className
      )}
      {...rest}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center text-brand">
        <SelectPrimitive.ItemIndicator>
          <Check size={13} strokeWidth={3} />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  )
}

export function SelectSeparator({
  className,
  ...rest
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>): JSX.Element {
  return <SelectPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-line', className)} {...rest} />
}
