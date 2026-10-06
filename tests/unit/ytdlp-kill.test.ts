import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { killTree } from '../../src/main/media/ytdlp'

/**
 * Stopping a media download has to reach the whole process tree.
 *
 * yt-dlp runs ffmpeg as a child of its own to merge a video with its audio and to
 * remux HLS, and that grandchild is the process holding the file. child.kill()
 * reaches only yt-dlp, so the reported bug was a row that said "paused" while
 * ffmpeg went on downloading — and the leftovers were the half-written streams
 * (the mp4, webm and mkv files left in the folder afterwards).
 *
 * Real processes, not a mock: the whole question is whether the operating system
 * takes the grandchild, and a fake cannot answer that.
 */

const SLEEP = 'setInterval(function () {}, 1000)'

/** A node process that starts another node process and reports its pid. */
const PARENT =
  "const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], { stdio: 'ignore' });" +
  'process.stdout.write(String(child.pid)); setInterval(function () {}, 1000);'

/** Off Windows the runner spawns detached, so the negative pid names a group. */
const DETACHED = process.platform !== 'win32'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForDeath(pid: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      if (!alive(pid)) {
        resolve(true)
        return
      }
      if (Date.now() - started > timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(tick, 40)
    }
    tick()
  })
}

describe('killTree', () => {
  it('takes the grandchild with it, which is the whole point', async () => {
    const parent = spawn(process.execPath, ['-e', PARENT], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: DETACHED
    })

    const grandchildPid = await new Promise<number>((resolve, reject) => {
      let buffer = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('the test child never reported its pid'))
      }, 10_000)

      parent.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return
        buffer += chunk.toString('utf8')
        const parsed = Number.parseInt(buffer, 10)
        if (Number.isFinite(parsed) && parsed > 0) {
          settled = true
          clearTimeout(timer)
          resolve(parsed)
        }
      })
      parent.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
    })

    expect(alive(parent.pid!)).toBe(true)
    expect(alive(grandchildPid)).toBe(true)

    killTree(parent.pid!)

    expect(await waitForDeath(parent.pid!)).toBe(true)
    expect(await waitForDeath(grandchildPid)).toBe(true)
  })

  it('answers for a pid that is already gone', () => {
    // Stopping a download that failed a moment ago is normal, and a throw here
    // would surface as a crash instead of a pause.
    const child = spawn(process.execPath, ['-e', SLEEP], { stdio: 'ignore', detached: DETACHED })
    const pid = child.pid!

    expect(() => killTree(pid)).not.toThrow()
    expect(() => killTree(pid)).not.toThrow()
  })
})
