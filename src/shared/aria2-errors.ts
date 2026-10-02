/**
 * aria2 error code table.
 *
 * Sourced from the "EXIT STATUS" / `errorCode` table in the aria2 1.37.0 manual.
 * `errorCode` values surface both from the RPC `tellStatus` result and from
 * process exit codes, so they are worth mapping to something a human can act on.
 *
 * Only the code and whether a retry could help are data here; the wording lives
 * in the dictionaries under `aria2.<code>.short` and `aria2.<code>.detail`, so an
 * English interface does not print a Chinese sentence. `describeAria2Error`
 * resolves the keys against the locale `setLocale` last selected.
 */
import type { TranslationKey } from './i18n'
import { t } from './i18n'

export interface Aria2ErrorInfo {
  code: number
  short: string
  detail: string
  /** Whether retrying has any reasonable chance of succeeding. */
  retryable: boolean
}

interface Aria2ErrorSpec {
  short: TranslationKey
  detail: TranslationKey
  retryable: boolean
}

/**
 * Keyed by aria2 error code. Exported so a test can walk it: every entry has to
 * name keys that exist in both dictionaries, or that code renders as its own key.
 */
export const ARIA2_ERROR_SPECS: Record<number, Aria2ErrorSpec> = {
  0: { short: 'aria2.0.short', detail: 'aria2.0.detail', retryable: false },
  1: { short: 'aria2.1.short', detail: 'aria2.1.detail', retryable: true },
  2: { short: 'aria2.2.short', detail: 'aria2.2.detail', retryable: true },
  3: { short: 'aria2.3.short', detail: 'aria2.3.detail', retryable: false },
  4: { short: 'aria2.4.short', detail: 'aria2.4.detail', retryable: false },
  5: { short: 'aria2.5.short', detail: 'aria2.5.detail', retryable: true },
  6: { short: 'aria2.6.short', detail: 'aria2.6.detail', retryable: true },
  7: { short: 'aria2.7.short', detail: 'aria2.7.detail', retryable: true },
  8: { short: 'aria2.8.short', detail: 'aria2.8.detail', retryable: false },
  9: { short: 'aria2.9.short', detail: 'aria2.9.detail', retryable: false },
  10: { short: 'aria2.10.short', detail: 'aria2.10.detail', retryable: false },
  11: { short: 'aria2.11.short', detail: 'aria2.11.detail', retryable: false },
  12: { short: 'aria2.12.short', detail: 'aria2.12.detail', retryable: false },
  13: { short: 'aria2.13.short', detail: 'aria2.13.detail', retryable: false },
  14: { short: 'aria2.14.short', detail: 'aria2.14.detail', retryable: true },
  15: { short: 'aria2.15.short', detail: 'aria2.15.detail', retryable: true },
  16: { short: 'aria2.16.short', detail: 'aria2.16.detail', retryable: false },
  17: { short: 'aria2.17.short', detail: 'aria2.17.detail', retryable: true },
  18: { short: 'aria2.18.short', detail: 'aria2.18.detail', retryable: false },
  19: { short: 'aria2.19.short', detail: 'aria2.19.detail', retryable: true },
  20: { short: 'aria2.20.short', detail: 'aria2.20.detail', retryable: false },
  21: { short: 'aria2.21.short', detail: 'aria2.21.detail', retryable: true },
  22: { short: 'aria2.22.short', detail: 'aria2.22.detail', retryable: true },
  23: { short: 'aria2.23.short', detail: 'aria2.23.detail', retryable: false },
  24: { short: 'aria2.24.short', detail: 'aria2.24.detail', retryable: false },
  25: { short: 'aria2.25.short', detail: 'aria2.25.detail', retryable: false },
  26: { short: 'aria2.26.short', detail: 'aria2.26.detail', retryable: false },
  27: { short: 'aria2.27.short', detail: 'aria2.27.detail', retryable: false },
  28: { short: 'aria2.28.short', detail: 'aria2.28.detail', retryable: false },
  29: { short: 'aria2.29.short', detail: 'aria2.29.detail', retryable: true },
  30: { short: 'aria2.30.short', detail: 'aria2.30.detail', retryable: false },
  31: { short: 'aria2.31.short', detail: 'aria2.31.detail', retryable: false },
  32: { short: 'aria2.32.short', detail: 'aria2.32.detail', retryable: true }
}

/**
 * Codes the manual does not list have to be judged on their own. A missing file
 * (3) and a file that is already there (13) are the two cases where trying again
 * provably cannot help, so everything else is offered as retryable.
 */
function retryableFor(code: number): boolean {
  const spec = ARIA2_ERROR_SPECS[code]
  return spec ? spec.retryable : code !== 3 && code !== 13
}

export function describeAria2Error(code: number, fallbackMessage = ''): Aria2ErrorInfo {
  const spec = ARIA2_ERROR_SPECS[code]
  if (!spec) {
    return {
      code,
      short: t('aria2.unknown.short', { code }),
      detail: fallbackMessage || t('aria2.unknown.detail'),
      retryable: retryableFor(code)
    }
  }
  const detail = t(spec.detail)
  return {
    code,
    short: t(spec.short),
    // The engine's own message is kept alongside ours — it is usually the only
    // line that names the actual host or file. Not for code 0, where it would
    // add noise to a success.
    detail: fallbackMessage && code !== 0 ? t('aria2.withMessage', { detail, message: fallbackMessage }) : detail,
    retryable: spec.retryable
  }
}

export function isRetryableError(code: number): boolean {
  return retryableFor(code)
}
