import { describe, expect, it } from 'vitest'

import { accentTriples, brandForegroundFor, hexToRgbTriple } from '@shared/theme'

/**
 * These conversions feed the CSS variables directly, so a wrong answer is not a
 * subtle glitch: it is a brand colour that never appears, or a button whose label
 * is invisible against its own fill.
 */
describe('hexToRgbTriple', () => {
  it('converts a six-digit colour to the bare triple the variables hold', () => {
    expect(hexToRgbTriple('#7c5cff')).toBe('124 92 255')
    expect(hexToRgbTriple('#000000')).toBe('0 0 0')
    expect(hexToRgbTriple('#ffffff')).toBe('255 255 255')
  })

  it('expands the three-digit form', () => {
    expect(hexToRgbTriple('#abc')).toBe('170 187 204')
    expect(hexToRgbTriple('#fff')).toBe('255 255 255')
  })

  it('accepts uppercase and a missing hash, and trims whitespace', () => {
    expect(hexToRgbTriple('7C5CFF')).toBe('124 92 255')
    expect(hexToRgbTriple('  #7c5cff  ')).toBe('124 92 255')
  })

  it('refuses anything that is not a colour, rather than guessing', () => {
    // The empty string is the common case: it is what "no custom accent" means.
    for (const value of ['', '   ', 'red', '#12345', '#1234567', '#gggggg', 'rgb(1,2,3)', '#']) {
      expect(hexToRgbTriple(value)).toBeNull()
    }
  })
})

describe('brandForegroundFor', () => {
  it('keeps white text on the colours the palettes ship', () => {
    for (const hex of ['#7c5cff', '#3b82f6', '#10b981', '#f43f5e', '#64748b', '#000000']) {
      const triples = accentTriples(hex)
      expect(triples?.foreground).toBe('255 255 255')
    }
  })

  it('switches to dark text on a colour white would vanish into', () => {
    // A pale yellow or a near-white accent is the case the presets never cover,
    // and it is the whole reason this function exists.
    for (const hex of ['#fde047', '#facc15', '#ffffff', '#d9f99d']) {
      const triples = accentTriples(hex)
      expect(triples?.foreground).toBe('17 19 24')
    }
  })

  it('reports no triples at all for an unusable colour', () => {
    expect(accentTriples('')).toBeNull()
    expect(accentTriples('not-a-colour')).toBeNull()
  })
})
