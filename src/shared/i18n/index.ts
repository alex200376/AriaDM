/**
 * Locale resolution and string lookup.
 *
 * The dictionaries live beside this file; this module is the only place that
 * knows how to pick one. Two delivery styles are supported on purpose:
 *
 *  - `translate(key, params)` reads a module-level "current" locale. That is what
 *    non-React code (the zustand store, label helpers, main process) uses, and it
 *    is set whenever the settings change with `setLocale`.
 *  - `createTranslator(locale)` returns a self-contained `t`, which React binds
 *    to the resolved locale so a language switch re-renders every screen.
 *
 * Placeholders are interpolated as `{name}`; an unknown placeholder is left
 * alone rather than replaced with "undefined", because a half-filled sentence is
 * easier to spot in a screenshot than a silently corrupted one.
 */
import type { Dictionary, TranslationKey } from './zh-TW'
import { zhTW } from './zh-TW'
import { en } from './en'

export type { Dictionary, TranslationKey } from './zh-TW'

export type Locale = 'zh-TW' | 'en'
export type LanguageSetting = 'system' | Locale

export type TranslateParams = Record<string, string | number>

const DICTIONARIES: Record<Locale, Dictionary> = {
  'zh-TW': zhTW,
  en
}

export const LOCALES: Locale[] = ['zh-TW', 'en']

/** Human label for the language picker; deliberately not translated. */
export const LOCALE_LABELS: Record<Locale, string> = {
  'zh-TW': '繁體中文',
  en: 'English'
}

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-TW' || value === 'en'
}

/**
 * Collapse anything BCP-47-ish down to a locale we ship.
 *
 * `zh-Hant`, `zh-TW`, `zh-HK` all land on Traditional Chinese and every other
 * Chinese tag falls back to it too, which is the right default for this app's
 * existing audience. Everything unrecognised becomes Chinese, matching the
 * behaviour before the setting existed.
 */
export function resolveLocale(preferred?: string | null): Locale {
  if (!preferred) return 'zh-TW'
  const normalised = preferred.toLowerCase()
  if (normalised.startsWith('zh')) return 'zh-TW'
  if (normalised.startsWith('en')) return 'en'
  return 'zh-TW'
}

/** Turn the persisted setting (plus the OS locale) into a concrete locale. */
export function localeFromSetting(setting: LanguageSetting | undefined, systemLocale?: string | null): Locale {
  if (!setting || setting === 'system') return resolveLocale(systemLocale)
  return setting
}

/** Short tag for `Intl`/`toLocaleString`, e.g. dates and dashboards. */
export function intlLocale(locale: Locale): string {
  return locale === 'en' ? 'en' : 'zh-Hant'
}

let currentLocale: Locale = 'zh-TW'

export function setLocale(locale: Locale): void {
  currentLocale = locale
}

export function getLocale(): Locale {
  return currentLocale
}

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** Bind a translator to one locale. */
export function createTranslator(locale: Locale): (key: TranslationKey, params?: TranslateParams) => string {
  const dictionary = DICTIONARIES[locale] ?? DICTIONARIES['zh-TW']
  return (key, params) => interpolate(dictionary[key] ?? zhTW[key] ?? key, params)
}

/**
 * Translate using the module-level locale.
 *
 * Falls back to the Chinese string, then the raw key: a missing key should show
 * *something* rather than blanking a label.
 */
export function translate(key: TranslationKey, params?: TranslateParams): string {
  return createTranslator(currentLocale)(key, params)
}

/** `translate`, for terse call sites. */
export const t = translate
