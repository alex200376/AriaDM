#!/usr/bin/env node
/**
 * Fetch the pinned aria2 binary into resources/bin/.
 *
 * Why this is not just "download latest": GitHub's release API reports
 * `digest: null` for aria2's assets, so there is no upstream checksum to verify
 * against. We therefore compute the digest ourselves on the first fetch, write
 * it back into scripts/aria2-manifest.json, and verify against it from then on.
 * That trusts our own first fetch rather than an unverifiable claim, and it
 * means the pinned digest must be committed for integrity to be meaningful.
 *
 * Usage:
 *   node scripts/fetch-aria2.mjs            # download if missing or mismatched
 *   node scripts/fetch-aria2.mjs --force    # always re-download
 *   node scripts/fetch-aria2.mjs --check    # verify only, never download
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MANIFEST_PATH = path.join(HERE, 'aria2-manifest.json')
const BIN_DIR = path.join(ROOT, 'resources', 'bin')
const CACHE_DIR = path.join(ROOT, '.cache', 'downloads')

const args = new Set(process.argv.slice(2))
const FORCE = args.has('--force')
const CHECK_ONLY = args.has('--check')

function log(...parts) {
  console.log('[fetch-aria2]', ...parts)
}

function fail(message) {
  console.error(`[fetch-aria2] ERROR: ${message}`)
  process.exitCode = 1
}

async function readManifest() {
  return JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'))
}

async function writeManifest(manifest) {
  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

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
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`)
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  let seen = 0
  let lastLog = 0
  const body = Readable.fromWeb(response.body)
  body.on('data', (chunk) => {
    seen += chunk.length
    const now = Date.now()
    if (now - lastLog > 1000) {
      lastLog = now
      const pct = total ? ` (${((seen / total) * 100).toFixed(0)}%)` : ''
      log(`  ${(seen / 1024 / 1024).toFixed(1)} MB${pct}`)
    }
  })
  await pipeline(body, createWriteStream(dest))
  return seen
}

/**
 * Extraction strategy: try every extractor that exists on the machine.
 * Git Bash ships GNU tar (cannot read zip), so bsdtar and unzip matter here.
 */
function extractZip(zipPath, destDir) {
  const candidates = []
  if (process.platform === 'win32') {
    candidates.push(['C:\\Windows\\System32\\tar.exe', ['-xf', zipPath, '-C', destDir]])
    candidates.push(['unzip', ['-o', '-q', zipPath, '-d', destDir]])
    candidates.push([
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
      ]
    ])
  } else {
    candidates.push(['unzip', ['-o', '-q', zipPath, '-d', destDir]])
    candidates.push(['bsdtar', ['-xf', zipPath, '-C', destDir]])
    candidates.push(['tar', ['-xf', zipPath, '-C', destDir]])
  }

  const failures = []
  for (const [command, argv] of candidates) {
    const result = spawnSync(command, argv, { stdio: 'pipe' })
    if (result.status === 0) return command
    failures.push(`${command}: ${String(result.stderr ?? '').trim().split('\n')[0] || `exit ${result.status}`}`)
  }
  throw new Error(`no usable zip extractor found\n  ${failures.join('\n  ')}`)
}

async function findFile(dir, name) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
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
  const key = `${process.platform}-${process.arch}`
  const manifest = await readManifest()
  const asset = manifest.aria2.assets[key]

  await fs.mkdir(BIN_DIR, { recursive: true })
  await fs.mkdir(CACHE_DIR, { recursive: true })

  const target = path.join(BIN_DIR, manifest.aria2.binary)

  if (!asset) {
    // Non-Windows platforms are not shipped prebuilt binaries by upstream, so we
    // rely on the system install there instead of vendoring one.
    log(`no pinned prebuilt aria2 for ${key}; expecting a system aria2c instead`)
    const existing = await fs.access(target).then(() => true).catch(() => false)
    if (!existing) {
      log('nothing to do. Install aria2 via your package manager and AriaDM will detect it.')
      return
    }
  }

  const already = await fs.access(target).then(() => true).catch(() => false)
  if (already && !FORCE) {
    if (asset?.sha256) {
      const digest = await sha256File(target)
      if (digest === asset.sha256) {
        log(`aria2c is present and verified (${manifest.aria2.version} ${key})`)
        return
      }
      log('existing aria2c does not match the pinned digest; re-downloading')
    } else {
      const digest = await sha256File(target)
      asset.sha256 = digest
      await writeManifest(manifest)
      log(`pinned local aria2c digest: ${digest}`)
      return
    }
  }

  if (CHECK_ONLY) {
    fail('aria2c is missing or does not match the pinned digest (--check)')
    return
  }

  const zipPath = path.join(CACHE_DIR, asset.file)
  const cached = await fs.access(zipPath).then(() => true).catch(() => false)
  if (cached && !FORCE) {
    log(`using cached ${asset.file}`)
  } else {
    await download(asset.url, zipPath)
  }

  const digest = await sha256File(zipPath)
  if (asset.sha256) {
    if (digest !== asset.sha256) {
      fail(
        `checksum mismatch for ${asset.file}\n  expected ${asset.sha256}\n  actual   ${digest}\n` +
          'Refusing to use the archive. Delete it from .cache/downloads and re-run to re-pin.'
      )
      return
    }
    log('checksum verified')
  } else {
    asset.sha256 = digest
    await writeManifest(manifest)
    log(`pinned ${asset.file} sha256 = ${digest} (commit scripts/aria2-manifest.json)`)
  }

  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'ariadm-aria2-'))
  try {
    const extractor = extractZip(zipPath, staging)
    log(`extracted with ${extractor}`)
    const binary = await findFile(staging, manifest.aria2.binary)
    if (!binary) throw new Error(`${manifest.aria2.binary} not found inside ${asset.file}`)
    await fs.copyFile(binary, target)
    if (process.platform !== 'win32') await fs.chmod(target, 0o755)
    log(`installed ${target}`)
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
