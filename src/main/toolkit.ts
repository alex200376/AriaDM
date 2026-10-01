import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import manifest from '../../scripts/aria2-manifest.json'
import type { ToolInfo, ToolkitStatus } from '@shared/download'

import { locateAria2, locateFfmpeg, locateYtDlp, type LocatedBinary } from './aria2/locate'

/**
 * Runtime download of the external tools.
 *
 * Binaries are pinned in scripts/aria2-manifest.json, and the build scripts read
 * the same file, so a version lives in exactly one place.
 *
 * aria2's archive has no upstream digest (GitHub reports null for these assets),
 * so its digest was computed on the first fetch and is pinned in the manifest.
 * yt-dlp publishes SHA2-256SUMS, and that is preferred where reachable.
 */
export type ToolKind = 'aria2' | 'ytdlp' | 'ffmpeg'

export interface ToolkitPaths {
  userDataBinDir: string
  bundledDir: string
}

interface Aria2Asset {
  file: string
  url: string
  sha256: string | null
}

function assetForCurrentPlatform(): Aria2Asset | null {
  const key = `${process.platform}-${process.arch}`
  const assets = manifest.aria2.assets as Record<string, Aria2Asset | undefined>
  return assets[key] ?? null
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await fsp.open(file, 'r')
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk)
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/** Extract a zip with whatever the platform provides. */
function extractZip(zipPath: string, destination: string): void {
  const candidates: [string, string[]][] =
    process.platform === 'win32'
      ? [
          ['C:\\Windows\\System32\\tar.exe', ['-xf', zipPath, '-C', destination]],
          ['unzip', ['-o', '-q', zipPath, '-d', destination]],
          [
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`
            ]
          ]
        ]
      : [
          ['unzip', ['-o', '-q', zipPath, '-d', destination]],
          ['bsdtar', ['-xf', zipPath, '-C', destination]]
        ]

  const failures: string[] = []
  for (const [command, argv] of candidates) {
    const result = spawnSync(command, argv, { stdio: 'pipe' })
    if (result.status === 0) return
    failures.push(`${command}: ${String(result.stderr ?? '').trim().split('\n')[0]}`)
  }
  throw new Error(`找不到可用的解壓縮工具\n${failures.join('\n')}`)
}

async function findFile(root: string, name: string): Promise<string | null> {
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFile(full, name)
      if (nested) return nested
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full
    }
  }
  return null
}

async function download(url: string, destination: string, onLog: (line: string) => void): Promise<void> {
  onLog(`下載 ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

async function fetchPublishedDigest(sumsUrl: string, fileName: string): Promise<string | null> {
  try {
    const response = await fetch(sumsUrl, { redirect: 'follow' })
    if (!response.ok) return null
    const text = await response.text()
    for (const line of text.split('\n')) {
      const [digest, name] = line.trim().split(/\s+/)
      if (name === fileName || name === `./${fileName}`) return digest!.toLowerCase()
    }
    return null
  } catch {
    return null
  }
}

export class ToolkitManager {
  private readonly paths: ToolkitPaths
  private readonly log: (line: string) => void
  private busy: ToolKind | null = null

  constructor(paths: ToolkitPaths, log: (line: string) => void) {
    this.paths = paths
    this.log = log
  }

  get activeDownload(): ToolKind | null {
    return this.busy
  }

  locate(): { aria2: LocatedBinary; ytdlp: LocatedBinary; ffmpeg: LocatedBinary } {
    const base = {
      bundledDir: this.paths.bundledDir,
      userDataBinDir: this.paths.userDataBinDir
    }
    return {
      aria2: locateAria2({ ...base, override: '' }),
      ytdlp: locateYtDlp({ ...base, override: '' }),
      ffmpeg: locateFfmpeg({ ...base, override: '' })
    }
  }

  private async toInfo(located: LocatedBinary, expectedVersion: string): Promise<ToolInfo> {
    const present = located.source !== 'missing' && located.path.length > 0
    let integrityError = ''

    // Only binaries we manage are digest-checked. A system install is the user's
    // business and may legitimately be a different build (distro patches etc).
    if (present && located.source !== 'system') {
      try {
        const digest = await sha256File(located.path)
        const expected =
          located.name === 'aria2'
            ? assetForCurrentPlatform()?.sha256
            : located.name === 'ytdlp'
              ? manifest.ytdlp.sha256
              : null
        if (expected && digest !== expected) {
          integrityError = '檔案雜湊與釘選值不符，建議重新下載。'
        }
      } catch (error) {
        integrityError = `無法驗證檔案：${(error as Error).message}`
      }
    }

    return {
      name: located.name,
      path: located.path,
      version: located.version,
      present,
      source: located.source,
      expectedVersion,
      integrityError
    }
  }

  async status(): Promise<ToolkitStatus> {
    const located = this.locate()
    const [aria2, ytdlp, ffmpeg] = await Promise.all([
      this.toInfo(located.aria2, manifest.aria2.version),
      this.toInfo(located.ytdlp, manifest.ytdlp.version === 'latest' ? '最新版' : manifest.ytdlp.version),
      this.toInfo(located.ffmpeg, '最新版')
    ])
    return { aria2, ytdlp, ffmpeg }
  }

  /** Install aria2 if it is missing or fails its integrity check. */
  async ensureAria2(): Promise<ToolInfo> {
    const status = await this.status()
    if (status.aria2.present && !status.aria2.integrityError) return status.aria2
    this.log('aria2 missing or unverified; fetching the pinned build')
    await this.fetchAria2()
    return (await this.status()).aria2
  }

  async download(kind: ToolKind): Promise<ToolkitStatus> {
    if (this.busy) throw new Error(`已有工具正在下載中（${this.busy}）。`)
    this.busy = kind
    try {
      if (kind === 'aria2') await this.fetchAria2()
      else if (kind === 'ytdlp') await this.fetchYtDlp()
      else await this.fetchFfmpeg()
      return await this.status()
    } finally {
      this.busy = null
    }
  }

  private async fetchAria2(): Promise<void> {
    const asset = assetForCurrentPlatform()
    if (!asset) {
      throw new Error(`沒有為 ${process.platform}-${process.arch} 提供預建的 aria2，請改用系統安裝的 aria2c。`)
    }

    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ariadm-tool-'))
    try {
      const zipPath = path.join(temp, asset.file)
      await download(asset.url, zipPath, this.log)

      const digest = await sha256File(zipPath)
      if (asset.sha256 && digest !== asset.sha256) {
        throw new Error(`aria2 壓縮檔雜湊不符，已中止。\n預期 ${asset.sha256}\n實際 ${digest}`)
      }

      const staging = path.join(temp, 'extract')
      await fsp.mkdir(staging, { recursive: true })
      extractZip(zipPath, staging)

      const binary = await findFile(staging, manifest.aria2.binary)
      if (!binary) throw new Error(`${manifest.aria2.binary} 不在壓縮檔內。`)

      await fsp.mkdir(this.paths.userDataBinDir, { recursive: true })
      const target = path.join(this.paths.userDataBinDir, manifest.aria2.binary)
      await fsp.copyFile(binary, target)
      if (process.platform !== 'win32') await fsp.chmod(target, 0o755)
      this.log(`已安裝 aria2 至 ${target}`)
    } finally {
      await fsp.rm(temp, { recursive: true, force: true })
    }
  }

  private async fetchYtDlp(): Promise<void> {
    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ariadm-tool-'))
    try {
      const staged = path.join(temp, manifest.ytdlp.binary)
      await download(manifest.ytdlp.url, staged, this.log)

      const digest = await sha256File(staged)
      const published = await fetchPublishedDigest(manifest.ytdlp.sumsUrl, manifest.ytdlp.binary)
      if (published && published !== digest) {
        throw new Error(`yt-dlp 雜湊與上游 SHA2-256SUMS 不符，已中止。\n上游 ${published}\n實際 ${digest}`)
      }
      if (!published) this.log('上游雜湊清單不可用，改以本次下載的內容為準')

      await fsp.mkdir(this.paths.userDataBinDir, { recursive: true })
      const destination = path.join(this.paths.userDataBinDir, manifest.ytdlp.binary)
      await fsp.copyFile(staged, destination)
      if (process.platform !== 'win32') await fsp.chmod(destination, 0o755)
      this.log(`已安裝 yt-dlp 至 ${destination}`)
    } finally {
      await fsp.rm(temp, { recursive: true, force: true })
    }
  }

  /**
   * ffmpeg ships inside the installer (a static Windows build, roughly 336MB
   * across ffmpeg.exe and ffprobe.exe). This path exists for the "download
   * again" action and for platforms where the bundle is not present, and it
   * installs into the user's data directory, which takes precedence over the
   * bundled copy.
   */
  private async fetchFfmpeg(): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('請使用系統套件管理器安裝 ffmpeg，AriaDM 會自動偵測。')
    }

    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ariadm-ffmpeg-'))
    try {
      const zipPath = path.join(temp, 'ffmpeg.zip')
      await download(manifest.ffmpeg.url, zipPath, this.log)

      const staging = path.join(temp, 'extract')
      await fsp.mkdir(staging, { recursive: true })
      extractZip(zipPath, staging)

      await fsp.mkdir(this.paths.userDataBinDir, { recursive: true })
      for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
        const found = await findFile(staging, name)
        if (found) await fsp.copyFile(found, path.join(this.paths.userDataBinDir, name))
      }
      this.log('已安裝 ffmpeg 媒體包')
    } finally {
      await fsp.rm(temp, { recursive: true, force: true })
    }
  }
}
