import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/**
 * A local origin for integration tests, with Range support so aria2 actually
 * opens multiple connections the way it does against a real host.
 *
 * The payload is random rather than patterned: a repeated-byte file can be
 * fetched from the wrong offsets and still hash correctly, which would hide
 * exactly the class of bug these tests exist to catch.
 */
export interface FixtureServer {
  origin: string
  payload: Buffer
  payloadSha256: string
  slowPayload: Buffer
  slowSha256: string
  dupePayload: Buffer
  dupeSha256: string
  /** A playlist of throttled segments, for a download that arrives in pieces. */
  hlsUrl: string
  hlsSegmentBytes: number
  requestCount(path: string): number
  rangeRequests: number
  close(): Promise<void>
}

interface FixtureOptions {
  sizeBytes?: number
  slowSizeBytes?: number
  dupeSizeBytes?: number
  /** Bytes per chunk on the throttled endpoint. */
  slowChunkBytes?: number
  /** Delay between chunks on the throttled endpoint. */
  slowDelayMs?: number
  /** Segments in the fake HLS playlist. Long enough to cancel mid-download. */
  hlsSegments?: number
  /** Bytes in each segment, served at the same throttled rate as /slow.bin. */
  hlsSegmentBytes?: number
}

function parseRange(header: string | undefined, total: number): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  if (rawStart === '') {
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    return { start: Math.max(0, total - length), end: total - 1 }
  }

  const start = Number(rawStart)
  const end = rawEnd === '' ? total - 1 : Number(rawEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null
  return { start, end: Math.min(end, total - 1) }
}

export async function startFixtureServer(options: FixtureOptions = {}): Promise<FixtureServer> {
  const payload = randomBytes(options.sizeBytes ?? 3 * 1024 * 1024)
  const slowPayload = randomBytes(options.slowSizeBytes ?? 16 * 1024 * 1024)
  const dupePayload = randomBytes(options.dupeSizeBytes ?? 8 * 1024 * 1024)
  const slowChunkBytes = options.slowChunkBytes ?? 256 * 1024
  const slowDelayMs = options.slowDelayMs ?? 60
  const hlsSegments = options.hlsSegments ?? 40
  const hlsSegmentBytes = options.hlsSegmentBytes ?? 2 * 1024 * 1024
  const hlsSegment = randomBytes(hlsSegmentBytes)

  const counts = new Map<string, number>()
  let rangeRequests = 0

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    counts.set(pathname, (counts.get(pathname) ?? 0) + 1)

    if (pathname === '/missing.bin') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }

    if (pathname === '/payload.bin') {
      const range = parseRange(request.headers.range, payload.length)
      if (range) {
        rangeRequests += 1
        response.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-length': String(range.end - range.start + 1),
          'content-range': `bytes ${range.start}-${range.end}/${payload.length}`,
          'accept-ranges': 'bytes'
        })
        response.end(payload.subarray(range.start, range.end + 1))
        return
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(payload.length),
        'accept-ranges': 'bytes'
      })
      response.end(payload)
      return
    }

    if (pathname === '/dupe.bin') {
      const range = parseRange(request.headers.range, dupePayload.length)
      if (range) {
        rangeRequests += 1
        response.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-length': String(range.end - range.start + 1),
          'content-range': `bytes ${range.start}-${range.end}/${dupePayload.length}`,
          'accept-ranges': 'bytes'
        })
        response.end(dupePayload.subarray(range.start, range.end + 1))
        return
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(dupePayload.length),
        'accept-ranges': 'bytes'
      })
      response.end(dupePayload)
      return
    }

    /*
     * A segmented stream, which is how the leaks this suite covers were found.
     *
     * A fragmented download is fetched as one file per piece — `<name>.part-FragN`
     * — under a `<name>.part` that they are appended to, with a `<name>.ytdl`
     * beside them describing the run. Every one of those is a file a yt-dlp that
     * is killed mid-download leaves on disk, so a server that serves segments
     * slowly is what makes them observable.
     */
    if (pathname === '/hls/index.m3u8') {
      const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0']
      for (let index = 0; index < hlsSegments; index += 1) {
        lines.push('#EXTINF:4.0,', `seg${index}.ts`)
      }
      lines.push('#EXT-X-ENDLIST', '')
      const body = Buffer.from(lines.join('\n'), 'utf8')
      response.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': String(body.length)
      })
      response.end(body)
      return
    }

    if (/^\/hls\/seg\d+\.ts$/.test(pathname)) {
      response.writeHead(200, {
        'content-type': 'video/mp2t',
        'content-length': String(hlsSegment.length)
      })
      let offset = 0
      const pump = (): void => {
        if (offset >= hlsSegment.length || response.writableEnded || response.destroyed) {
          response.end()
          return
        }
        const next = hlsSegment.subarray(offset, offset + slowChunkBytes)
        offset += next.length
        if (response.write(next)) setTimeout(pump, slowDelayMs)
        else response.once('drain', () => setTimeout(pump, slowDelayMs))
      }
      pump()
      return
    }

    if (pathname === '/slow.bin') {
      // Honouring Range here matters: a resumed download comes back with a
      // `Range` header, and a server that ignores it is a server aria2 cannot
      // continue from.
      const range = parseRange(request.headers.range, slowPayload.length)
      const start = range ? range.start : 0
      const end = range ? range.end : slowPayload.length - 1

      if (range) rangeRequests += 1
      response.writeHead(range ? 206 : 200, {
        'content-type': 'application/octet-stream',
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
        ...(range ? { 'content-range': `bytes ${start}-${end}/${slowPayload.length}` } : {})
      })

      let offset = start
      const pump = (): void => {
        if (offset > end || response.writableEnded || response.destroyed) {
          response.end()
          return
        }
        const next = slowPayload.subarray(offset, Math.min(offset + slowChunkBytes, end + 1))
        offset += next.length
        if (response.write(next)) setTimeout(pump, slowDelayMs)
        else response.once('drain', () => setTimeout(pump, slowDelayMs))
      }
      pump()
      return
    }

    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('fixture server did not bind')
  const origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    payload,
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
    slowPayload,
    slowSha256: createHash('sha256').update(slowPayload).digest('hex'),
    dupePayload,
    dupeSha256: createHash('sha256').update(dupePayload).digest('hex'),
    hlsUrl: `${origin}/hls/index.m3u8`,
    hlsSegmentBytes,
    requestCount: (path: string) => counts.get(path) ?? 0,
    get rangeRequests() {
      return rangeRequests
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

export function sha256(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex')
}
