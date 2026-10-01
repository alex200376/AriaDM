import fsp from 'node:fs/promises'
import path from 'node:path'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Merge `patch` into `base`. Arrays are replaced wholesale rather than merged
 * element-wise, which is what a user editing a list of categories expects.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T
  }
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = result[key]
    result[key] = isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value
  }
  return result as T
}

/**
 * A persisted JSON document.
 *
 * Writes go to a temporary file and are then renamed into place, so a crash or a
 * power loss mid-write cannot leave a truncated settings or history file behind.
 * Writes are also coalesced: `scheduleSave` collapses bursts of updates into one
 * write, which matters because the poller touches history frequently.
 */
export class JsonStore<T extends object> {
  private readonly filePath: string
  private readonly defaults: T
  private value: T
  private saveTimer: NodeJS.Timeout | null = null
  private writing: Promise<void> | null = null
  private dirty = false

  constructor(filePath: string, defaults: T) {
    this.filePath = filePath
    this.defaults = defaults
    this.value = defaults
  }

  async load(): Promise<T> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      // Merge over defaults so a config written by an older version stays usable.
      this.value = deepMerge(this.defaults, parsed)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // A corrupt file should not brick the app; keep defaults and back it up.
        try {
          await fsp.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
        } catch {
          // Best effort only.
        }
      }
      this.value = this.defaults
    }
    return this.value
  }

  get(): T {
    return this.value
  }

  async patch(patch: unknown): Promise<T> {
    this.value = deepMerge(this.value, patch)
    await this.save()
    return this.value
  }

  async set(value: T): Promise<T> {
    this.value = value
    await this.save()
    return this.value
  }

  /** Debounced save; returns immediately. */
  scheduleSave(delayMs = 400): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, delayMs)
    this.saveTimer.unref?.()
  }

  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    // Serialise writers so two concurrent saves cannot interleave renames.
    while (this.writing) await this.writing
    this.writing = this.writeOnce()
    try {
      await this.writing
    } finally {
      this.writing = null
      this.dirty = false
    }
  }

  private async writeOnce(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await fsp.writeFile(temporary, `${JSON.stringify(this.value, null, 2)}\n`, 'utf8')
    await fsp.rename(temporary, this.filePath)
  }

  get hasUnsavedChanges(): boolean {
    return this.dirty
  }
}
