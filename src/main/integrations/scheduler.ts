import type { ScheduleRule } from '@shared/settings'

/**
 * A time-window scheduler.
 *
 * Two details that are easy to get wrong and are handled explicitly here:
 *  - Windows that cross midnight ("23:00" to "06:00") are the common case for
 *    overnight downloading, so the comparison is a wrap-around rather than a
 *    simple start <= now < end.
 *  - Rules are edge-triggered on *entering* a window. A naive per-tick check
 *    would call pauseAll or applyProfile every few seconds for the whole window.
 */
export const SCHEDULER_TICK_MS = 20_000

export function minutesSinceMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number.parseInt(match[1]!, 10)
  const minutes = Number.parseInt(match[2]!, 10)
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
}

export function isWithinWindow(rule: Pick<ScheduleRule, 'start' | 'end' | 'days'>, date: Date): boolean {
  if (!rule.days.includes(date.getDay())) return false

  const start = parseClock(rule.start)
  const end = parseClock(rule.end)
  if (start === null || end === null) return false

  const now = minutesSinceMidnight(date)
  if (start === end) return false

  if (start < end) return now >= start && now < end
  // Wrap-around window, e.g. 23:00 -> 06:00.
  return now >= start || now < end
}

export interface RuleEvaluation {
  rule: ScheduleRule
  /** True on the tick where the rule's window is newly entered. */
  entered: boolean
  active: boolean
}

export interface SchedulerDeps {
  getRules(): ScheduleRule[]
  startAll(): Promise<void>
  pauseAll(): Promise<void>
  applyProfile(profileId: string): Promise<void>
  /** True when nothing is downloading and nothing is queued. */
  isQueueIdle(): boolean
  /** Invoked when a rule with shutdownOnFinish fires while the queue is idle. */
  requestSystemPower(action: 'shutdown' | 'sleep' | 'hibernate' | 'exit'): Promise<void>
  log(line: string): void
  now?: () => Date
  intervalMs?: number
}

export class Scheduler {
  private readonly deps: SchedulerDeps
  private timer: NodeJS.Timeout | null = null
  /** Window-active state per rule id, so we only act on transitions. */
  private readonly active = new Map<string, boolean>()
  private readonly shutdownFired = new Set<string>()

  constructor(deps: SchedulerDeps) {
    this.deps = deps
  }

  get running(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? SCHEDULER_TICK_MS)
    this.timer.unref?.()
    this.deps.log('scheduler started')
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Evaluate every rule once. Exposed for tests and for the settings UI preview. */
  evaluate(date: Date): RuleEvaluation[] {
    return this.deps.getRules().map((rule) => {
      const active = rule.enabled && isWithinWindow(rule, date)
      const wasActive = this.active.get(rule.id) ?? false
      return { rule, active, entered: active && !wasActive }
    })
  }

  async tick(): Promise<void> {
    const date = this.deps.now ? this.deps.now() : new Date()
    const evaluations = this.evaluate(date)

    for (const { rule, active, entered } of evaluations) {
      this.active.set(rule.id, active)
      if (!entered) continue

      this.deps.log(`schedule "${rule.name}" entered its window; action=${rule.action}`)

      if (rule.action === 'pauseAll') {
        await this.deps.pauseAll()
      } else if (rule.action === 'startAll') {
        await this.deps.startAll()
      } else if (rule.action === 'applyProfile' && rule.profileId) {
        await this.deps.applyProfile(rule.profileId)
      }
    }

    // Shutdown-when-done is a one-shot per window, checked only while a rule that
    // asked for it is active.
    for (const { rule, active } of evaluations) {
      if (!active || !rule.shutdownOnFinish) continue
      if (this.shutdownFired.has(rule.id)) continue
      if (!this.deps.isQueueIdle()) continue
      this.shutdownFired.add(rule.id)
      this.deps.log(`schedule "${rule.name}" requested shutdown after completion`)
      try {
        await this.deps.requestSystemPower('shutdown')
      } catch (error) {
        this.deps.log(`shutdown request failed: ${(error as Error).message}`)
      }
    }

    // Allow the shutdown to fire again next time the window is re-entered.
    for (const rule of this.deps.getRules()) {
      if (!this.active.get(rule.id)) this.shutdownFired.delete(rule.id)
    }
  }
}
