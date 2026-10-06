import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, readImageDataUrl } from '../../src/main/settings/background-image'

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
