import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Download the update installer with the bundled aria2 engine.
 *
 * Why this exists alongside the fetch-and-pipe path in `update-manager`: the
 * in-app download runs inside a long-lived Electron process, and in the field it
 * has been observed delivering a file of exactly the right length whose bytes
 * are the wrong ones — the file's own 16 KiB blocks transposed into other 16 KiB
 * slots, differently on every attempt. That is not a network fault (the same
 * machine fetches the asset correctly from every other process) and it is not a
 * length check that can catch it.
 *
 * aria2c sidesteps the whole question:
 *  - it is a **separate process**, so a fault in this process's write path
 *    cannot reach it, and it is the engine AriaDM already uses for the user's own
 *    downloads;
 *  - it verifies the published SHA-256 **itself** (`--checksum`), so a bad file
 *    is rejected before it ever becomes runnable;
 *  - it still resolves `--dir`/`--out` to the exact path the updater expects, so
 *    nothing downstream changes.
 *
 * Every failure is reported instead of thrown, because the caller has a second
 * strategy to fall back on and only the *combination* failing is fatal.
 */

export interface Aria2DownloadRequest {
  /** The aria2c binary: bundled, or the user's override. */
  aria2Path: string
  url: string
  dir: string
  /** File name to write inside `dir`. */
  out: string
  /** Lowercase hex SHA-256 published for the asset; aria2 verifies it itself. */
  sha256: string
  /** Expected size in bytes, or 0 when the release did not say. Progress only. */
  size: number
  signal: AbortSignal
  onProgress?(received: number): void
  log(line: string): void
}

export interface Aria2DownloadOutcome {
  ok: boolean
  /** True when the engine could not even be started, so a fallback is expected. */
  unavailable?: boolean
  error?: string
}

/** How often the growing file is measured, to keep the progress bar honest. */
const PROGRESS_POLL_MS = 250

/**
 * How long a terminated engine gets to actually die before it is killed outright.
 *
 * aria2 holds the target file open, so the caller's cleanup cannot delete it
 * until the process is gone.
 */
const KILL_GRACE_MS = 1_500

/**
 * The engine's argument list.
 *
 * `--no-conf` is not optional: without it aria2 also reads the user's own
 * `aria2.conf`, which can silently change the output path, the connection count
 * or the checksum behaviour — the same class of bug as a media downloader
 * picking up a stray config file.
 */
export function aria2DownloadArgs(
  request: Pick<Aria2DownloadRequest, 'url' | 'dir' | 'out' | 'sha256'>
): string[] {
  return [
    '--no-conf=true',
    `--dir=${request.dir}`,
    `--out=${request.out}`,
    // The exact path matters: aria2 must overwrite rather than invent
    // "file (1).exe", which nothing downstream would ever look at.
    '--allow-overwrite=true',
    '--auto-file-renaming=false',
    '--file-allocation=none',
    '--continue=false',
    // Verify the published bytes, not just the transfer.
    `--checksum=sha-256=${request.sha256}`,
    '--check-integrity=true',
    '--max-connection-per-server=8',
    '--split=8',
    '--min-split-size=1M',
    '--max-tries=3',
    '--retry-wait=2',
    '--console-log-level=warn',
    '--summary-interval=0',
    '--show-console-readout=false',
    '--enable-color=false',
    request.url
  ]
}

/** The output path and its aria2 control file, both of which are ours to remove. */
async function discard(target: string): Promise<void> {
  await fsp.rm(target, { force: true }).catch(() => undefined)
  await fsp.rm(`${target}.aria2`, { force: true }).catch(() => undefined)
}

/** The last non-empty line of the engine's output, for a usable error message. */
export function lastMeaningfulLine(output: string): string {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? ''
  )
}

export async function downloadWithAria2(request: Aria2DownloadRequest): Promise<Aria2DownloadOutcome> {
  const target = path.join(request.dir, request.out)
  await fsp.mkdir(request.dir, { recursive: true })
  // A leftover target would make "the file exists" ambiguous, and with
  // `--continue=false` aria2 would simply refuse to run.
  await discard(target)

  return new Promise<Aria2DownloadOutcome>((resolve) => {
    let output = ''
    let settled = false
    let poll: NodeJS.Timeout | null = null
    let killTimer: NodeJS.Timeout | null = null

    const finish = (outcome: Aria2DownloadOutcome): void => {
      if (settled) return
      settled = true
      if (poll) clearInterval(poll)
      if (killTimer) clearTimeout(killTimer)
      request.signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }

    const child = spawn(request.aria2Path, aria2DownloadArgs(request), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      // Only the tail can be interesting, and this runs for the whole download.
      if (output.length > 8_000) output = output.slice(-4_000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    function onAbort(): void {
      // The engine holds the file open, so it has to be gone before the caller's
      // cleanup can remove it.
      child.kill('SIGKILL')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }
    request.signal.addEventListener('abort', onAbort, { once: true })

    if (request.onProgress) {
      const onProgress = request.onProgress
      poll = setInterval(() => {
        void fsp
          .stat(target)
          .then((stat) => onProgress(stat.size))
          .catch(() => undefined)
      }, PROGRESS_POLL_MS)
      poll.unref?.()
    }

    child.on('error', (error) => {
      /*
       * A missing binary is the one failure worth naming: the caller falls back
       * to its own downloader instead of reporting a broken update.
       *
       * Answered here and now, before any cleanup. A failed spawn emits `error`
       * and then `close` — on Windows with a missing binary, two milliseconds
       * apart — and both handlers used to delete the target before answering, so
       * which one replied came down to two async deletions. Whenever `close` won
       * (it arrives with code -4058, never 0), this answer was dropped and the
       * outcome read as a plain failure: the updater reported a broken update
       * rather than falling back, which is the whole reason `unavailable` exists.
       */
      const code = (error as NodeJS.ErrnoException).code
      finish({ ok: false, unavailable: code === 'ENOENT', error: error.message })
      void discard(target)
    })

    child.on('close', (code) => {
      if (request.signal.aborted) {
        void discard(target).then(() => finish({ ok: false, error: '已取消下載' }))
        return
      }
      if (code === 0) {
        request.log('update: the bundled engine downloaded and verified the installer')
        finish({ ok: true })
        return
      }
      const detail = lastMeaningfulLine(output)
      void discard(target).then(() =>
        finish({ ok: false, error: detail || `aria2 結束碼 ${code}` })
      )
    })
  })
}
