import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_CATEGORIES, type CategoryRule } from '@shared/settings'

import {
  FALLBACK_CATEGORY,
  categorize,
  categoryDirectory,
  categoryFolderName,
  categoryLabel,
  findCategory,
  resolveDownloadDirectory,
  sameDirectory
} from '../../src/main/downloads/categorizer'

function rule(overrides: Partial<CategoryRule> = {}): CategoryRule {
  return { id: 'custom', name: '自訂', extensions: [], dir: '', postAction: {}, ...overrides }
}

describe('categorize', () => {
  it('matches the extension case-insensitively', () => {
    expect(categorize('movie.MKV', DEFAULT_CATEGORIES)).toBe('video')
    expect(categorize('song.mp3', DEFAULT_CATEGORIES)).toBe('audio')
    expect(categorize('disk.iso', DEFAULT_CATEGORIES)).toBe('archive')
    expect(categorize('report.pdf', DEFAULT_CATEGORIES)).toBe('document')
    expect(categorize('setup.exe', DEFAULT_CATEGORIES)).toBe('program')
    expect(categorize('photo.jpeg', DEFAULT_CATEGORIES)).toBe('image')
  })

  it('falls back when there is no extension or no matching rule', () => {
    expect(categorize('README', DEFAULT_CATEGORIES)).toBe(FALLBACK_CATEGORY)
    expect(categorize('mystery.xyz', DEFAULT_CATEGORIES)).toBe(FALLBACK_CATEGORY)
  })

  it('lets a user rule shadow a built-in one by coming first', () => {
    const custom: CategoryRule[] = [
      { id: 'videos-hd', name: '高畫質', extensions: ['mkv'], dir: '', postAction: {} },
      ...DEFAULT_CATEGORIES
    ]
    expect(categorize('movie.mkv', custom)).toBe('videos-hd')
    expect(categorize('movie.mp4', custom)).toBe('video')
  })
})

describe('categoryDirectory', () => {
  it('uses the global download directory when the rule has no directory', () => {
    expect(categoryDirectory(DEFAULT_CATEGORIES, 'video', 'D:/Downloads')).toBe('D:/Downloads')
  })

  it('uses the rule directory when one is configured', () => {
    const rules: CategoryRule[] = [
      { id: 'video', name: '影片', extensions: ['mp4'], dir: 'D:/Video', postAction: {} }
    ]
    expect(categoryDirectory(rules, 'video', 'D:/Downloads')).toBe('D:/Video')
    expect(categoryDirectory(rules, 'unknown', 'D:/Downloads')).toBe('D:/Downloads')
  })
})

describe('categoryDirectory with type folders', () => {
  it('files a category into a subfolder named the way the sidebar names it', () => {
    expect(categoryDirectory(DEFAULT_CATEGORIES, 'video', 'D:/Downloads', true)).toBe(
      path.join('D:/Downloads', '影片')
    )
    expect(categoryDirectory(DEFAULT_CATEGORIES, 'image', 'D:/Downloads', true)).toBe(
      path.join('D:/Downloads', '圖片')
    )
  })

  it('leaves the folder alone when sorting is off', () => {
    expect(categoryDirectory(DEFAULT_CATEGORIES, 'video', 'D:/Downloads', false)).toBe('D:/Downloads')
  })

  it('keeps a folder the category already names', () => {
    const rules: CategoryRule[] = [rule({ id: 'video', name: '影片', extensions: ['mp4'], dir: 'D:/Video' })]
    expect(categoryDirectory(rules, 'video', 'D:/Downloads', true)).toBe('D:/Video')
  })

  it('leaves an unknown category in the root rather than inventing a folder', () => {
    expect(categoryDirectory([], 'video', 'D:/Downloads', true)).toBe('D:/Downloads')
  })
})

describe('categoryFolderName', () => {
  it('uses the category name', () => {
    expect(categoryFolderName(findCategory(DEFAULT_CATEGORIES, 'audio')!)).toBe('音樂')
  })

  it('keeps a slash in a name from turning into a nested path', () => {
    expect(categoryFolderName(rule({ name: 'A/B' }))).toBe('A_B')
  })

  it('falls back to the id when the name has nothing usable', () => {
    expect(categoryFolderName(rule({ name: '...' }))).toBe('custom')
  })
})

describe('sameDirectory', () => {
  it('ignores a trailing separator', () => {
    expect(sameDirectory('D:/Downloads/', 'D:/Downloads')).toBe(true)
  })

  it('treats an empty side as no match', () => {
    expect(sameDirectory('', 'D:/Downloads')).toBe(false)
    expect(sameDirectory('D:/Downloads', '')).toBe(false)
  })

  it('compares Windows paths case-insensitively', () => {
    if (process.platform !== 'win32') return
    expect(sameDirectory('D:/Downloads', 'd:/downloads')).toBe(true)
  })

  it('tells two different folders apart', () => {
    expect(sameDirectory('D:/Downloads', 'D:/Downloads/Video')).toBe(false)
  })
})

describe('resolveDownloadDirectory', () => {
  it('treats the default folder as no choice and applies the type folder', () => {
    expect(resolveDownloadDirectory(DEFAULT_CATEGORIES, 'video', 'D:/Downloads', 'D:/Downloads/', true)).toBe(
      path.join('D:/Downloads', '影片')
    )
  })

  it('keeps a folder the user actually chose', () => {
    expect(resolveDownloadDirectory(DEFAULT_CATEGORIES, 'video', 'D:/Downloads', 'D:/Elsewhere', true)).toBe(
      'D:/Elsewhere'
    )
  })

  it('falls back to the default folder when sorting is off', () => {
    expect(resolveDownloadDirectory(DEFAULT_CATEGORIES, 'video', 'D:/Downloads', '', false)).toBe('D:/Downloads')
  })

  it('accepts a caller that sends no directory at all', () => {
    expect(resolveDownloadDirectory(DEFAULT_CATEGORIES, 'audio', 'D:/Downloads', '', true)).toBe(
      path.join('D:/Downloads', '音樂')
    )
  })
})

describe('findCategory / categoryLabel', () => {
  it('looks up by id', () => {
    expect(findCategory(DEFAULT_CATEGORIES, 'audio')?.name).toBe('音樂')
    expect(findCategory(DEFAULT_CATEGORIES, 'nope')).toBeUndefined()
    expect(categoryLabel(DEFAULT_CATEGORIES, 'audio')).toBe('音樂')
  })

  it('echoes the id back when no label is known', () => {
    expect(categoryLabel(DEFAULT_CATEGORIES, 'nope')).toBe('nope')
  })
})
