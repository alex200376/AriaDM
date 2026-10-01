import { describe, expect, it } from 'vitest'

import { describeAria2Error, isRetryableError } from '@shared/aria2-errors'

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
})
