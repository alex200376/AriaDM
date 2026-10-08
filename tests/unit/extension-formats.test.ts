import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * The quality menu is rendered twice — in the popup and in the panel over the
 * player — from one file, so that the same page never offers two differently
 * worded lists.
 *
 * It is loaded the way the browser loads it, as a script defining its own global,
 * so the test exercises the shipped file rather than a copy of its rules.
 */

interface Formats {
  sizeLabel(bytes: number): string
  menuFor(result: unknown): { formatId: string; label: string; note: string }[]
}

interface Strings {
  t(key: string, substitutions?: Record<string, unknown>): string
}

/**
 * The shared string table, loaded the way the browser loads it.
 *
 * `formats.js` takes its labels from it, so the test has to supply what the
 * browser supplies — and it is the only way to assert a label without freezing
 * the test to one language.
 */
function loadStrings(): Strings {
  const source = readFileSync(
    new URL('../../resources/extension/src/strings.js', import.meta.url),
    'utf8'
  )
  const target: { AriaDmStrings?: Strings } = {}
  new Function('self', source)(target)
  if (!target.AriaDmStrings) throw new Error('strings.js did not define AriaDmStrings')
  return target.AriaDmStrings
}

const strings = loadStrings()

function loadFormats(): Formats {
  const source = readFileSync(
    new URL('../../resources/extension/src/formats.js', import.meta.url),
    'utf8'
  )
  const target: { AriaDmFormats?: Formats; AriaDmStrings?: Strings } = { AriaDmStrings: strings }
  new Function('self', source)(target)
  if (!target.AriaDmFormats) throw new Error('formats.js did not define AriaDmFormats')
  return target.AriaDmFormats
}

const formats = loadFormats()

describe('menuFor', () => {
  it('keeps the one-click choice as the first row', () => {
    // Opening the menu must not take away what clicking the button used to do,
    // which is why an empty id means "you decide".
    const rows = formats.menuFor({ formats: [{ formatId: '137', label: '1080p · mp4' }] })

    expect(rows[0]!.formatId).toBe('')
    // Compared against the table rather than a literal: the label follows the
    // browser's language, and a hardcoded expectation here is exactly the bug the
    // table exists to remove. `not.toBe` is what proves the table was consulted
    // instead of the key being shown.
    expect(rows[0]!.label).toBe(strings.t('menu.auto'))
    expect(rows[0]!.label).not.toBe('menu.auto')
    expect(rows[1]).toMatchObject({ formatId: '137', label: '1080p · mp4' })
  })

  it('shows the size next to the note when the site reports one', () => {
    const rows = formats.menuFor({
      formats: [
        { formatId: '137', label: '1080p · mp4', note: '1080p', filesize: 23_185_980 }
      ]
    })

    expect(rows[1]!.note).toBe('1080p · 22.1 MB')
  })

  it('survives an answer with nothing in it', () => {
    // A page whose formats could not be listed still has the default row, which
    // is the download that would have happened anyway.
    expect(formats.menuFor({})).toHaveLength(1)
    expect(formats.menuFor(null)).toHaveLength(1)
    expect(formats.menuFor({ formats: [{ label: 'no id' }, null] })).toHaveLength(1)
  })
})

describe('sizeLabel', () => {
  it('reads like a file size rather than a byte count', () => {
    expect(formats.sizeLabel(1_073_741_824)).toBe('1.0 GB')
    expect(formats.sizeLabel(23_185_980)).toBe('22.1 MB')
    expect(formats.sizeLabel(999)).toBe('999 B')
  })

  it('says nothing when the extractor did not report a size', () => {
    expect(formats.sizeLabel(0)).toBe('')
    expect(formats.sizeLabel(null as unknown as number)).toBe('')
  })
})
