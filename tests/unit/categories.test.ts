import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  categoryDisplayName,
  categoryFolderName,
  categoryFolderPath,
  categoryLabel,
  isBuiltinCategory,
  joinFolderPath
} from '@shared/categories'
import { getLocale, setLocale } from '@shared/i18n'
import { DEFAULT_CATEGORIES, type CategoryRule } from '@shared/settings'

function rule(overrides: Partial<CategoryRule> = {}): CategoryRule {
  return { id: 'custom', name: '自訂', extensions: [], dir: '', postAction: {}, ...overrides }
}

const initialLocale = getLocale()

afterEach(() => {
  setLocale(initialLocale)
})

describe('categoryDisplayName', () => {
  it('translates an untouched built-in in both languages', () => {
    setLocale('zh-TW')
    expect(categoryDisplayName(DEFAULT_CATEGORIES[0]!)).toBe('影片')
    setLocale('en')
    expect(categoryDisplayName(DEFAULT_CATEGORIES[0]!)).toBe('Video')
  })

  it('keeps a name the user typed, in any language', () => {
    setLocale('en')
    expect(categoryDisplayName(rule({ id: 'video', name: 'My films' }))).toBe('My films')
    expect(categoryDisplayName(rule({ name: 'Podcasts' }))).toBe('Podcasts')
  })

  it('knows which ids came with the app', () => {
    expect(isBuiltinCategory('video')).toBe(true)
    expect(isBuiltinCategory('cat-123')).toBe(false)
  })
})

describe('categoryFolderName', () => {
  it('uses the localized folder label, not the filter label', () => {
    setLocale('en')
    expect(categoryFolderName(DEFAULT_CATEGORIES[0]!)).toBe('Videos')
    expect(categoryFolderName(DEFAULT_CATEGORIES[3]!)).toBe('Documents')
  })

  it('uses a pinned folder name over the type name', () => {
    expect(categoryFolderName(rule({ name: '影片', folderName: 'Films' }))).toBe('Films')
    expect(categoryFolderName(rule({ name: '影片', folderName: 'Films/HD' }))).toBe('Films_HD')
  })

  it('keeps a folder name stable across interface languages once pinned', () => {
    const pinned = categoryFolderName({ ...DEFAULT_CATEGORIES[0]!, folderName: 'Films' })
    setLocale('en')
    expect(categoryFolderName({ ...DEFAULT_CATEGORIES[0]!, folderName: 'Films' })).toBe(pinned)
  })
})

describe('categoryFolderPath', () => {
  it('files a type into a subfolder of the default folder', () => {
    setLocale('zh-TW')
    // The default join keeps the base's separator, which is what the renderer
    // previews; the main process passes `path.join` (see the last case).
    expect(categoryFolderPath(DEFAULT_CATEGORIES, 'video', 'D:/Downloads', true)).toBe(
      'D:/Downloads/影片'
    )
  })

  it('uses the localized subfolder while the interface is English', () => {
    setLocale('en')
    expect(categoryFolderPath(DEFAULT_CATEGORIES, 'video', 'D:/Downloads', true)).toBe(
      'D:/Downloads/Videos'
    )
  })

  it('keeps a folder the type already names, exactly as written', () => {
    const categories = [rule({ id: 'video', name: '影片', dir: 'D:/Media/Videos' })]
    expect(categoryFolderPath(categories, 'video', 'D:/Downloads', true)).toBe('D:/Media/Videos')
  })

  it('leaves the destination at the default folder when sorting is off', () => {
    expect(categoryFolderPath(DEFAULT_CATEGORIES, 'video', 'D:/Downloads', false)).toBe('D:/Downloads')
  })

  it('does not invent a folder for an unknown category', () => {
    expect(categoryFolderPath(DEFAULT_CATEGORIES, 'nope', 'D:/Downloads', true)).toBe('D:/Downloads')
  })

  it('accepts the native join the main process passes in', () => {
    expect(categoryFolderPath(DEFAULT_CATEGORIES, 'audio', 'C:/downloads', true, path.join)).toBe(
      path.join('C:/downloads', '音樂')
    )
  })
})

describe('joinFolderPath', () => {
  it('keeps the base path’s own separator', () => {
    expect(joinFolderPath('D:\\Downloads', 'Videos')).toBe('D:\\Downloads\\Videos')
    expect(joinFolderPath('D:/Downloads/', 'Videos')).toBe('D:/Downloads/Videos')
  })

  it('returns the name alone when the base is empty', () => {
    expect(joinFolderPath('', 'Videos')).toBe('Videos')
  })
})

describe('categoryLabel', () => {
  it('localizes the built-in and echoes an unknown id', () => {
    setLocale('en')
    expect(categoryLabel(DEFAULT_CATEGORIES, 'audio')).toBe('Audio')
    expect(categoryLabel(DEFAULT_CATEGORIES, 'nope')).toBe('nope')
  })
})
