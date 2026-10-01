#!/usr/bin/env node
/**
 * Fetch the optional ffmpeg media pack into resources/bin/.
 *
 * ffmpeg is NOT bundled by default: the static Windows build adds roughly 80MB
 * compressed to the installer, and it is only needed when yt-dlp has to merge
 * separate video and audio streams. AriaDM offers it as an on-demand download.
 *
 * Usage:
 *   node scripts/fetch-ffmpeg.mjs [--force]
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MANIFEST_PATH = path.join(HERE, 'aria2-manifest.json')
const BIN_DIR = path.join(ROOT, 'resources', 'bin')
const CACHE_DIR = path.join(ROOT, '.cache', 'downloads')

const FORCE = new Set(process.argv.slice(2)).has('--force')
const log = (...parts) => console.log('[fetch-ffmpeg]', ...parts)

async function sha256File(file) {
  const hash = createHash('sha256')
  const handle = await fs.open(file, 'r')
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk)
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

function extractZip(zipPath, destDir) {
  const candidates =
    process.platform === 'win32'
      ? [
          ['C:\\Windows\\System32\\tar.exe', ['-xf', zipPath, '-C', destDir]],
          ['unzip', ['-o', '-q', zipPath, '-d', destDir]],
          [
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
            ]
          ]
        ]
      : [
          ['unzip', ['-o', '-q', zipPath, '-d', destDir]],
          ['bsdtar', ['-xf', zipPath, '-C', destDir]]
        ]

  for (const [command, argv] of candidates) {
    if (spawnSync(command, argv, { stdio: 'pipe' }).status === 0) return command
  }
  throw new Error('no usable zip extractor found')
}

async function findFile(dir, name) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFile(full, name)
      if (nested) return nested
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full
    }
  }
  return null
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'))
  const entry = manifest.ffmpeg
  await fs.mkdir(BIN_DIR, { recursive: true })
  await fs.mkdir(CACHE_DIR, { recursive: true })

  const target = path.join(BIN_DIR, entry.binary)
  const present = await fs.access(target).then(() => true).catch(() => false)

  if (present && !FORCE) {
    const digest = await sha256File(target)
    if (entry.sha256 && digest !== entry.sha256) {
      log('existing ffmpeg does not match the pinned digest; re-downloading')
    } else {
      if (!entry.sha256) {
        entry.sha256 = digest
        await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
      }
      log('ffmpeg is present')
      return
    }
  }

  const zipPath = path.join(CACHE_DIR, 'ffmpeg-win64.zip')
  log(`downloading ${entry.url} (this is a large file)`)
  const response = await fetch(entry.url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath))

  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'ariadm-ffmpeg-'))
  try {
    log(`extracted with ${extractZip(zipPath, staging)}`)
    const binary = await findFile(staging, entry.binary)
    if (!binary) throw new Error('ffmpeg.exe not found in archive')
    await fs.copyFile(binary, target)
    const ffprobe = await findFile(staging, 'ffprobe.exe')
    if (ffprobe) await fs.copyFile(ffprobe, path.join(BIN_DIR, 'ffprobe.exe'))
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }

  const digest = await sha256File(target)
  entry.sha256 = digest
  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  log(`installed ${target}`)
}

main().catch((error) => {
  console.error('[fetch-ffmpeg] ERROR:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
