import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getLocale, setLocale } from '@shared/i18n'

import { resolvePaths } from '../../src/main/paths'
import { SettingsStore } from '../../src/main/settings/store'

let root = ''
let store: SettingsStore
const initialLocale = getLocale()

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ariadm-category-'))
  store = new SettingsStore(resolvePaths(root, path.join(root, 'downloads')))
  await store.load()
})

afterEach(async () => {
  setLocale(initialLocale)
  await fsp.rm(root, { recursive: true, force: true })
})

describe('saveCategory', () => {
  it('keeps an edited category in its position', async () => {
    const before = store.get().categories.map((entry) => entry.id)
    const video = store.get().categories.find((entry) => entry.id === 'video')!

    const saved = await store.saveCategory({ ...video, folderName: 'Films' })

    expect(saved.categories.map((entry) => entry.id)).toEqual(before)
    expect(saved.categories[before.indexOf('video')]).toMatchObject({ folderName: 'Films' })
  })

  it('trims a folder path and drops its trailing separator', async () => {
    const video = store.get().categories.find((entry) => entry.id === 'video')!

    const saved = await store.saveCategory({ ...video, dir: '  D:/Media/Videos/  ' })

    expect(saved.categories.find((entry) => entry.id === 'video')?.dir).toBe('D:/Media/Videos')
  })

  it('refuses a relative folder rather than resolving it against the app', async () => {
    setLocale('en')
    const video = store.get().categories.find((entry) => entry.id === 'video')!

    await expect(store.saveCategory({ ...video, dir: 'Media/Videos' })).rejects.toThrow(/absolute/i)
  })

  it('turns separators in a folder name into underscores', async () => {
    const video = store.get().categories.find((entry) => entry.id === 'video')!

    const saved = await store.saveCategory({ ...video, folderName: ' Films / HD ' })

    expect(saved.categories.find((entry) => entry.id === 'video')?.folderName).toBe('Films _ HD')
  })

  it('falls back to the id when the name is blank', async () => {
    const custom = {
      id: 'cat-1',
      name: '   ',
      extensions: ['xyz'],
      dir: '',
      postAction: {}
    }
    const saved = await store.saveCategory(custom)
    expect(saved.categories.find((entry) => entry.id === 'cat-1')?.name).toBe('cat-1')
  })
})
