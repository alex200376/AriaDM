import { useCallback, useMemo } from 'react'

import type { Locale, TranslateParams, TranslationKey } from '@shared/i18n'
import { createTranslator, localeFromSetting } from '@shared/i18n'

import { useApp } from '../store/app-store'

/**
 * React bindings for the dictionaries.
 *
 * The store sets the module-level locale whenever settings change, so `t()` from
 * `@shared/i18n` is usually what a component wants and needs no hook. These hooks
 * exist for the two cases where re-rendering *is* the point: reading the active
 * locale, and forcing a subtree to re-render the moment the language changes.
 */
export function useLocale(): Locale {
  const language = useApp((state) => state.settings?.language)
  return useMemo(
    () => localeFromSetting(language, typeof navigator === 'undefined' ? null : navigator.language),
    [language]
  )
}

export type Translator = (key: TranslationKey, params?: TranslateParams) => string

/** A translator bound to the active locale, for text built during render. */
export function useT(): Translator {
  const locale = useLocale()
  return useMemo(() => createTranslator(locale), [locale])
}

export function useTranslation(): { t: Translator; locale: Locale } {
  const locale = useLocale()
  const t = useT()
  const stable = useCallback<Translator>((key, params) => t(key, params), [t])
  return { t: stable, locale }
}
