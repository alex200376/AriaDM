import fs from 'node:fs'
import fsp from 'node:fs/promises'

/**
 * The main process's own log file.
 *
 * A packaged build prints nothing to a terminal, which is how "the app is open
 * but the browser extension cannot reach it" became undiagnosable: the handoff
 * listener's own failures were written to a console nobody has. This is the sink
 * that keeps them.
 *
 * Two properties matter more than the writing itself:
 *  - It must never throw. A failed log write cannot be the reason a download,
 *    an update or a shutdown goes wrong, so every failure is swallowed.
 *  - Writes are serialised, because two callers in the same tick would otherwise
 *    interleave and produce mangled lines.
 */

export interface AppLogOptions {
  /** Resolved per write: the userData directory is unknown until the app is ready. */
  path(): string
  /** Injectable so the sink is testable without touching the disk. */
  append?(file: string, line: string): Promise<void>
  /** Start over above this size. The app is meant to run for weeks. */
  maxBytes?: number
  /** Injectable clock, so the timestamp format is testable. */
  now?(): Date
}

export interface AppLog {
  /** Append one line. Returns immediately; never throws. */
  write(line: string): void
  /** Delete the file when it has grown past the limit. Never throws. */
  trim(): void
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export function createAppLog(options: AppLogOptions): AppLog {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const append =
    options.append ??
    ((file: string, line: string) => fsp.appendFile(file, line, 'utf8'))
  const now = options.now ?? (() => new Date())

  // One promise chain, so a burst of lines cannot interleave on disk.
  let queue: Promise<void> = Promise.resolve()

  return {
    write(line: string): void {
      const file = options.path()
      if (!file) return
      const stamped = `${now().toISOString()} ${line}\n`
      queue = queue.then(() => append(file, stamped)).catch(() => {})
    },

    trim(): void {
      const file = options.path()
      if (!file) return
      try {
        // Deliberately synchronous: it runs once, before anything else writes,
        // and it must have finished before the first line is appended.
        if (fs.statSync(file).size > maxBytes) fs.rmSync(file, { force: true })
      } catch {
        // Absent is the normal case on a first run.
      }
    }
  }
}
