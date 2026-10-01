import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createAppLog } from '../../src/main/app-log'

/**
 * The log sink exists because a packaged build printed nothing: the browser
 * handoff's own failures went to a console nobody has, which is what made "the
 * app is open but the extension cannot reach it" undiagnosable. Two properties
 * matter more than the writing — it must never throw, and it must not let two
 * callers in the same tick interleave.
 */

const FILE = 'C:\\Users\\me\\AppData\\Roaming\\ariadm\\logs\\ariadm.log'

/** Let the sink's promise chain run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createAppLog', () => {
  it('writes one timestamped line per call', async () => {
    const written: string[] = []
    const log = createAppLog({
      path: () => FILE,
      append: async (file, line) => {
        expect(file).toBe(FILE)
        written.push(line)
      },
      now: () => new Date('2026-10-01T12:00:00.000Z')
    })

    log.write('handoff API listening on 127.0.0.1:6801')
    await settle()

    expect(written).toEqual(['2026-10-01T12:00:00.000Z handoff API listening on 127.0.0.1:6801\n'])
  })

  it('keeps lines in order even when they are queued in the same tick', async () => {
    const written: string[] = []
    const log = createAppLog({
      path: () => FILE,
      append: async (_file, line) => {
        written.push(line.trim())
      }
    })

    log.write('first')
    log.write('second')
    log.write('third')
    await settle()

    expect(written.map((line) => line.split(' ')[1])).toEqual(['first', 'second', 'third'])
  })

  it('does nothing until the userData path is known', async () => {
    const append = vi.fn(async () => {})
    const log = createAppLog({ path: () => '', append })

    log.write('too early')
    await settle()

    expect(append).not.toHaveBeenCalled()
  })

  it('swallows a write failure instead of letting it break the caller', async () => {
    const log = createAppLog({
      path: () => FILE,
      append: async () => {
        throw new Error('EACCES')
      }
    })

    expect(() => log.write('engine start failed')).not.toThrow()
    await settle()
  })

  it('starts over once the file has grown past the limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadm-log-'))
    const file = path.join(dir, 'ariadm.log')
    try {
      fs.writeFileSync(file, 'x'.repeat(64), 'utf8')
      const log = createAppLog({ path: () => file, maxBytes: 16 })

      log.trim()

      expect(fs.existsSync(file)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a small file alone, and tolerates a missing one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadm-log-'))
    const file = path.join(dir, 'ariadm.log')
    try {
      fs.writeFileSync(file, 'short', 'utf8')
      createAppLog({ path: () => file, maxBytes: 1024 }).trim()
      expect(fs.readFileSync(file, 'utf8')).toBe('short')

      fs.rmSync(file)
      expect(() => createAppLog({ path: () => file }).trim()).not.toThrow()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
