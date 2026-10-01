import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

/**
 * A minimal PNG encoder/decoder plus the AriaDM icon renderer.
 *
 * The mark itself is raster artwork kept at `resources/icons/icon-source.png`
 * with its background already knocked out. This module only reads that file and
 * derives the sizes the app and the browser extension need, so the committed
 * artwork stays the single source of truth and the smaller icons can never go
 * stale against it.
 *
 * Written by hand rather than pulled in as a dependency because the project
 * ships no image libraries; `encodePng` is also what the browser-extension
 * builder uses.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** Apply one of the five PNG row filters, returning unfiltered bytes. */
function filterRow(strategy, row, prior, channels) {
  const out = Buffer.alloc(row.length)
  for (let i = 0; i < row.length; i += 1) {
    const a = i >= channels ? row[i - channels] : 0
    const b = prior[i]
    const c = i >= channels ? prior[i - channels] : 0
    let value = row[i]
    if (strategy === 1) value -= a
    else if (strategy === 2) value -= b
    else if (strategy === 3) value -= (a + b) >> 1
    else if (strategy === 4) value -= paeth(a, b, c)
    out[i] = value & 0xff
  }
  return out
}

/** libpng's heuristic: the filter whose output compresses best is the flattest one. */
function filterCost(row) {
  let cost = 0
  for (let i = 0; i < row.length; i += 1) {
    cost += row[i] < 128 ? row[i] : 256 - row[i]
  }
  return cost
}

/**
 * Encode an RGBA pixel buffer as a colour-type-6 PNG.
 *
 * Every row picks its own filter. The mark used to be flat vector-ish colour
 * where "none" was as good as anything, but the artwork is a photographed-ish
 * gradient now, and leaving rows unfiltered inflates the file by roughly a third.
 */
export function encodePng(width, height, pixels) {
  const channels = 4
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  let prior = Buffer.alloc(stride)
  let offset = 0

  for (let y = 0; y < height; y += 1) {
    // A fresh copy per row: `prior` keeps this row for the next one, so the
    // buffer must not be reused.
    const row = Buffer.from(pixels.subarray(y * stride, (y + 1) * stride))

    let bestStrategy = 0
    let bestRow = filterRow(0, row, prior, channels)
    let bestCost = filterCost(bestRow)
    for (let strategy = 1; strategy <= 4; strategy += 1) {
      const candidate = filterRow(strategy, row, prior, channels)
      const cost = filterCost(candidate)
      if (cost < bestCost) {
        bestStrategy = strategy
        bestRow = candidate
        bestCost = cost
      }
    }

    raw[offset] = bestStrategy
    offset += 1
    bestRow.copy(raw, offset)
    offset += stride

    prior = row
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Decode an 8-bit, non-interlaced PNG into an RGBA pixel buffer.
 *
 * That is deliberately the whole supported surface: it covers the artwork this
 * project commits, and anything else fails loudly instead of silently producing
 * a wrong icon.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file')

  let width = 0
  let height = 0
  let channels = 0
  const idat = []

  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8]
      const colourType = data[9]
      const interlace = data[12]
      if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`)
      if (interlace !== 0) throw new Error('interlaced PNGs are not supported')
      if (colourType === 6) channels = 4
      else if (colourType === 2) channels = 3
      else throw new Error(`unsupported PNG colour type ${colourType}`)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  if (!width || !height) throw new Error('PNG has no IHDR')

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * 4)
  // Two scanlines of working space: `prior` is the reconstructed row above.
  let prior = Buffer.alloc(stride)
  let current = Buffer.alloc(stride)
  let cursor = 0

  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    for (let i = 0; i < stride; i += 1) {
      const value = raw[cursor + i]
      const a = i >= channels ? current[i - channels] : 0
      const b = prior[i]
      const c = i >= channels ? prior[i - channels] : 0
      let restored
      switch (filter) {
        case 0:
          restored = value
          break
        case 1:
          restored = value + a
          break
        case 2:
          restored = value + b
          break
        case 3:
          restored = value + ((a + b) >> 1)
          break
        case 4:
          restored = value + paeth(a, b, c)
          break
        default:
          throw new Error(`unknown PNG filter ${filter}`)
      }
      current[i] = restored & 0xff
    }
    cursor += stride

    for (let x = 0; x < width; x += 1) {
      const from = x * channels
      const to = (y * width + x) * 4
      pixels[to] = current[from]
      pixels[to + 1] = current[from + 1]
      pixels[to + 2] = current[from + 2]
      pixels[to + 3] = channels === 4 ? current[from + 3] : 255
    }

    const swap = prior
    prior = current
    current = swap
  }

  return { width, height, pixels }
}

let cachedSource

function loadSource() {
  if (!cachedSource) {
    const file = fileURLToPath(new URL('../../resources/icons/icon-source.png', import.meta.url))
    cachedSource = decodePng(readFileSync(file))
  }
  return cachedSource
}

/**
 * Area-average the source down to `size`, accumulating colour premultiplied by
 * alpha. Averaging straight RGBA would let the fully transparent corners bleed
 * their (meaningless) colour into the rounded edges and grey them out.
 */
function resample(source, size) {
  const { width: sourceWidth, height: sourceHeight, pixels } = source
  const out = Buffer.alloc(size * size * 4)
  const scaleX = sourceWidth / size
  const scaleY = sourceHeight / size

  for (let y = 0; y < size; y += 1) {
    const top = y * scaleY
    const bottom = top + scaleY
    for (let x = 0; x < size; x += 1) {
      const left = x * scaleX
      const right = left + scaleX

      let alphaArea = 0
      let totalArea = 0
      let red = 0
      let green = 0
      let blue = 0

      for (let sy = Math.floor(top); sy < Math.min(sourceHeight, Math.ceil(bottom)); sy += 1) {
        const rowWeight = Math.min(bottom, sy + 1) - Math.max(top, sy)
        if (rowWeight <= 0) continue
        for (let sx = Math.floor(left); sx < Math.min(sourceWidth, Math.ceil(right)); sx += 1) {
          const columnWeight = Math.min(right, sx + 1) - Math.max(left, sx)
          if (columnWeight <= 0) continue
          const weight = columnWeight * rowWeight
          const from = (sy * sourceWidth + sx) * 4
          const alpha = pixels[from + 3] / 255
          red += pixels[from] * alpha * weight
          green += pixels[from + 1] * alpha * weight
          blue += pixels[from + 2] * alpha * weight
          alphaArea += alpha * weight
          totalArea += weight
        }
      }

      const to = (y * size + x) * 4
      if (alphaArea > 0) {
        out[to] = Math.round(red / alphaArea)
        out[to + 1] = Math.round(green / alphaArea)
        out[to + 2] = Math.round(blue / alphaArea)
      }
      out[to + 3] = Math.round((alphaArea / totalArea) * 255)
    }
  }

  return out
}

/** Render the app mark at `size` by downsampling the committed source artwork. */
export function renderIcon(size) {
  return encodePng(size, size, resample(loadSource(), size))
}
