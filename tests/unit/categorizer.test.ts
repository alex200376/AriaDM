import { describe, expect, it } from 'vitest'

import { DEFAULT_CATEGORIES, type CategoryRule } from '@shared/settings'

import {
  FALLBACK_CATEGORY,
  categorize,
  categoryDirectory,
  categoryLabel,
  findCategory
} from '../../src/main/downloads/categorizer'

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
