import { describe, expect, it } from 'vitest'

import {
  createTranslator,
  getLocale,
  localeFromSetting,
  LOCALES,
  resolveLocale,
  setLocale,
  t,
  translate
} from '@shared/i18n'
import { en } from '@shared/i18n/en'
import { zhTW, type TranslationKey } from '@shared/i18n/zh-TW'

describe('resolveLocale', () => {
  it('maps every Chinese tag to Traditional Chinese', () => {
    expect(resolveLocale('zh-TW')).toBe('zh-TW')
    expect(resolveLocale('zh-Hant')).toBe('zh-TW')
    expect(resolveLocale('zh-HK')).toBe('zh-TW')
    expect(resolveLocale('zh-CN')).toBe('zh-TW')
  })

  it('maps English tags to English', () => {
    expect(resolveLocale('en')).toBe('en')
    expect(resolveLocale('en-US')).toBe('en')
    expect(resolveLocale('EN-gb')).toBe('en')
  })

  it('falls back to Chinese for anything else, matching the original app', () => {
    expect(resolveLocale('de-DE')).toBe('zh-TW')
    expect(resolveLocale('ja')).toBe('zh-TW')
    expect(resolveLocale('')).toBe('zh-TW')
    expect(resolveLocale(undefined)).toBe('zh-TW')
    expect(resolveLocale(null)).toBe('zh-TW')
  })
})

describe('localeFromSetting', () => {
  it('follows the system when the setting says so', () => {
    expect(localeFromSetting('system', 'en-GB')).toBe('en')
    expect(localeFromSetting('system', 'zh-TW')).toBe('zh-TW')
    // An unset value behaves like 'system', which is what an upgrade from a
    // build without the setting produces.
    expect(localeFromSetting(undefined, 'en-US')).toBe('en')
  })

  it('honours an explicit choice regardless of the system locale', () => {
    expect(localeFromSetting('en', 'zh-TW')).toBe('en')
    expect(localeFromSetting('zh-TW', 'en-US')).toBe('zh-TW')
  })
})

describe('translate', () => {
  it('interpolates named placeholders', () => {
    expect(createTranslator('en')('statusBar.active', { count: 3 })).toBe('3 active')
    expect(createTranslator('zh-TW')('engine.restarts', { count: 2 })).toBe('重啟 2')
  })

  it('leaves an unknown placeholder alone rather than printing undefined', () => {
    expect(createTranslator('en')('statusBar.active', { nope: 1 })).toBe('{count} active')
  })

  it('returns the key itself when a lookup has no entry', () => {
    expect(createTranslator('en')('not.a.key' as TranslationKey)).toBe('not.a.key')
  })

  it('reads the module-level locale, which setLocale moves', () => {
    const before = getLocale()
    try {
      setLocale('en')
      expect(t('common.cancel')).toBe('Cancel')
      setLocale('zh-TW')
      expect(translate('common.cancel')).toBe('取消')
    } finally {
      setLocale(before)
    }
  })
})

describe('dictionaries', () => {
  it('ships exactly the locales it advertises', () => {
    expect(LOCALES).toEqual(['zh-TW', 'en'])
  })

  it('covers every Chinese key in English', () => {
    // `en` is typed as `satisfies Dictionary`, so this is a compile error first;
    // the runtime check catches a key added with an empty placeholder value.
    const missing = Object.keys(zhTW).filter((key) => {
      const value = (en as Record<string, string>)[key]
      return typeof value !== 'string' || value.trim().length === 0
    })
    expect(missing).toEqual([])
  })

  it('has no untranslated Chinese left in the English dictionary', () => {
    // The language names are the one deliberate exception: a reader should see
    // "繁體中文" written the way its speakers write it.
    const allowlist = new Set(['settings.language.zhTW'])
    const cjk = /[\u3400-\u9fff\uf900-\ufaff]/
    const untranslated = Object.entries(en)
      .filter(([key, value]) => !allowlist.has(key) && cjk.test(value as string))
      .map(([key]) => key)
    expect(untranslated).toEqual([])
  })

  it('keeps every placeholder in both dictionaries', () => {
    const placeholders = (value: string): string[] => (value.match(/\{(\w+)\}/g) ?? []).sort()
    const drifted = Object.keys(zhTW).filter(
      (key) =>
        JSON.stringify(placeholders(zhTW[key as TranslationKey])) !==
        JSON.stringify(placeholders((en as Record<string, string>)[key] as string))
    )
    expect(drifted).toEqual([])
  })
})
