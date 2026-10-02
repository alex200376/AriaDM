import { describe, expect, it } from 'vitest'

import { ARIA2_ERROR_SPECS, describeAria2Error, isRetryableError } from '@shared/aria2-errors'
import { createTranslator, setLocale } from '@shared/i18n'
import { en } from '@shared/i18n/en'
import { zhTW } from '@shared/i18n/zh-TW'

describe('describeAria2Error', () => {
  it('maps documented codes to human readable text', () => {
    expect(describeAria2Error(0).short).toBe('無錯誤')
    expect(describeAria2Error(3).short).toBe('找不到資源')
    expect(describeAria2Error(9).short).toBe('磁碟空間不足')
    expect(describeAria2Error(24).short).toBe('認證失敗')
  })

  it('appends the engine message so the cause is not lost', () => {
    const info = describeAria2Error(3, 'Resource not found')
    expect(info.detail).toContain('Resource not found')
    expect(info.short).toBe('找不到資源')
  })

  it('does not append a message to the success code', () => {
    expect(describeAria2Error(0, 'anything').detail).toBe('下載成功完成。')
  })

  it('passes through an unmapped code without pretending to know it', () => {
    const info = describeAria2Error(999, 'engine said no')
    expect(info.short).toBe('錯誤 999')
    expect(info.detail).toBe('engine said no')
    expect(info.retryable).toBe(true)
  })

  it('speaks English when the app is in English', () => {
    setLocale('en')
    try {
      expect(describeAria2Error(3).short).toBe('Resource not found')
      expect(describeAria2Error(9).short).toBe('Not enough disk space')
      expect(describeAria2Error(3, 'Resource not found').detail).toBe(
        'The server answered 404: the file does not exist or has been removed. (Resource not found)'
      )
      expect(describeAria2Error(0, 'anything').detail).toBe('The download finished successfully.')
      expect(describeAria2Error(999).short).toBe('Error 999')
      expect(describeAria2Error(999).detail).toBe('aria2 reported an error code this app does not document.')
    } finally {
      setLocale('zh-TW')
    }
  })
})

describe('ARIA2_ERROR_SPECS', () => {
  it('covers every code the manual documents', () => {
    expect(Object.keys(ARIA2_ERROR_SPECS).map(Number).sort((a, b) => a - b)).toEqual([...Array(33).keys()])
  })

  it('names dictionary keys that really exist', () => {
    // A mistyped key would render as `aria2.7.detail` in the panel, which no
    // other test would notice.
    const missing: string[] = []
    for (const [code, spec] of Object.entries(ARIA2_ERROR_SPECS)) {
      for (const key of [spec.short, spec.detail]) {
        if (typeof (zhTW as Record<string, string>)[key] !== 'string') missing.push(`zh-TW ${code} ${key}`)
        if (typeof (en as Record<string, string>)[key] !== 'string') missing.push(`en ${code} ${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('has English text that is actually English', () => {
    const cjk = /[\u3400-\u9fff\uf900-\ufaff]/
    const translate = createTranslator('en')
    const untranslated = Object.values(ARIA2_ERROR_SPECS)
      .flatMap((spec) => [translate(spec.short), translate(spec.detail)])
      .filter((text) => cjk.test(text))
    expect(untranslated).toEqual([])
  })
})

describe('isRetryableError', () => {
  it('separates transient failures from permanent ones', () => {
    expect(isRetryableError(1)).toBe(true)
    expect(isRetryableError(2)).toBe(true)
    expect(isRetryableError(6)).toBe(true)
    expect(isRetryableError(29)).toBe(true)
    expect(isRetryableError(3)).toBe(false)
    expect(isRetryableError(9)).toBe(false)
    expect(isRetryableError(24)).toBe(false)
    expect(isRetryableError(0)).toBe(false)
  })

  it('does not depend on the language', () => {
    setLocale('en')
    try {
      expect(isRetryableError(1)).toBe(true)
      expect(isRetryableError(13)).toBe(false)
    } finally {
      setLocale('zh-TW')
    }
  })
})
