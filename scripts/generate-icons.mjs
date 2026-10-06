#!/usr/bin/env node
/**
 * Generate the app and tray icons as real PNG files.
 *
 * The artwork lives in resources/icons/icon-source.png with its background
 * already knocked out; every size is downsampled from that one file by
 * scripts/lib/icon-png.mjs, which the browser-extension builder also uses, so
 * the mark has one implementation and the small icons cannot drift from it.
 *
 * Usage: node scripts/generate-icons.mjs
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderIcon } from './lib/icon-png.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(HERE, '..', 'resources', 'icons')

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true })

  const outputs = [
    ['app.png', 512],
    // The mark in the title bar. Its own size rather than the 512px app icon:
    // the renderer bundles what it draws, and 512px of artwork for a 20px mark
    // would be a third of a megabyte of bundle for nothing.
    ['mark.png', 64],
    ['tray.png', 16],
    ['tray@2x.png', 32],
    ['tray@3x.png', 48]
  ]

  for (const [name, size] of outputs) {
    const file = path.join(OUT_DIR, name)
    await fs.writeFile(file, renderIcon(size))
    console.log(`[icons] wrote ${path.relative(process.cwd(), file)} (${size}x${size})`)
  }
}

main().catch((error) => {
  console.error('[icons] ERROR:', error.message)
  process.exitCode = 1
})
