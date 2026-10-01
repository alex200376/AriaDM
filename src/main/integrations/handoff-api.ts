import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'

/**
 * The loopback handoff API that the browser extension talks to.
 *
 * Why an HTTP endpoint rather than Chrome native messaging: this works
 * identically across Chrome, Edge and Firefox, needs no registry writes, no
 * extra helper process, and is far easier to debug. The trade-off is that a port
 * is open, which is why three things hold:
 *  - it binds to 127.0.0.1 only, so it is not reachable from the network;
 *  - every request needs a bearer token, compared in constant time;
 *  - the Origin header is checked, so a random web page cannot even probe it
 *    (a page's fetch would carry an http(s) origin, which we reject).
 */
export interface HandoffPayload {
  urls: string[]
  filename?: string
  referer?: string
  userAgent?: string
  cookies?: string
  headers?: string[]
  dir?: string
  category?: string
  paused?: boolean
  /** Base64 body for a .torrent file captured by the extension. */
  torrentBase64?: string
  /**
   * Force an engine. `media` means "this is a page yt-dlp understands", which is
   * what the extension sends when the user clicks the button over a video.
   */
  engine?: 'auto' | 'aria2' | 'ytdlp'
  media?: boolean
}

export interface DiscoverResponse {
  app: 'AriaDM'
  version: string
  /** The port the real add endpoint is listening on. */
  port: number
  token: string
}

export interface HandoffAddResult {
  gids: string[]
  duplicates: { uri: string; existingGid: string; name: string }[]
  warnings: string[]
}

export interface HandoffServerOptions {
  port: number
  token: string
  onAdd(payload: HandoffPayload): Promise<HandoffAddResult>
  onPing(): { version: string; active: number; waiting: number }
  log(line: string): void
  version?: string
  /**
   * Set on the fixed rendezvous listener, whose whole job is to tell a browser
   * extension where the real endpoint is. It advertises someone else's port and
   * token, and refuses everything except discovery.
   */
  announce?: { port: number; token: string }
  discoveryOnly?: boolean
}

/** Reject oversized bodies; a torrent file is the largest legitimate payload. */
const MAX_BODY_BYTES = 12 * 1024 * 1024
const MAX_URLS = 200

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return mismatch === 0
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function isAllowedOrigin(origin: string | undefined): boolean {
  // Extensions send chrome-extension:// or moz-extension://; native callers send
  // nothing at all. A normal web page sends http(s):// and is refused.
  if (!origin) return true
  return origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, x-ariadm-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    // Chrome's Private Network Access rules make a request that reaches a
    // loopback address answer an extra preflight with this header. Without it
    // the extension's fetch is blocked before our handler ever runs, which
    // presents as "the extension can never find the app".
    'access-control-allow-private-network': 'true'
  }
}

export class HandoffServer {
  private server: Server | null = null
  private currentToken: string
  private readonly options: HandoffServerOptions
  private lastError = ''

  constructor(options: HandoffServerOptions) {
    this.options = options
    this.currentToken = options.token
  }

  get token(): string {
    return this.currentToken
  }

  get listeningPort(): number {
    const address = this.server?.address()
    return typeof address === 'object' && address ? address.port : 0
  }

  get error(): string {
    return this.lastError
  }

  rotateToken(): string {
    this.currentToken = randomBytes(16).toString('hex')
    return this.currentToken
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response)
      })

      server.on('error', (error: NodeJS.ErrnoException) => {
        this.lastError =
          error.code === 'EADDRINUSE'
            ? `連接埠 ${this.options.port} 已被占用，請在設定中改用其他連接埠。`
            : error.message
        this.options.log(`handoff server error: ${this.lastError}`)
        reject(error)
      })

      // 127.0.0.1 rather than 0.0.0.0: never reachable off-machine.
      server.listen(this.options.port, '127.0.0.1', () => {
        this.server = server
        this.lastError = ''
        this.options.log(`handoff API listening on 127.0.0.1:${this.listeningPort}`)
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => {
        this.server = null
        resolve()
      })
    })
  }

  /**
   * Bind whichever of `candidates` is free first.
   *
   * Returns null when every candidate is taken, which is a recoverable state:
   * the caller can retry later rather than treating it as fatal. Each attempt
   * gets a freshly built server so a half-failed bind cannot leak a listener.
   */
  static async startFirstAvailable(
    candidates: readonly number[],
    make: (port: number) => HandoffServer
  ): Promise<{ server: HandoffServer; port: number } | null> {
    for (const port of candidates) {
      const server = make(port)
      try {
        await server.start()
        return { server, port: server.listeningPort || port }
      } catch {
        await server.stop().catch(() => undefined)
      }
    }
    return null
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin
    const allowedOrigin = isAllowedOrigin(origin)
    // No CORS headers on a refusal: echoing an untrusted web origin back would
    // hand the page a readable answer to a request we just rejected.
    const headers = allowedOrigin ? corsHeaders(origin) : {}

    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body)
      response.writeHead(status, {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload)
      })
      response.end(payload)
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers)
      response.end()
      return
    }

    if (!allowedOrigin) {
      this.options.log(`handoff rejected origin ${origin}`)
      send(403, { ok: false, error: 'origin not allowed' })
      return
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    // Pairing. Served before the token check because obtaining the token is the
    // point, and it stays extension-only via the Origin guard above — a web
    // page's fetch is refused here, and without CORS headers it could not read
    // the answer even if it got one.
    if (request.method === 'GET' && url.pathname === '/discover') {
      const advertised = this.options.announce
      send(200, {
        ok: true,
        app: 'AriaDM',
        version: this.options.version ?? '',
        port: advertised?.port ?? this.listeningPort,
        token: advertised?.token ?? this.currentToken
      } satisfies DiscoverResponse & { ok: true })
      return
    }

    if (this.options.discoveryOnly) {
      send(404, { ok: false, error: 'not found' })
      return
    }

    const headerToken = request.headers['x-ariadm-token']
    const supplied = (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? url.searchParams.get('token') ?? ''

    if (!timingSafeEqual(supplied, this.currentToken)) {
      send(401, { ok: false, error: 'invalid token' })
      return
    }

    try {
      if (request.method === 'GET' && url.pathname === '/ping') {
        send(200, { ok: true, ...this.options.onPing() })
        return
      }

      if (request.method === 'POST' && url.pathname === '/add') {
        const raw = await readBody(request)
        const parsed = JSON.parse(raw) as HandoffPayload

        if (parsed.engine !== undefined && !['auto', 'aria2', 'ytdlp'].includes(parsed.engine)) {
          send(400, { ok: false, error: 'invalid engine' })
          return
        }

        if (parsed.torrentBase64) {
          // A torrent capture legitimately carries no URL list.
        } else if (!Array.isArray(parsed.urls) || parsed.urls.length === 0) {
          send(400, { ok: false, error: 'urls required' })
          return
        } else if (parsed.urls.length > MAX_URLS) {
          send(400, { ok: false, error: `too many urls (max ${MAX_URLS})` })
          return
        }

        const result = await this.options.onAdd(parsed)
        this.options.log(`handoff accepted ${result.gids.length} download(s)`)
        send(200, { ok: true, ...result })
        return
      }

      send(404, { ok: false, error: 'not found' })
    } catch (error) {
      this.options.log(`handoff request failed: ${(error as Error).message}`)
      send(500, { ok: false, error: (error as Error).message })
    }
  }
}
