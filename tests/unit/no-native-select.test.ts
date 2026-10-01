import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guards the fix for the "white dropdown" bug.
 *
 * Native `<select>` popups are painted by the OS and ignored the dark theme, so
 * options rendered as light text on a white list. Every dropdown now goes
 * through the Radix-based component in `components/ui/select.tsx`; this test
 * makes sure a native one cannot quietly come back.
 */
const RENDERER_SRC = fileURLToPath(new URL('../../src/renderer/src', import.meta.url))

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

/** Comments are allowed to mention the native element; only real JSX is checked. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('renderer form controls', () => {
  const sources = walk(RENDERER_SRC).filter((file) => file.endsWith('.tsx') || file.endsWith('.ts'))

  it('renders no native <select>/<option>, which the OS paints white in dark mode', () => {
    const offenders = sources.filter((file) =>
      /<select[\s>]|<option[\s>]/.test(stripComments(readFileSync(file, 'utf8')))
    )
    expect(offenders).toEqual([])
  })

  it('declares a color-scheme per theme so OS-painted controls follow it', () => {
    const css = readFileSync(join(RENDERER_SRC, 'styles/globals.css'), 'utf8')
    expect(css).toMatch(/color-scheme:\s*light/)
    expect(css).toMatch(/color-scheme:\s*dark/)
  })
})
