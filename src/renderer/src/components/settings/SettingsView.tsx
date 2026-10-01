import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Download,
  FolderOpen,
  Gauge,
  Globe,
  Info,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  Wrench
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import type { CategoryRule, ScheduleRule, SpeedProfile } from '@shared/settings'
import type { UpdateInfo, UpdateProgress } from '@shared/ipc'
import { formatSpeed } from '@shared/format'
import { getLocale, t, type TranslationKey } from '@shared/i18n'

import { cn } from '../../lib/cn'
import { engineLabel, engineTone } from '../../lib/labels'
import { useApp, type SettingsTab } from '../../store/app-store'
import { Badge, Button, Field, IconButton, Input, Row, SectionTitle, SelectField, Toggle } from '../ui/primitives'

/**
 * Five tabs instead of the original eight.
 *
 * Related panels were merged (profiles live with the connection numbers they
 * describe, categories with the schedules that pick them) and the rarely-touched
 * knobs now hide behind an `Advanced` disclosure inside their own tab, so every
 * tab leads with the settings a user actually changes.
 *
 * The active tab lives in the store so other screens can deep-link into a panel.
 */
type Tab = SettingsTab

const TABS: { key: Tab; labelKey: TranslationKey; icon: ReactNode }[] = [
  { key: 'general', labelKey: 'settings.tab.general', icon: <SlidersHorizontal size={14} /> },
  { key: 'downloads', labelKey: 'settings.tab.downloads', icon: <Gauge size={14} /> },
  { key: 'schedules', labelKey: 'settings.tab.schedules', icon: <CalendarClock size={14} /> },
  { key: 'integrations', labelKey: 'settings.tab.integrations', icon: <Plug size={14} /> },
  { key: 'about', labelKey: 'settings.tab.about', icon: <Info size={14} /> }
]

/** Collapsed by default, so the panels lead with what most people change. */
function Advanced({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-[12px] text-brand hover:underline"
      >
        {open ? t('common.advanced.hide') : label}
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  )
}

const ACCENTS = ['violet', 'blue', 'emerald', 'amber', 'rose', 'cyan', 'slate']

/** Day index 0 is Sunday, matching `Date.getDay()` and the schedule model. */
const WEEKDAY_KEYS: TranslationKey[] = [
  'weekday.sun',
  'weekday.mon',
  'weekday.tue',
  'weekday.wed',
  'weekday.thu',
  'weekday.fri',
  'weekday.sat'
]

/**
 * An option list entry carries a *key* rather than its text: the lists are built
 * once at module load, long before the user has picked a language, so the text
 * has to be resolved during render by `localiseOptions`.
 *
 * `label` covers values that are names rather than words — "Chrome" reads the
 * same in every language — and entries fall back to their value if they have
 * neither.
 */
interface LocalisableOption {
  value: string
  labelKey?: TranslationKey
  label?: string
}

function localiseOptions(options: LocalisableOption[]): { value: string; label: string }[] {
  return options.map((option) => ({
    value: option.value,
    label: option.labelKey ? t(option.labelKey) : (option.label ?? option.value)
  }))
}

// Option lists live outside the components so a re-render does not rebuild them
// and the rendered labels sit next to each other for easy review.
const THEME_OPTIONS: LocalisableOption[] = [
  { value: 'dark', labelKey: 'settings.theme.dark' },
  { value: 'light', labelKey: 'settings.theme.light' },
  { value: 'system', labelKey: 'settings.theme.system' }
]

/**
 * Language choices.
 *
 * Each entry is labelled in its own language (a Chinese reader should not have
 * to find "Traditional Chinese" in a list written in English), which is why
 * these come from the dictionary rather than being built from LOCALE_LABELS.
 */
const LANGUAGE_OPTIONS: LocalisableOption[] = [
  { value: 'system', labelKey: 'settings.language.system' },
  { value: 'zh-TW', labelKey: 'settings.language.zhTW' },
  { value: 'en', labelKey: 'settings.language.en' }
]

const DENSITY_OPTIONS: LocalisableOption[] = [
  { value: 'compact', labelKey: 'settings.density.compact' },
  { value: 'comfortable', labelKey: 'settings.density.comfortable' },
  { value: 'roomy', labelKey: 'settings.density.roomy' }
]

const CONNECTION_PRESET_OPTIONS: LocalisableOption[] = [
  { value: 'standard', labelKey: 'settings.preset.standard' },
  { value: 'steady', labelKey: 'settings.preset.steady' },
  { value: 'turbo', labelKey: 'settings.preset.turbo' },
  { value: 'single', labelKey: 'settings.preset.single' },
  { value: 'custom', labelKey: 'settings.preset.custom' }
]

// Where yt-dlp reads cookies from. The browser names mirror
// `src/main/media/browser-cookies.ts`.
const COOKIE_SOURCE_OPTIONS: LocalisableOption[] = [
  { value: 'auto', labelKey: 'settings.media.cookies.auto' },
  { value: 'none', labelKey: 'settings.media.cookies.none' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'edge', label: 'Edge' },
  { value: 'brave', label: 'Brave' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'vivaldi', label: 'Vivaldi' },
  { value: 'opera', label: 'Opera' }
]

const SCHEDULE_ACTION_OPTIONS: LocalisableOption[] = [
  { value: 'applyProfile', labelKey: 'settings.schedules.action.applyProfile' },
  { value: 'startAll', labelKey: 'settings.schedules.action.startAll' },
  { value: 'pauseAll', labelKey: 'settings.schedules.action.pauseAll' }
]

const IPV6_MODE_OPTIONS: LocalisableOption[] = [
  { value: 'auto', labelKey: 'settings.ipv6Mode.auto' },
  { value: 'on', labelKey: 'settings.ipv6Mode.on' },
  { value: 'off', labelKey: 'settings.ipv6Mode.off' }
]

function GeneralTab(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const patch = useApp((state) => state.patchSettings)
  if (!settings) return <></>

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>{t('settings.downloadDirSection')}</SectionTitle>
        <Field label={t('settings.downloadDir')}>
          <div className="flex gap-2">
            <Input value={settings.downloadDir} onChange={(event) => void patch({ downloadDir: event.target.value })} />
            <Button
              variant="secondary"
              icon={<FolderOpen size={14} />}
              onClick={() => {
                void window.api.settings.chooseDirectory(settings.downloadDir).then((chosen) => {
                  if (chosen) void patch({ downloadDir: chosen })
                })
              }}
            />
          </div>
        </Field>
      </section>

      <section>
        <SectionTitle>{t('settings.appearance')}</SectionTitle>
        <div className="space-y-3">
          <SelectField
            label={t('settings.theme')}
            value={settings.theme}
            options={localiseOptions(THEME_OPTIONS)}
            onValueChange={(value) => void patch({ theme: value as never })}
          />

          <Field label={t('settings.accent')}>
            <div className="flex gap-2">
              {ACCENTS.map((accent) => (
                <button
                  key={accent}
                  type="button"
                  aria-label={accent}
                  onClick={() => void patch({ accent })}
                  data-accent={accent}
                  className={cn(
                    'h-7 w-7 rounded-full border-2 transition-transform',
                    settings.accent === accent ? 'border-fg scale-110' : 'border-transparent'
                  )}
                  style={{ backgroundColor: `rgb(var(--brand))` }}
                />
              ))}
            </div>
          </Field>

          <SelectField
            label={t('settings.density')}
            value={settings.density}
            options={localiseOptions(DENSITY_OPTIONS)}
            onValueChange={(value) => void patch({ density: value as never })}
          />

          <SelectField
            label={t('settings.language')}
            hint={t('settings.language.hint')}
            value={settings.language}
            options={localiseOptions(LANGUAGE_OPTIONS)}
            onValueChange={(value) => void patch({ language: value as never })}
          />
        </div>
      </section>

      <section>
        <SectionTitle>{t('settings.window')}</SectionTitle>
        <div className="divide-y divide-line rounded-lg border border-line bg-elevated/30 px-3">
          <Row label={t('settings.closeToTray')} hint={t('settings.closeToTrayHint')}>
            <Toggle
              checked={settings.closeToTray}
              onChange={(v) => void patch({ closeToTray: v })}
              label={t('settings.closeToTray')}
            />
          </Row>
          <Row label={t('settings.notifyComplete')}>
            <Toggle
              checked={settings.notifyOnComplete}
              onChange={(v) => void patch({ notifyOnComplete: v })}
              label={t('settings.notifyComplete')}
            />
          </Row>
          <Row label={t('settings.notifyError')}>
            <Toggle
              checked={settings.notifyOnError}
              onChange={(v) => void patch({ notifyOnError: v })}
              label={t('settings.notifyError')}
            />
          </Row>
        </div>

        <Advanced label={t('settings.advancedWindow')}>
          <div className="divide-y divide-line rounded-lg border border-line bg-elevated/30 px-3">
            <Row label={t('settings.startMinimised')}>
              <Toggle
                checked={settings.startMinimised}
                onChange={(v) => void patch({ startMinimised: v })}
                label={t('settings.startMinimised')}
              />
            </Row>
            <Row label={t('settings.useSystemTray')}>
              <Toggle
                checked={settings.useSystemTray}
                onChange={(v) => void patch({ useSystemTray: v })}
                label={t('settings.useSystemTray')}
              />
            </Row>
            <Row label={t('settings.soundComplete')}>
              <Toggle
                checked={settings.soundOnComplete}
                onChange={(v) => void patch({ soundOnComplete: v })}
                label={t('settings.soundComplete')}
              />
            </Row>
          </div>
        </Advanced>
      </section>
    </div>
  )
}

function NetworkTab(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const patch = useApp((state) => state.patchSettings)
  if (!settings) return <></>

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>{t('settings.connections')}</SectionTitle>
        <p className="mb-3 rounded-lg border border-line bg-elevated/30 p-2.5 text-[11px] leading-relaxed text-muted">
          {t('settings.connectionsHint')}
        </p>
        <div className="grid grid-cols-2 gap-4">
          <SelectField
            label={t('settings.preset')}
            value={settings.connectionsPreset}
            options={localiseOptions(CONNECTION_PRESET_OPTIONS)}
            onValueChange={(value) => void patch({ connectionsPreset: value as never })}
          />
          <Field label={t('settings.maxConcurrent')}>
            <Input
              type="number"
              min={1}
              max={64}
              value={settings.maxConcurrentDownloads}
              onChange={(event) => void patch({ maxConcurrentDownloads: Number(event.target.value) })}
            />
          </Field>
          <Field label={t('settings.split')}>
            <Input
              type="number"
              min={1}
              max={64}
              value={settings.split}
              onChange={(event) => void patch({ split: Number(event.target.value), connectionsPreset: 'custom' })}
            />
          </Field>
          <Field label={t('settings.maxPerServer')}>
            <Input
              type="number"
              min={1}
              max={16}
              value={settings.maxConnectionPerServer}
              onChange={(event) =>
                void patch({ maxConnectionPerServer: Number(event.target.value), connectionsPreset: 'custom' })
              }
            />
          </Field>
        </div>
      </section>

      <section>
        <SectionTitle>{t('settings.globalLimit')}</SectionTitle>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('settings.downloadLimit')} hint={t('settings.downloadLimitHint')}>
            <Input
              type="number"
              min={0}
              value={settings.globalDownloadLimit}
              onChange={(event) => void patch({ globalDownloadLimit: Number(event.target.value) })}
            />
          </Field>
          <Field label={t('settings.uploadLimit')} hint={t('settings.uploadLimitHint')}>
            <Input
              type="number"
              min={0}
              value={settings.globalUploadLimit}
              onChange={(event) => void patch({ globalUploadLimit: Number(event.target.value) })}
            />
          </Field>
        </div>
        <p className="mt-2 text-[11px] text-faint">
          {t('settings.currentLimit', { value: formatSpeed(settings.globalDownloadLimit) })}
        </p>
      </section>

      <section>
        <SectionTitle>{t('settings.retry')}</SectionTitle>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('settings.maxTries')}>
            <Input
              type="number"
              min={0}
              value={settings.maxTries}
              onChange={(event) => void patch({ maxTries: Number(event.target.value) })}
            />
          </Field>
          <Field label={t('settings.retryWait')}>
            <Input
              type="number"
              min={0}
              value={settings.retryWait}
              onChange={(event) => void patch({ retryWait: Number(event.target.value) })}
            />
          </Field>
          <Field label={t('settings.proxy')} hint={t('settings.proxyHint')}>
            <Input value={settings.proxy} onChange={(event) => void patch({ proxy: event.target.value })} />
          </Field>
          <Field label={t('settings.userAgent')}>
            <Input value={settings.userAgent} onChange={(event) => void patch({ userAgent: event.target.value })} />
          </Field>
        </div>

        {/* Not a checkbox: "auto" is the right answer for almost everyone, and
            the two forced values exist for the cases detection cannot see. */}
        <SelectField
          className="mt-3"
          label={t('settings.ipv6Mode')}
          hint={t('settings.ipv6ModeHint')}
          value={settings.disableIpv6}
          options={localiseOptions(IPV6_MODE_OPTIONS)}
          onValueChange={(value) => void patch({ disableIpv6: value as never })}
        />
      </section>

      <section>
        <SectionTitle>{t('settings.bittorrent')}</SectionTitle>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('settings.seedRatio')} hint={t('settings.seedRatioHint')}>
            <Input
              type="number"
              step="0.1"
              min={0}
              value={settings.seedRatio}
              onChange={(event) => void patch({ seedRatio: Number(event.target.value) })}
            />
          </Field>
          <Field label={t('settings.seedTime')} hint={t('settings.seedTimeHint')}>
            <Input
              type="number"
              min={0}
              value={settings.seedTime}
              onChange={(event) => void patch({ seedTime: Number(event.target.value) })}
            />
          </Field>
        </div>
      </section>
    </div>
  )
}

function ProfilesTab(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const applyProfile = useApp((state) => state.applyProfile)
  const pushToast = useApp((state) => state.pushToast)
  const [draft, setDraft] = useState<SpeedProfile | null>(null)

  if (!settings) return <></>

  const save = async (profile: SpeedProfile): Promise<void> => {
    try {
      const next = await window.api.settings.saveProfile(profile)
      useApp.setState({ settings: next })
      setDraft(null)
      pushToast({ title: t('settings.profiles.saved'), body: profile.name, tone: 'success' })
    } catch (error) {
      pushToast({ title: t('settings.profiles.saveFailed'), body: (error as Error).message, tone: 'error' })
    }
  }

  return (
    <div className="space-y-4">
      <SectionTitle
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={13} />}
            onClick={() =>
              setDraft({
                id: `profile-${Date.now()}`,
                name: t('settings.profiles.new'),
                maxOverallDownloadLimit: 0,
                maxOverallUploadLimit: 0,
                maxConcurrentDownloads: 5,
                split: 8,
                maxConnectionPerServer: 8,
                minSplitSize: 4 * 1024 * 1024
              })
            }
          >
            {t('common.add')}
          </Button>
        }
      >
        {t('settings.profiles')}
      </SectionTitle>

      <div className="space-y-2">
        {settings.profiles.map((profile) => (
          <div
            key={profile.id}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2.5',
              settings.activeProfileId === profile.id ? 'border-brand/40 bg-brand/10' : 'border-line bg-elevated/30'
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium text-fg">{profile.name}</p>
              <p className="text-[11px] text-faint">
                {profile.maxOverallDownloadLimit > 0
                  ? t('settings.profiles.limited', { value: formatSpeed(profile.maxOverallDownloadLimit) })
                  : t('common.unlimited')}
                {` · ${t('settings.profiles.summary', {
                  concurrent: profile.maxConcurrentDownloads,
                  split: profile.split
                })}`}
              </p>
            </div>
            {settings.activeProfileId === profile.id && <Badge tone="brand">{t('settings.profiles.inUse')}</Badge>}
            <Button variant="ghost" size="sm" onClick={() => void applyProfile(profile.id)}>
              {t('common.apply')}
            </Button>
            <IconButton label={t('common.edit')} icon={<Wrench size={14} />} onClick={() => setDraft({ ...profile })} />
            <IconButton
              label={t('common.delete')}
              icon={<Trash2 size={14} />}
              onClick={() => {
                void window.api.settings.deleteProfile(profile.id).then((next) => useApp.setState({ settings: next }))
              }}
            />
          </div>
        ))}
      </div>

      {draft && (
        <div className="space-y-3 rounded-lg border border-line bg-elevated/30 p-3">
          <Field label={t('settings.profiles.name')}>
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('settings.profiles.limit')} hint={t('settings.profiles.limitHint')}>
              <Input
                type="number"
                min={0}
                value={draft.maxOverallDownloadLimit}
                onChange={(event) => setDraft({ ...draft, maxOverallDownloadLimit: Number(event.target.value) })}
              />
            </Field>
            <Field label={t('settings.profiles.concurrent')}>
              <Input
                type="number"
                min={1}
                value={draft.maxConcurrentDownloads}
                onChange={(event) => setDraft({ ...draft, maxConcurrentDownloads: Number(event.target.value) })}
              />
            </Field>
            <Field label={t('settings.profiles.split')}>
              <Input
                type="number"
                min={1}
                value={draft.split}
                onChange={(event) => setDraft({ ...draft, split: Number(event.target.value) })}
              />
            </Field>
            <Field label={t('settings.profiles.perServer')}>
              <Input
                type="number"
                min={1}
                value={draft.maxConnectionPerServer}
                onChange={(event) => setDraft({ ...draft, maxConnectionPerServer: Number(event.target.value) })}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void save(draft)}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SchedulesTab(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const pushToast = useApp((state) => state.pushToast)
  const [draft, setDraft] = useState<ScheduleRule | null>(null)

  if (!settings) return <></>

  const save = async (rule: ScheduleRule): Promise<void> => {
    try {
      const next = await window.api.settings.saveSchedule(rule)
      useApp.setState({ settings: next })
      setDraft(null)
    } catch (error) {
      pushToast({ title: t('settings.schedules.saved'), body: (error as Error).message, tone: 'error' })
    }
  }

  return (
    <div className="space-y-4">
      <SectionTitle
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={13} />}
            onClick={() =>
              setDraft({
                id: `schedule-${Date.now()}`,
                name: t('settings.schedules.new'),
                enabled: true,
                days: [1, 2, 3, 4, 5],
                start: '01:00',
                end: '07:00',
                action: 'applyProfile',
                profileId: settings.profiles[0]?.id ?? null,
                shutdownOnFinish: false
              })
            }
          >
            {t('common.add')}
          </Button>
        }
      >
        {t('settings.schedules')}
      </SectionTitle>

      <p className="rounded-lg border border-line bg-elevated/30 p-2.5 text-[11px] leading-relaxed text-muted">
        {t('settings.schedules.hint')}
      </p>

      <div className="space-y-2">
        {settings.schedules.length === 0 && <p className="text-[12px] text-faint">{t('settings.schedules.empty')}</p>}
        {settings.schedules.map((rule) => {
          const profile = settings.profiles.find((entry) => entry.id === rule.profileId)
          return (
            <div key={rule.id} className="flex items-center gap-3 rounded-lg border border-line bg-elevated/30 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium text-fg">
                  {rule.name} {!rule.enabled && <span className="text-faint">{t('settings.schedules.disabled')}</span>}
                </p>
                <p className="text-[11px] text-faint">
                  {rule.days.map((day) => t(WEEKDAY_KEYS[day])).join('')} · {rule.start}–{rule.end} ·{' '}
                  {rule.action === 'applyProfile'
                    ? t('settings.schedules.action.profile', {
                        name: profile?.name ?? t('settings.schedules.noProfile')
                      })
                    : rule.action === 'startAll'
                      ? t('settings.schedules.action.startAll')
                      : t('settings.schedules.action.pauseAll')}
                  {rule.shutdownOnFinish && ` · ${t('settings.schedules.shutdownShort')}`}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setDraft({ ...rule })}>
                {t('common.edit')}
              </Button>
              <IconButton
                label={t('common.delete')}
                icon={<Trash2 size={14} />}
                onClick={() => {
                  void window.api.settings.deleteSchedule(rule.id).then((next) => useApp.setState({ settings: next }))
                }}
              />
            </div>
          )
        })}
      </div>

      {draft && (
        <div className="space-y-3 rounded-lg border border-line bg-elevated/30 p-3">
          <Field label={t('common.name')}>
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>

          <div>
            <span className="text-[12px] font-medium text-muted">{t('settings.schedules.weekdays')}</span>
            <div className="mt-1.5 flex gap-1.5">
              {WEEKDAY_KEYS.map((key, day) => (
                <button
                  key={day}
                  type="button"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day]
                    })
                  }
                  className={cn(
                    'h-8 w-8 rounded-lg text-[12px] transition-colors',
                    draft.days.includes(day) ? 'bg-brand text-brand-fg' : 'bg-line/50 text-muted hover:text-fg'
                  )}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label={t('settings.schedules.start')}>
              <Input
                type="time"
                value={draft.start}
                onChange={(event) => setDraft({ ...draft, start: event.target.value })}
              />
            </Field>
            <Field label={t('settings.schedules.end')}>
              <Input type="time" value={draft.end} onChange={(event) => setDraft({ ...draft, end: event.target.value })} />
            </Field>
          </div>

          <SelectField
            label={t('settings.schedules.action')}
            value={draft.action}
            options={localiseOptions(SCHEDULE_ACTION_OPTIONS)}
            onValueChange={(value) => setDraft({ ...draft, action: value as ScheduleRule['action'] })}
          />

          {draft.action === 'applyProfile' && (
            <SelectField
              label={t('settings.schedules.profile')}
              value={draft.profileId ?? ''}
              placeholder={t('settings.schedules.pickProfile')}
              options={settings.profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
              onValueChange={(value) => setDraft({ ...draft, profileId: value })}
            />
          )}

          <div className="divide-y divide-line rounded-lg border border-line px-3">
            <Row label={t('settings.schedules.enabled')}>
              <Toggle
                checked={draft.enabled}
                onChange={(v) => setDraft({ ...draft, enabled: v })}
                label={t('settings.schedules.enabled')}
              />
            </Row>
            <Row label={t('settings.schedules.shutdown')} hint={t('settings.schedules.shutdownHint')}>
              <Toggle
                checked={draft.shutdownOnFinish}
                onChange={(v) => setDraft({ ...draft, shutdownOnFinish: v })}
                label={t('settings.schedules.shutdownShort')}
              />
            </Row>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void save(draft)}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function CategoriesTab(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const pushToast = useApp((state) => state.pushToast)
  const [draft, setDraft] = useState<CategoryRule | null>(null)

  if (!settings) return <></>

  const save = async (rule: CategoryRule): Promise<void> => {
    try {
      const next = await window.api.settings.saveCategory(rule)
      useApp.setState({ settings: next })
      setDraft(null)
      pushToast({ title: t('settings.categories.saved'), body: rule.name, tone: 'success' })
    } catch (error) {
      pushToast({ title: t('settings.categories.saveFailed'), body: (error as Error).message, tone: 'error' })
    }
  }

  return (
    <div className="space-y-4">
      <SectionTitle
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={13} />}
            onClick={() =>
              setDraft({ id: `cat-${Date.now()}`, name: t('settings.categories.new'), extensions: [], dir: '', postAction: {} })
            }
          >
            {t('common.add')}
          </Button>
        }
      >
        {t('settings.categories')}
      </SectionTitle>

      <p className="rounded-lg border border-line bg-elevated/30 p-2.5 text-[11px] leading-relaxed text-muted">
        {t('settings.categories.hint')}
      </p>

      <div className="space-y-2">
        {settings.categories.map((rule) => (
          <div key={rule.id} className="flex items-center gap-3 rounded-lg border border-line bg-elevated/30 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium text-fg">{rule.name}</p>
              <p className="truncate text-[11px] text-faint">
                {rule.extensions.length > 0 ? rule.extensions.join(', ') : t('settings.categories.noExtensions')}
                {rule.dir && ` → ${rule.dir}`}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setDraft({ ...rule })}>
              {t('common.edit')}
            </Button>
          </div>
        ))}
      </div>

      {draft && (
        <div className="space-y-3 rounded-lg border border-line bg-elevated/30 p-3">
          <Field label={t('common.name')}>
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
          <Field label={t('settings.categories.extensions')} hint={t('settings.categories.extensionsHint')}>
            <Input
              value={draft.extensions.join(', ')}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  extensions: event.target.value
                    .split(',')
                    .map((value) => value.trim().toLowerCase().replace(/^\./, ''))
                    .filter(Boolean)
                })
              }
            />
          </Field>
          <Field label={t('settings.categories.dir')} hint={t('settings.categories.dirHint')}>
            <div className="flex gap-2">
              <Input value={draft.dir} onChange={(event) => setDraft({ ...draft, dir: event.target.value })} />
              <Button
                variant="secondary"
                icon={<FolderOpen size={14} />}
                onClick={() => {
                  void window.api.settings.chooseDirectory(draft.dir || settings.downloadDir).then((chosen) => {
                    if (chosen) setDraft({ ...draft, dir: chosen })
                  })
                }}
              />
            </div>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void save(draft)}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function IntegrationsTab(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const handoff = useApp((state) => state.handoff)
  const patch = useApp((state) => state.patchSettings)
  const pushToast = useApp((state) => state.pushToast)
  const refreshHandoff = useApp((state) => state.refreshHandoff)
  const openDialog = useApp((state) => state.openDialog)

  if (!settings) return <></>

  // Port lists read with a Chinese enumeration comma; other locales use ", ".
  const portList = handoff?.discoveryPorts.join(getLocale() === 'en' ? ', ' : '、') ?? ''

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>{t('settings.clipboard')}</SectionTitle>
        <div className="divide-y divide-line rounded-lg border border-line bg-elevated/30 px-3">
          <Row label={t('settings.clipboard.watch')} hint={t('settings.clipboard.watchHint')}>
            <Toggle
              checked={settings.clipboardWatch}
              onChange={(v) => void patch({ clipboardWatch: v })}
              label={t('settings.clipboard.watch')}
            />
          </Row>
          <Row label={t('settings.clipboard.autoAdd')} hint={t('settings.clipboard.autoAddHint')}>
            <Toggle
              checked={settings.clipboardAutoAdd}
              onChange={(v) => void patch({ clipboardAutoAdd: v })}
              label={t('settings.clipboard.autoAdd')}
              disabled={!settings.clipboardWatch}
            />
          </Row>
        </div>
      </section>

      <section>
        <SectionTitle>{t('settings.browser')}</SectionTitle>
        <div className="divide-y divide-line rounded-lg border border-line bg-elevated/30 px-3">
          <Row label={t('settings.browser.enable')} hint={t('settings.browser.enableHint')}>
            <Toggle
              checked={settings.handoffEnabled}
              onChange={(v) => void patch({ handoffEnabled: v })}
              label={t('settings.browser.enable')}
            />
          </Row>
          <Row label={t('settings.browser.catchPopup')} hint={t('settings.browser.catchPopupHint')}>
            <Toggle
              checked={settings.showCatchPopup}
              onChange={(v) => void patch({ showCatchPopup: v })}
              label={t('settings.browser.catchPopup')}
              disabled={!settings.handoffEnabled}
            />
          </Row>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {handoff && (
            <Badge tone={handoff.running ? 'ok' : 'danger'} dot>
              {handoff.running ? t('settings.browser.running', { port: handoff.port }) : t('settings.browser.stopped')}
            </Badge>
          )}
          {/* Auto-pairing lives on its own listener with its own port, so it gets
              its own readout: "browser integration is running" is not the same
              answer as "the extension can find this app". */}
          {handoff && handoff.discoveryPort > 0 && (
            <Badge tone="ok" dot>
              {t('settings.browser.discovery', { port: handoff.discoveryPort })}
            </Badge>
          )}
          {handoff && handoff.enabled && handoff.discoveryPort === 0 && (
            <Badge tone="warn" dot>
              {t('settings.browser.discoveryOff')}
            </Badge>
          )}
          {handoff?.lastError && <span className="text-[11px] text-danger">{handoff.lastError}</span>}
          {handoff && handoff.enabled && handoff.discoveryPort === 0 && (
            <span className="w-full text-[11.5px] leading-relaxed text-muted">
              {t('settings.browser.discoveryWarning', { ports: portList })}
            </span>
          )}
          <Button variant="secondary" size="sm" icon={<Globe size={13} />} onClick={() => openDialog('extension')}>
            {t('settings.browser.help')}
          </Button>
        </div>

        <Advanced label={t('settings.browser.advanced')}>
          <p className="rounded-lg border border-line bg-elevated/30 p-2.5 text-[11.5px] leading-relaxed text-muted">
            {t('settings.browser.advancedHint')}
          </p>
          <div className="divide-y divide-line rounded-lg border border-line bg-elevated/30 px-3">
            <Row label={t('settings.browser.port')} hint={t('settings.browser.portHint')}>
              <Input
                type="number"
                className="w-28"
                value={settings.handoffPort}
                onChange={(event) => void patch({ handoffPort: Number(event.target.value) })}
              />
            </Row>
          </div>
          {handoff && (
            <Field label={t('settings.browser.token')} hint={t('settings.browser.tokenHint')}>
              <div className="flex gap-2">
                <Input readOnly value={handoff.token} className="font-mono text-[11px]" data-selectable />
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard.writeText(handoff.token)
                    pushToast({ title: t('settings.browser.copied'), body: '', tone: 'info' })
                  }}
                >
                  {t('settings.browser.copy')}
                </Button>
                <Button
                  variant="ghost"
                  icon={<RefreshCw size={14} />}
                  onClick={() => {
                    void window.api.integrations.rotateHandoffToken().then(() => {
                      void refreshHandoff()
                      pushToast({
                        title: t('settings.browser.rotated'),
                        body: t('settings.browser.rotatedBody'),
                        tone: 'warn'
                      })
                    })
                  }}
                >
                  {t('settings.browser.reset')}
                </Button>
              </div>
            </Field>
          )}
        </Advanced>
      </section>

      <section>
        <SectionTitle>{t('settings.media')}</SectionTitle>
        <p className="mb-2 rounded-lg border border-line bg-elevated/30 p-2.5 text-[11px] leading-relaxed text-muted">
          {t('settings.media.hint')}
        </p>
        <div className="divide-y divide-line rounded-lg border border-line bg-elevated/30 px-3">
          <Row label={t('settings.media.enable')}>
            <Toggle
              checked={settings.ytdlpEnabled}
              onChange={(v) => void patch({ ytdlpEnabled: v })}
              label={t('settings.media.enable')}
            />
          </Row>
          <Row label={t('settings.media.detect')} hint={t('settings.media.detectHint')}>
            <Toggle
              checked={settings.ytdlpDetectSites}
              onChange={(v) => void patch({ ytdlpDetectSites: v })}
              label={t('settings.media.detect')}
            />
          </Row>
        </div>

        <SelectField
          className="mt-3"
          label={t('settings.media.cookies')}
          hint={t('settings.media.cookiesHint')}
          value={settings.mediaCookiesFromBrowser}
          options={localiseOptions(COOKIE_SOURCE_OPTIONS)}
          onValueChange={(value) => void patch({ mediaCookiesFromBrowser: value as never })}
        />
      </section>
    </div>
  )
}

function ToolsTab(): JSX.Element {
  const toolkits = useApp((state) => state.toolkits)
  const settings = useApp((state) => state.settings)
  const engine = useApp((state) => state.engine)
  const refreshToolkits = useApp((state) => state.refreshToolkits)
  const patch = useApp((state) => state.patchSettings)
  const pushToast = useApp((state) => state.pushToast)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void refreshToolkits()
  }, [refreshToolkits])

  if (!settings) return <></>

  const downloadToolkit = async (kind: 'aria2' | 'ytdlp' | 'ffmpeg'): Promise<void> => {
    setBusy(kind)
    try {
      const status = await window.api.integrations.downloadToolkit(kind)
      useApp.setState({ toolkits: status })
      pushToast({ title: t('settings.tools.installedToast'), body: kind, tone: 'success' })
      const next = await window.api.settings.get()
      useApp.setState({ settings: next })
    } catch (error) {
      pushToast({ title: t('settings.tools.installFailed'), body: (error as Error).message, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const rows = [
    { kind: 'aria2' as const, label: t('settings.tools.aria2'), info: toolkits?.aria2 },
    { kind: 'ytdlp' as const, label: t('settings.tools.ytdlp'), info: toolkits?.ytdlp },
    { kind: 'ffmpeg' as const, label: t('settings.tools.ffmpeg'), info: toolkits?.ffmpeg }
  ]

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle
          action={
            <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={() => void refreshToolkits()}>
              {t('settings.tools.recheck')}
            </Button>
          }
        >
          {t('settings.tools')}
        </SectionTitle>

        <div className="space-y-2">
          {rows.map((row) => {
            const info = row.info
            const present = info?.present ?? false
            return (
              <div key={row.kind} className="flex items-center gap-3 rounded-lg border border-line bg-elevated/30 px-3 py-2.5">
                <span className={cn('shrink-0', present ? 'text-ok' : 'text-faint')}>
                  {present ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-fg">{row.label}</p>
                  <p className="truncate text-[11px] text-faint" title={info?.path ?? ''}>
                    {present
                      ? t('settings.tools.installed', {
                          version: info?.version || t('settings.tools.installedToast'),
                          source:
                            info?.source === 'bundled'
                              ? t('settings.tools.sourceBundled')
                              : info?.source === 'userData'
                                ? t('settings.tools.sourceUserData')
                                : t('settings.tools.sourceSystem')
                        })
                      : t('settings.tools.missing')}
                  </p>
                  {info?.integrityError && <p className="text-[11px] text-warn">{info.integrityError}</p>}
                </div>
                <Button
                  variant={present ? 'ghost' : 'primary'}
                  size="sm"
                  disabled={busy !== null}
                  icon={busy === row.kind ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  onClick={() => void downloadToolkit(row.kind)}
                >
                  {present ? t('settings.tools.reinstall') : t('settings.tools.download')}
                </Button>
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <SectionTitle>{t('settings.engine')}</SectionTitle>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('settings.engine.path')} hint={t('settings.engine.pathHint')}>
            <Input value={settings.aria2Path} onChange={(event) => void patch({ aria2Path: event.target.value })} />
          </Field>
          <Field label={t('settings.engine.port')} hint={t('settings.engine.portHint')}>
            <Input
              type="number"
              value={settings.aria2RpcPort}
              onChange={(event) => void patch({ aria2RpcPort: Number(event.target.value) })}
            />
          </Field>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Badge tone={engineTone(engine.state)} dot>
            {engine.state === 'ready' && engine.port !== null
              ? t('settings.engine.running', { port: engine.port })
              : engineLabel(engine.state)}
          </Badge>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={13} />}
            onClick={() => {
              void useApp.getState().runAction(t('settings.engine.restartAction'), async () => {
                await window.api.engine.restart()
              })
            }}
          >
            {t('settings.engine.restart')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void window.api.engine.openLog()}>
            {t('settings.engine.openLog')}
          </Button>
        </div>

        {engine.lastError && (
          <p className="mt-3 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-[11px] leading-relaxed text-danger">
            {engine.lastError}
          </p>
        )}

        {engine.state === 'failed' && engine.logTail && (
          <pre className="mt-3 max-h-56 overflow-auto rounded-lg border border-line bg-elevated/40 p-3 font-mono text-[10.5px] text-muted" data-selectable>
            {engine.logTail}
          </pre>
        )}
      </section>

      <section>
        <SectionTitle>{t('settings.postAction')}</SectionTitle>
        <div className="divide-y divide-line rounded-lg border border-line bg-elevated/30 px-3">
          <Row label={t('settings.postAction.openFile')}>
            <Toggle
              checked={settings.postAction.openFile}
              onChange={(v) => void patch({ postAction: { ...settings.postAction, openFile: v } })}
              label={t('settings.postAction.openFile')}
            />
          </Row>
          <Row label={t('settings.postAction.showInFolder')}>
            <Toggle
              checked={settings.postAction.showInFolder}
              onChange={(v) => void patch({ postAction: { ...settings.postAction, showInFolder: v } })}
              label={t('settings.postAction.showInFolder')}
            />
          </Row>
          <Row label={t('settings.postAction.notify')}>
            <Toggle
              checked={settings.postAction.notify}
              onChange={(v) => void patch({ postAction: { ...settings.postAction, notify: v } })}
              label={t('settings.postAction.notify')}
            />
          </Row>
        </div>
        <Field
          label={t('settings.postAction.command')}
          className="mt-3"
          hint={t('settings.postAction.commandHint')}
        >
          <Input
            value={settings.postAction.command}
            onChange={(event) => void patch({ postAction: { ...settings.postAction, command: event.target.value } })}
            placeholder={t('settings.postAction.commandPlaceholder')}
          />
        </Field>
      </section>
    </div>
  )
}

function AboutTab(): JSX.Element {
  const paths = useApp((state) => state.paths)
  const toolkits = useApp((state) => state.toolkits)
  const version = useApp((state) => state.engine.version)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [installing, setInstalling] = useState(false)
  const [failure, setFailure] = useState('')

  // The main process reports download progress on its own channel, so the bar
  // advances even while the button's own promise is still pending.
  useEffect(() => window.api.on.updateProgress(setProgress), [])

  const checkForUpdates = async (): Promise<void> => {
    setChecking(true)
    setFailure('')
    setProgress(null)
    try {
      setUpdate(await window.api.update.check())
    } catch (error) {
      setUpdate({
        current: window.api.version,
        latest: null,
        available: false,
        releaseUrl: null,
        downloadUrl: null,
        downloadSize: 0,
        canInstall: false,
        error: (error as Error).message
      })
    } finally {
      setChecking(false)
    }
  }

  /**
   * Download the installer and, once it is verified, hand off to the silent
   * install. The app quits as part of that, so the `finally` is only reached
   * when something went wrong.
   */
  const downloadAndInstall = async (): Promise<void> => {
    setFailure('')
    setInstalling(true)
    try {
      await window.api.update.download()
      await window.api.update.install()
    } catch (error) {
      setFailure((error as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  const updateMessage = (): string => {
    if (checking) return t('settings.update.checking')
    if (!update) return ''
    if (update.available && update.latest) return t('settings.update.available', { version: update.latest })
    if (update.error) return t('settings.update.failed', { error: update.error })
    if (update.latest) return t('settings.update.upToDate')
    return t('settings.update.none')
  }

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>{t('settings.about.title')}</SectionTitle>
        <p className="text-[12px] leading-relaxed text-muted">{t('settings.about.body')}</p>
        <div className="mt-3 space-y-1 text-[11.5px]">
          <div className="flex justify-between">
            <span className="text-faint">AriaDM</span>
            <span className="text-fg">{window.api.version}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-faint">{t('settings.about.engine')}</span>
            <span className="text-fg">{version || toolkits?.aria2.version || t('common.dash')}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-faint">{t('settings.about.platform')}</span>
            <span className="text-fg">{window.api.platform}</span>
          </div>
        </div>
      </section>

      <section>
        <SectionTitle>{t('settings.about.paths')}</SectionTitle>
        <div className="space-y-1">
          {paths &&
            Object.entries(paths).map(([key, value]) => (
              <div key={key} className="flex items-start justify-between gap-4 text-[11px]">
                <span className="shrink-0 text-faint">{key}</span>
                <span className="break-all text-right font-mono text-muted" data-selectable>
                  {value}
                </span>
              </div>
            ))}
        </div>
      </section>

      <section>
        <SectionTitle
          action={
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={13} className={cn(checking && 'animate-spin')} />}
              disabled={checking}
              onClick={() => void checkForUpdates()}
            >
              {t('settings.update.check')}
            </Button>
          }
        >
          {t('settings.update.title')}
        </SectionTitle>

        <div className="divide-y divide-line rounded-lg border border-line bg-elevated/30 px-3">
          <Row label={t('settings.update.current')}>
            <span className="font-mono text-[12px] text-fg">{window.api.version}</span>
          </Row>
        </div>

        {updateMessage() && (
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted">{updateMessage()}</p>
        )}

        {progress && (progress.phase === 'downloading' || progress.phase === 'ready') && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[11px] text-muted">
              <span>
                {progress.phase === 'ready'
                  ? t('settings.update.downloaded')
                  : t('settings.update.downloading')}
              </span>
              <span className="font-mono text-tabular">
                {progress.percent >= 0 ? `${progress.percent}%` : formatSpeed(progress.received)}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-elevated">
              <div
                className={cn(
                  'h-full rounded-full bg-brand transition-all',
                  progress.percent < 0 && 'animate-pulse'
                )}
                style={{ width: progress.percent >= 0 ? `${progress.percent}%` : '100%' }}
              />
            </div>
          </div>
        )}

        {failure && (
          <p className="mt-2 text-[11.5px] leading-relaxed text-danger">
            {t('settings.update.installFailed', { error: failure })}
          </p>
        )}

        {update?.available &&
          (update.canInstall ? (
            <Button
              variant="primary"
              size="sm"
              className="mt-3"
              icon={
                installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />
              }
              disabled={installing}
              onClick={() => void downloadAndInstall()}
            >
              {installing ? t('settings.update.installing') : t('settings.update.install')}
            </Button>
          ) : (
            <div className="mt-3">
              <Button
                variant="primary"
                size="sm"
                icon={<Download size={13} />}
                onClick={() =>
                  void window.api.app.openExternal(update.downloadUrl ?? update.releaseUrl ?? '')
                }
              >
                {t('settings.update.download')}
              </Button>
              <p className="mt-2 text-[11px] leading-relaxed text-faint">
                {t('settings.update.manualHint')}
              </p>
            </div>
          ))}
      </section>

      <section>
        <SectionTitle>{t('settings.about.limitations')}</SectionTitle>
        <ul className="space-y-1.5 text-[11.5px] leading-relaxed text-muted">
          <li>• {t('settings.about.limit1')}</li>
          <li>• {t('settings.about.limit2')}</li>
          <li>• {t('settings.about.limit3')}</li>
          <li>• {t('settings.about.limit4')}</li>
          <li>• {t('settings.about.limit5')}</li>
        </ul>
      </section>
    </div>
  )
}

export function SettingsView(): JSX.Element {
  const tab = useApp((state) => state.settingsTab)
  const setTab = useApp((state) => state.setSettingsTab)

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="w-[184px] shrink-0 border-r border-line bg-surface/40 p-2">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
              tab === entry.key ? 'bg-brand/15 text-fg' : 'text-muted hover:bg-line/40 hover:text-fg'
            )}
          >
            <span className={cn('shrink-0', tab === entry.key ? 'text-brand' : 'text-faint')}>{entry.icon}</span>
            {t(entry.labelKey)}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-2xl space-y-8">
          {tab === 'general' && <GeneralTab />}
          {tab === 'downloads' && (
            <>
              <NetworkTab />
              <ProfilesTab />
            </>
          )}
          {tab === 'schedules' && (
            <>
              <SchedulesTab />
              <CategoriesTab />
            </>
          )}
          {tab === 'integrations' && (
            <>
              <IntegrationsTab />
              <ToolsTab />
            </>
          )}
          {tab === 'about' && <AboutTab />}
        </div>
      </div>
    </div>
  )
}
