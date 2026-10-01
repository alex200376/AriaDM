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

function loadFormats(): Formats {
  const source = readFileSync(
    new URL('../../resources/extension/src/formats.js', import.meta.url),
    'utf8'
  )
  const target: { AriaDmFormats?: Formats } = {}
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
    expect(rows[0]!.label).toContain('自動')
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
