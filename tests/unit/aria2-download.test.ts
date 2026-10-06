import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  aria2DownloadArgs,
  downloadWithAria2,
  lastMeaningfulLine,
  type Aria2DownloadRequest
} from '../../src/main/update/aria2-download'

const DIGEST = 'a'.repeat(64)
const URL_ = 'https://example.test/AriaDM-0.2.0-setup.exe'
const OUT = 'AriaDM-0.2.0-setup.exe'

/** A request whose engine deliberately does not exist. */
function request(overrides: Partial<Aria2DownloadRequest> = {}): Aria2DownloadRequest {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ariadm-aria2-'))
  return {
    aria2Path: path.join(dir, 'aria2c-that-is-not-there.exe'),
    url: URL_,
    dir,
    out: OUT,
    sha256: DIGEST,
    size: 1024,
    signal: new AbortController().signal,
    log: () => {},
    ...overrides
  }
}

describe('aria2DownloadArgs', () => {
  const options = { url: URL_, dir: '/tmp/updates', out: OUT, sha256: DIGEST }

  it('ignores the user’s own aria2 config, which could change the output path', () => {
    expect(aria2DownloadArgs(options)).toContain('--no-conf=true')
  })

  it('verifies the published checksum itself', () => {
    expect(aria2DownloadArgs(options)).toContain(`--checksum=sha-256=${DIGEST}`)
    expect(aria2DownloadArgs(options)).toContain('--check-integrity=true')
  })

  it('writes to the exact path the updater will look at', () => {
    const args = aria2DownloadArgs(options)
    expect(args).toContain(`--dir=${options.dir}`)
    expect(args).toContain(`--out=${OUT}`)
    // Without these aria2 would invent "file (1).exe", which nothing downstream
    // would ever find.
    expect(args).toContain('--allow-overwrite=true')
    expect(args).toContain('--auto-file-renaming=false')
  })

  it('passes the url last, where aria2 expects it', () => {
    expect(aria2DownloadArgs(options).at(-1)).toBe(URL_)
  })
})

describe('downloadWithAria2', () => {
  it('reports a missing engine as unavailable instead of failing the update', async () => {
    const outcome = await downloadWithAria2(request())

    expect(outcome.ok).toBe(false)
    expect(outcome.unavailable).toBe(true)
  })

  it('answers a missing engine the same way however the process events race', async () => {
    // A failed spawn emits 'error' and then 'close' — on Windows, about two
    // milliseconds apart, the latter with code -4058 — and each handler used to
    // delete the target before answering. Which one replied therefore came down
    // to which async delete finished first, and whenever 'close' won this answer
    // was lost: the updater reported a broken update instead of falling back to
    // its own downloader. It failed about once in three runs, here and on CI.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const outcome = await downloadWithAria2(request())
      expect(outcome.unavailable).toBe(true)
    }
  })

  it('clears a leftover file before handing the path to the engine', async () => {
    // A stale file would make "the installer is on disk" ambiguous, and with
    // --continue=false aria2 refuses to start over one.
    const options = request()
    const target = path.join(options.dir, OUT)
    writeFileSync(target, 'stale bytes')

    await downloadWithAria2(options)

    expect(existsSync(target)).toBe(false)
  })
})

describe('lastMeaningfulLine', () => {
  it('returns the last non-empty line, trimmed', () => {
    expect(lastMeaningfulLine('first\n\n   second   \n')).toBe('second')
  })

  it('returns an empty string for empty output', () => {
    expect(lastMeaningfulLine('')).toBe('')
  })
})
