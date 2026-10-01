import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type BinarySource = 'bundled' | 'userData' | 'system' | 'missing'

export interface LocatedBinary {
  name: string
  path: string
  source: BinarySource
  version: string
}

export interface LocateContext {
  /** Logical tool name, used for reporting and diagnostics. */
  name: string
  /** resources/bin inside the packaged app (process.resourcesPath in production). */
  bundledDir: string
  /** Extra binaries downloaded at runtime, kept next to the user's data. */
  userDataBinDir: string
  /** Explicit user override from settings. */
  override: string
  /** Candidate binary filenames, most preferred first. */
  candidates: string[]
}

function isExecutableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** Search PATH using the platform's lookup tool rather than guessing extensions. */
function whichAll(command: string): string[] {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  const args = process.platform === 'win32' ? [command] : ['-a', command]
  const result = spawnSync(finder, args, { stdio: 'pipe', encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isExecutableFile(line))
}

function probeVersion(binary: string): string {
  try {
    const result = spawnSync(binary, ['--version'], { stdio: 'pipe', encoding: 'utf8', timeout: 15_000 })
    if (result.status !== 0) return ''
    const firstLine = String(result.stdout ?? '').split(/\r?\n/)[0] ?? ''
    // aria2 prints "aria2 version 1.37.0"; yt-dlp prints a date-like version.
    const match = /(\d+\.\d+(?:\.\d+)?)/.exec(firstLine)
    return match ? match[1]! : firstLine.trim()
  } catch {
    return ''
  }
}

function firstExisting(dirs: string[], candidates: string[]): string | null {
  for (const dir of dirs) {
    if (!dir) continue
    for (const candidate of candidates) {
      const full = path.join(dir, candidate)
      if (isExecutableFile(full)) return full
    }
  }
  return null
}

export function locateBinary(context: LocateContext): LocatedBinary {
  const { name, candidates } = context

  // 1. An explicit user override always wins, so a power user can point us at
  //    their own build without fighting the search order.
  if (context.override && isExecutableFile(context.override)) {
    return { name, path: context.override, source: 'userData', version: probeVersion(context.override) }
  }

  // 2. Binaries we fetched at runtime through the toolkit downloader.
  const fromUserData = firstExisting([context.userDataBinDir], candidates)
  if (fromUserData) {
    return { name, path: fromUserData, source: 'userData', version: probeVersion(fromUserData) }
  }

  // 3. Binaries shipped inside the app package.
  const fromBundle = firstExisting([context.bundledDir], candidates)
  if (fromBundle) {
    return { name, path: fromBundle, source: 'bundled', version: probeVersion(fromBundle) }
  }

  // 4. Whatever is installed on the machine.
  for (const candidate of candidates) {
    for (const found of whichAll(candidate)) {
      return { name, path: found, source: 'system', version: probeVersion(found) }
    }
  }

  return { name, path: '', source: 'missing', version: '' }
}

export function locateAria2(context: Omit<LocateContext, 'name' | 'candidates'>): LocatedBinary {
  return locateBinary({
    ...context,
    name: 'aria2',
    candidates: process.platform === 'win32' ? ['aria2c.exe', 'aria2c'] : ['aria2c']
  })
}

export function locateYtDlp(context: Omit<LocateContext, 'name' | 'candidates'>): LocatedBinary {
  return locateBinary({
    ...context,
    name: 'yt-dlp',
    candidates: process.platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp']
  })
}

export function locateFfmpeg(context: Omit<LocateContext, 'name' | 'candidates'>): LocatedBinary {
  return locateBinary({
    ...context,
    name: 'ffmpeg',
    candidates: process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg']
  })
}
