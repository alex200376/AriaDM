import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  importImage,
  isManagedImage,
  isUsableImage,
  readImageDataUrl,
  removeManagedImage
} from '../../src/main/settings/background-image'

/**
 * The reader is the renderer's only way to show a wallpaper: the window's CSP
 * allows `data:` images, so whatever this returns is what gets painted. A wrong
 * answer here is either a broken background or — worse — a multi-megabyte string
 * the renderer holds forever.
 */
describe('readImageDataUrl', () => {
  let dir = ''

  /** A one-pixel PNG header is enough: the reader decides by extension and size. */
  function writeImage(name: string, contents: Buffer | string): string {
    const file = path.join(dir, name)
    fs.writeFileSync(file, contents)
    return file
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadm-wallpaper-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('wraps a normal image in a data URL with the right MIME type', () => {
    const png = writeImage('wallpaper.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const jpeg = writeImage('photo.jpg', Buffer.from([0xff, 0xd8, 0xff]))

    expect(readImageDataUrl(png)).toBe(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`)
    expect(readImageDataUrl(jpeg)?.startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('accepts the extension in either case', () => {
    const file = writeImage('WALLPAPER.PNG', 'x')

    expect(readImageDataUrl(file)).toBe('data:image/png;base64,eA==')
  })

  it('refuses a file that is not an image, a missing file, and an empty path', () => {
    const text = writeImage('notes.txt', 'hello')
    const video = writeImage('clip.mp4', 'hello')

    expect(readImageDataUrl(text)).toBeNull()
    expect(readImageDataUrl(video)).toBeNull()
    expect(readImageDataUrl(path.join(dir, 'gone.png'))).toBeNull()
    expect(readImageDataUrl('')).toBeNull()
  })

  it('refuses an empty file, which would paint nothing anyway', () => {
    expect(readImageDataUrl(writeImage('empty.png', ''))).toBeNull()
  })

  it('refuses an image over the size cap', () => {
    const big = writeImage('huge.png', Buffer.alloc(MAX_IMAGE_BYTES + 1, 1))
    const atLimit = writeImage('limit.png', Buffer.alloc(MAX_IMAGE_BYTES, 1))

    expect(readImageDataUrl(big)).toBeNull()
    // The cap is inclusive: a file exactly at it is still usable.
    expect(readImageDataUrl(atLimit)?.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('serves the same answer from the cache, and notices a changed file', () => {
    const file = writeImage('wallpaper.webp', 'first')
    const first = readImageDataUrl(file)

    expect(readImageDataUrl(file)).toBe(first)

    // A different picture at the same path has to be picked up, or the user
    // replacing their wallpaper would keep seeing the old one until a restart.
    fs.writeFileSync(file, 'second-and-a-bit-longer')
    const second = readImageDataUrl(file)
    expect(second).not.toBe(first)
    expect(second).toBe(`data:image/webp;base64,${Buffer.from('second-and-a-bit-longer').toString('base64')}`)
  })

  it('advertises exactly the extensions it can read', () => {
    for (const extension of IMAGE_EXTENSIONS) {
      const file = writeImage(`sample.${extension}`, 'x')
      expect(readImageDataUrl(file)).not.toBeNull()
    }
  })
})

/**
 * The copy that makes a wallpaper survive the file it was picked from.
 *
 * The setting holds a path, so before this the wallpaper was exactly as durable
 * as whatever folder the user happened to pick from: renaming it, moving it or
 * clearing the recycle bin left the app pointing at nothing.
 */
describe('importImage', () => {
  let dir = ''
  let wallpapers = ''

  function writeImage(name: string, contents: Buffer | string): string {
    const file = path.join(dir, name)
    fs.writeFileSync(file, contents)
    return file
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadm-source-'))
    wallpapers = path.join(dir, 'userData', 'wallpapers')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('copies the picture into the app folder, keeping its name and its bytes', () => {
    const source = writeImage('screenshot 2026.png', Buffer.from([1, 2, 3, 4]))

    const managed = importImage(source, wallpapers)

    expect(managed).toBe(path.join(wallpapers, 'screenshot 2026.png'))
    expect(fs.readFileSync(managed!)).toEqual(Buffer.from([1, 2, 3, 4]))
    // The original is left where it was; the user's own folder is not ours to
    // clean up.
    expect(fs.existsSync(source)).toBe(true)
  })

  it('keeps the wallpaper after the file it was picked from is deleted', () => {
    // The reported case, end to end: choose a screenshot, delete the screenshot,
    // and the window still has a background.
    const source = writeImage('desktop.png', 'a-picture')
    const managed = importImage(source, wallpapers)

    fs.rmSync(source)

    expect(readImageDataUrl(managed!)).toBe(`data:image/png;base64,${Buffer.from('a-picture').toString('base64')}`)
    expect(isManagedImage(managed!, wallpapers)).toBe(true)
  })

  it('keeps the name the user knows the picture by', () => {
    // Spaces, inner dots and non-ASCII all have to survive: the settings window
    // shows this name, and a copy called "wallpaper.png" would say nothing about
    // which picture is set.
    const source = writeImage('老闆的桌面 2026.10.png', 'x')

    const managed = importImage(source, wallpapers)

    expect(path.basename(managed!)).toBe('老闆的桌面 2026.10.png')
    expect(fs.readdirSync(wallpapers)).toEqual(['老闆的桌面 2026.10.png'])
  })

  it('keeps one wallpaper, not a folder of every picture ever chosen', () => {
    const first = writeImage('holiday.png', 'one')
    const second = writeImage('at-work.jpg', 'two')

    const one = importImage(first, wallpapers)
    const two = importImage(second, wallpapers)

    expect(fs.readdirSync(wallpapers).sort()).toEqual([path.basename(two!)])
    expect(fs.existsSync(one!)).toBe(false)
  })

  it('replaces rather than duplicates when the same name is picked again', () => {
    const source = writeImage('wall.png', 'first')
    importImage(source, wallpapers)

    // A screenshot saved over the same file: the copy has to be the new picture.
    fs.writeFileSync(source, 'second-and-longer')
    const again = importImage(source, wallpapers)

    expect(fs.readdirSync(wallpapers)).toEqual(['wall.png'])
    expect(readImageDataUrl(again!)).toBe(
      `data:image/png;base64,${Buffer.from('second-and-longer').toString('base64')}`
    )
  })

  it('recognises a file that is already the app’s own copy', () => {
    const source = writeImage('wall.png', 'x')
    const managed = importImage(source, wallpapers)!

    expect(importImage(managed, wallpapers)).toBe(managed)
    expect(fs.readdirSync(wallpapers)).toEqual(['wall.png'])
  })

  it('refuses anything that is not a usable picture, and copies nothing', () => {
    const text = writeImage('notes.txt', 'hello')
    const huge = writeImage('huge.png', Buffer.alloc(MAX_IMAGE_BYTES + 1, 1))

    expect(importImage(text, wallpapers)).toBeNull()
    expect(importImage(path.join(dir, 'gone.png'), wallpapers)).toBeNull()
    expect(importImage(huge, wallpapers)).toBeNull()
    expect(importImage('', wallpapers)).toBeNull()
    expect(fs.existsSync(wallpapers)).toBe(false)
  })

  it('answers the same question as the reader, without reading the file', () => {
    expect(isUsableImage(writeImage('a.png', 'x'))).toBe(true)
    expect(isUsableImage(writeImage('b.mp4', 'x'))).toBe(false)
    expect(isUsableImage(path.join(dir, 'missing.png'))).toBe(false)
  })

  it('only claims a file inside the folder it manages', () => {
    const inside = path.join(wallpapers, 'wall.png')

    expect(isManagedImage(inside, wallpapers)).toBe(true)
    expect(isManagedImage(path.join(dir, 'wall.png'), wallpapers)).toBe(false)
    // A sibling folder whose name merely starts the same way is not ours.
    expect(isManagedImage(path.join(dir, 'wallpapers-backup', 'w.png'), wallpapers)).toBe(false)
    expect(isManagedImage('', wallpapers)).toBe(false)
  })

  it('deletes the app’s copy when the wallpaper is removed, and nothing else', () => {
    const source = writeImage('wall.png', 'x')
    const managed = importImage(source, wallpapers)!

    removeManagedImage(managed, wallpapers)
    expect(fs.existsSync(managed)).toBe(false)

    // A path outside the folder is a file the app does not own.
    removeManagedImage(source, wallpapers)
    expect(fs.existsSync(source)).toBe(true)
  })
})
