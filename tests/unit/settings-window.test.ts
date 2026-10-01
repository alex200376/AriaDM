import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolvePaths } from '../../src/main/paths'
import { SettingsStore } from '../../src/main/settings/store'

/**
 * The startup window size.
 *
 * A stored size is only overridden when it matches one the app itself imposed —
 * an older default, or the minimum a drag could reach. A size a person picked
 * has to survive, or their window would jump around on every release.
 */

let root = ''
let store: SettingsStore

async function writeSettings(window: Record<string, unknown>): Promise<void> {
  const paths = resolvePaths(root, path.join(root, 'downloads'))
  await fsp.writeFile(paths.settings, JSON.stringify({ window }, null, 2), 'utf8')
  store = new SettingsStore(paths)
  await store.load()
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ariadm-window-'))
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('startup window size', () => {
  it('opens at the compact default on a fresh install', async () => {
    const paths = resolvePaths(root, path.join(root, 'downloads'))
    store = new SettingsStore(paths)
    await store.load()

    expect(store.get().window).toMatchObject({ width: 880, height: 560 })
  })

  it('adopts the new default when the stored size is one of the app defaults', async () => {
    await writeSettings({ width: 1280, height: 800, x: 40, y: 60, maximised: false })

    // The position is the user's; only the size was the app's idea.
    expect(store.get().window).toMatchObject({ width: 880, height: 560, x: 40, y: 60 })
  })

  it('replaces a window still sitting at the old minimum', async () => {
    await writeSettings({ width: 944, height: 568, x: 260, y: 324, maximised: false })

    expect(store.get().window).toMatchObject({ width: 880, height: 560, x: 260, y: 324 })
  })

  it('keeps a size the user chose themselves', async () => {
    await writeSettings({ width: 1500, height: 950, x: 10, y: 10, maximised: false })

    expect(store.get().window).toMatchObject({ width: 1500, height: 950 })
  })

  it('keeps a maximised window maximised', async () => {
    await writeSettings({ width: 1920, height: 1080, x: 0, y: 0, maximised: true })

    expect(store.get().window).toMatchObject({ width: 1920, height: 1080, maximised: true })
  })
})
