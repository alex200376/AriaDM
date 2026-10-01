import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import type { ComponentPropsWithoutRef } from 'react'

import { cn } from '../../lib/cn'

/**
 * shadcn/ui DropdownMenu, built on Radix.
 *
 * The toolbar's secondary actions used to be a row of icon buttons that grew
 * with every feature. A menu keeps the common path (new download, search) on
 * screen and moves the rest one click away, without inventing a second popup
 * style: the tokens here mirror `select.tsx`.
 */
export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
export const DropdownMenuGroup = DropdownMenuPrimitive.Group

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'end',
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>): JSX.Element {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        // Above Modal (z-50) and CommandPalette (z-60), matching the select.
        // The animations are scoped to the state so Radix's Presence is not left
        // waiting on an `animationend` that never fires.
        className={cn(
          'z-[80] min-w-[13rem] overflow-hidden rounded-lg border border-line bg-elevated p-1 text-fg shadow-2xl',
          'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
          className
        )}
        {...rest}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({
  className,
  danger = false,
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { danger?: boolean }): JSX.Element {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'flex cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] outline-none',
        'data-[highlighted]:bg-line/60',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        danger ? 'text-danger data-[highlighted]:bg-danger/15' : 'text-fg',
        className
      )}
      {...rest}
    />
  )
}

export function DropdownMenuSeparator({
  className,
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>): JSX.Element {
  return <DropdownMenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-line', className)} {...rest} />
}

export function DropdownMenuLabel({
  className,
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>): JSX.Element {
  return (
    <DropdownMenuPrimitive.Label
      className={cn('px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint', className)}
      {...rest}
    />
  )
}
