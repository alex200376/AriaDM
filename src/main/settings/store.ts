import type {
  AppPaths,
  CategoryRule,
  DeepPartial,
  ScheduleRule,
  Settings,
  SpeedProfile
} from '@shared/settings'

import { JsonStore } from '../store/json-store'
import { createDefaultSettings } from './defaults'

/**
 * Window sizes this app has previously imposed itself: the two older defaults
 * and the minimum a drag-to-resize could reach.
 *
 * A stored size matching one of these was not really chosen by the user, so a
 * new default should still win — otherwise changing the startup size would only
 * ever affect a fresh install, and the change would look like it did nothing.
 */
const APPS_OWN_WINDOW_SIZES = [
  { width: 1280, height: 800 },
  { width: 1024, height: 664 },
  { width: 940, height: 560 }
]

/** Window frames and title bars make an exact match unlikely. */
const WINDOW_SIZE_TOLERANCE = 16

function looksLikeOwnDefault(width: number, height: number): boolean {
  return APPS_OWN_WINDOW_SIZES.some(
    (entry) =>
      Math.abs(entry.width - width) <= WINDOW_SIZE_TOLERANCE &&
      Math.abs(entry.height - height) <= WINDOW_SIZE_TOLERANCE
  )
}

export class SettingsStore {
  private readonly store: JsonStore<Settings>
  private readonly defaults: Settings

  constructor(paths: AppPaths) {
    this.defaults = createDefaultSettings(paths)
    this.store = new JsonStore<Settings>(paths.settings, this.defaults)
  }

  async load(): Promise<Settings> {
    const settings = await this.store.load()

    // One-time: move a window still sitting at one of the app's own sizes onto
    // the current default, keeping where the user put it on screen.
    const { width, height, x, y } = settings.window
    if (looksLikeOwnDefault(width, height)) {
      return this.store.patch({
        window: { ...this.defaults.window, x, y }
      })
    }

    return settings
  }

  get(): Settings {
    return this.store.get()
  }

  async patch(patch: DeepPartial<Settings>): Promise<Settings> {
    return this.store.patch(patch)
  }

  async save(): Promise<void> {
    await this.store.save()
  }

  scheduleSave(): void {
    this.store.scheduleSave()
  }

  // ---- speed profiles ------------------------------------------------------

  async saveProfile(profile: SpeedProfile): Promise<Settings> {
    const settings = this.store.get()
    const profiles = [...settings.profiles]
    const index = profiles.findIndex((entry) => entry.id === profile.id)
    if (index >= 0) profiles[index] = profile
    else profiles.push(profile)
    return this.store.patch({ profiles })
  }

  async deleteProfile(id: string): Promise<Settings> {
    const settings = this.store.get()
    return this.store.patch({
      profiles: settings.profiles.filter((entry) => entry.id !== id),
      activeProfileId: settings.activeProfileId === id ? null : settings.activeProfileId
    })
  }

  // ---- schedules -----------------------------------------------------------

  async saveSchedule(rule: ScheduleRule): Promise<Settings> {
    const settings = this.store.get()
    const schedules = [...settings.schedules]
    const index = schedules.findIndex((entry) => entry.id === rule.id)
    if (index >= 0) schedules[index] = rule
    else schedules.push(rule)
    return this.store.patch({ schedules })
  }

  async deleteSchedule(id: string): Promise<Settings> {
    const settings = this.store.get()
    return this.store.patch({ schedules: settings.schedules.filter((entry) => entry.id !== id) })
  }

  // ---- categories ----------------------------------------------------------

  /**
   * Categories are matched in order, so an edited rule keeps its position in the
   * list rather than being appended. Order is meaningful here: a user rule placed
   * before a built-in one is how a conflict gets resolved.
   */
  async saveCategory(rule: CategoryRule): Promise<Settings> {
    const settings = this.store.get()
    const categories = [...settings.categories]
    const index = categories.findIndex((entry) => entry.id === rule.id)
    if (index >= 0) categories[index] = rule
    else categories.push(rule)
    return this.store.patch({ categories })
  }

  async deleteCategory(id: string): Promise<Settings> {
    const settings = this.store.get()
    return this.store.patch({
      categories: settings.categories.filter((entry) => entry.id !== id),
      hiddenCategories: settings.hiddenCategories.filter((entry) => entry !== id)
    })
  }
}
