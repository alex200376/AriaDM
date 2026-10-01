#!/usr/bin/env node
/**
 * Fetch yt-dlp into resources/bin/.
 *
 * Unlike aria2, yt-dlp genuinely publishes SHA2-256SUMS, so we prefer verifying
 * against that. If the sums file is unreachable we fall back to pinning the
 * locally computed digest into the manifest, same as the aria2 fetcher does.
 *
 * Usage:
 *   node scripts/fetch-ytdlp.mjs [--force] [--check]
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

const args = new Set(process.argv.slice(2))
const FORCE = args.has('--force')
const CHECK_ONLY = args.has('--check')

const log = (...parts) => console.log('[fetch-ytdlp]', ...parts)

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

async function download(url, dest) {
  log(`downloading ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest))
}

async function fetchPublishedDigest(sumsUrl, fileName) {
  try {
    const response = await fetch(sumsUrl, { redirect: 'follow' })
    if (!response.ok) return null
    const text = await response.text()
    for (const line of text.split('\n')) {
      const [digest, name] = line.trim().split(/\s+/)
      if (name === fileName || name === `./${fileName}`) return digest.toLowerCase()
    }
    return null
  } catch {
    return null
  }
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'))
  const entry = manifest.ytdlp
  await fs.mkdir(BIN_DIR, { recursive: true })
  await fs.mkdir(CACHE_DIR, { recursive: true })

  const target = path.join(BIN_DIR, entry.binary)
  const present = await fs.access(target).then(() => true).catch(() => false)

  if (present && !FORCE) {
    const digest = await sha256File(target)
    if (entry.sha256 && digest !== entry.sha256) {
      log('existing yt-dlp does not match the pinned digest; re-downloading')
    } else {
      if (!entry.sha256) {
        entry.sha256 = digest
        await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
        log(`pinned local yt-dlp digest: ${digest}`)
      }
      log('yt-dlp is present')
      return
    }
  }

  if (CHECK_ONLY) {
    log('yt-dlp is missing or unverified (--check)')
    process.exitCode = 1
    return
  }

  const zipPath = path.join(CACHE_DIR, entry.binary)
  await download(entry.url, zipPath)

  const digest = await sha256File(zipPath)
  const published = await fetchPublishedDigest(entry.sumsUrl, entry.binary)
  if (published) {
    if (published !== digest) {
      log(`WARNING: digest differs from upstream SHA2-256SUMS`)
      log(`  upstream ${published}`)
      log(`  actual   ${digest}`)
      log('Refusing to install. Re-run later or pass --force after investigating.')
      process.exitCode = 1
      return
    }
    log('verified against upstream SHA2-256SUMS')
  } else {
    log('upstream sums unavailable; pinning locally computed digest')
  }

  entry.sha256 = digest
  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  await fs.copyFile(zipPath, target)
  if (process.platform !== 'win32') await fs.chmod(target, 0o755)
  log(`installed ${target}`)

  const probe = spawnSync(target, ['--version'], { stdio: 'pipe', timeout: 30_000 })
  if (probe.status === 0) log(`yt-dlp version: ${String(probe.stdout).trim()}`)
}

main().catch((error) => {
  console.error('[fetch-ytdlp] ERROR:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
