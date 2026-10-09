import { WebSocket } from 'ws'

import { t } from '@shared/i18n'

import type { Aria2Notification } from './types'

/**
 * Thrown when aria2 answers a JSON-RPC call with an error object.
 */
export class Aria2RpcError extends Error {
  readonly code: number
  readonly method: string

  constructor(code: number, message: string, method: string) {
    super(message)
    this.name = 'Aria2RpcError'
    this.code = code
    this.method = method
  }
}

interface JsonRpcResponse<T> {
  id?: string
  jsonrpc?: string
  result?: T
  error?: { code: number; message: string }
}

export interface RpcClientOptions {
  port: number
  secret: string
  host?: string
  /** Per-request timeout. aria2 answers instantly, so this is a liveness guard. */
  timeoutMs?: number
}

type NotificationHandler = (notification: Aria2Notification) => void

/**
 * aria2 option values. Nearly all are strings, but repeatable options such as
 * `header` take an array.
 */
export type Aria2OptionValue = string | string[]
export type Aria2Options = Record<string, Aria2OptionValue>

/**
 * Minimal aria2 JSON-RPC client.
 *
 * Two transports, deliberately:
 *  - HTTP POST for request/response calls, which is what every mutation uses.
 *  - WebSocket for `onDownload*` notifications, because aria2 delivers
 *    notifications only over WebSocket; the HTTP interface has none at all.
 *
 * The notification socket is a latency optimisation, never a source of truth:
 * the poller reconciles full state on every tick, so a dropped or unsupported
 * notification costs freshness rather than correctness.
 */
export class Aria2RpcClient {
  private readonly port: number
  private readonly host: string
  private readonly secret: string
  private readonly timeoutMs: number

  private socket: WebSocket | null = null
  private handlers: NotificationHandler[] = []
  private nextId = 1
  private reconnectTimer: NodeJS.Timeout | null = null
  private closed = false
  private readonly notificationCache = new Set<string>()

  constructor(options: RpcClientOptions) {
    this.port = options.port
    this.host = options.host ?? '127.0.0.1'
    this.secret = options.secret
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  get endpoint(): string {
    return `http://${this.host}:${this.port}/jsonrpc`
  }

  private get secretParam(): string {
    return `token:${this.secret}`
  }

  private async request<T>(method: string, params: unknown[], withSecret = true): Promise<T> {
    const id = `ariadm-${this.nextId++}`
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      // Every aria2 method expects the secret token as its first parameter, with
      // the single exception of `system.multicall`, which carries the token
      // inside each sub-call and rejects a top-level one outright.
      params: withSecret ? [this.secretParam, ...params] : params
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response

    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Aria2RpcError(-1, t('supervisor.rpcTimeout', { method, ms: this.timeoutMs }), method)
      }
      throw new Aria2RpcError(-1, t('supervisor.rpcConnectFailed', { method, message: (error as Error).message }), method)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      throw new Aria2RpcError(-1, `${method} HTTP ${response.status}`, method)
    }

    const payload = (await response.json()) as JsonRpcResponse<T>
    if (payload.error) {
      throw new Aria2RpcError(payload.error.code, payload.error.message, method)
    }
    return payload.result as T
  }

  call<T>(method: string, ...params: unknown[]): Promise<T> {
    // aria2 validates arity strictly. `JSON.stringify` renders an `undefined`
    // array entry as `null`, so an omitted optional argument such as the `keys`
    // list has to leave the parameter list entirely rather than arrive as null,
    // which aria2 answers with HTTP 400.
    let end = params.length
    while (end > 0 && params[end - 1] === undefined) end -= 1
    return this.request<T>(method, params.slice(0, end))
  }

  /**
   * Batch several tell* calls into one round trip.
   *
   * system.multicall returns an array where each slot is either a one-element
   * result array or a fault object, so an individual failure yields null instead
   * of discarding the whole batch. That matters here because a download can
   * finish between listing and status lookup, which is a routine race.
   */
  async multicall<T>(calls: { method: string; params?: unknown[] }[]): Promise<(T | null)[]> {
    if (calls.length === 0) return []
    // `system.multicall` takes exactly one parameter: the array of sub-calls, and
    // each sub-call carries the secret itself. Verified against aria2 1.37.0: a
    // top-level secret is answered with "The parameter at 0 has wrong type".
    const result = await this.request<unknown[]>(
      'system.multicall',
      [calls.map((entry) => ({ methodName: entry.method, params: [this.secretParam, ...(entry.params ?? [])] }))],
      false
    )
    return result.map((slot) => (Array.isArray(slot) ? (slot[0] as T) : null))
  }

  // ---- convenience wrappers -------------------------------------------------

  getVersion(): Promise<{ version: string; enabledFeatures: string[] }> {
    return this.call('aria2.getVersion')
  }

  getGlobalStat(): Promise<Record<string, string>> {
    return this.call('aria2.getGlobalStat')
  }

  getGlobalOption(): Promise<Record<string, string>> {
    return this.call('aria2.getGlobalOption')
  }

  changeGlobalOption(options: Aria2Options): Promise<string> {
    return this.call('aria2.changeGlobalOption', options)
  }

  addUri(uris: string[], options: Aria2Options = {}): Promise<string> {
    return this.call('aria2.addUri', uris, options)
  }

  addTorrent(base64: string, uris: string[], options: Aria2Options = {}): Promise<string> {
    return this.call('aria2.addTorrent', base64, uris, options)
  }

  addMetalink(base64: string, options: Aria2Options = {}): Promise<string[]> {
    return this.call('aria2.addMetalink', base64, options)
  }

  tellStatus(gid: string, keys?: string[]): Promise<Record<string, unknown>> {
    return this.call('aria2.tellStatus', gid, keys)
  }

  tellActive(keys?: string[]): Promise<Record<string, unknown>[]> {
    return this.call('aria2.tellActive', keys)
  }

  tellWaiting(offset: number, num: number, keys?: string[]): Promise<Record<string, unknown>[]> {
    return this.call('aria2.tellWaiting', offset, num, keys)
  }

  tellStopped(offset: number, num: number, keys?: string[]): Promise<Record<string, unknown>[]> {
    return this.call('aria2.tellStopped', offset, num, keys)
  }

  changeOption(gid: string, options: Aria2Options): Promise<string> {
    return this.call('aria2.changeOption', gid, options)
  }

  getOption(gid: string): Promise<Record<string, string>> {
    return this.call('aria2.getOption', gid)
  }

  changePosition(gid: string, position: number, how: 'POS_SET' | 'POS_CUR' | 'POS_END'): Promise<number> {
    return this.call('aria2.changePosition', gid, position, how)
  }

  pause(gid: string): Promise<string> {
    return this.call('aria2.pause', gid)
  }

  unpause(gid: string): Promise<string> {
    return this.call('aria2.unpause', gid)
  }

  pauseAll(): Promise<string> {
    return this.call('aria2.pauseAll')
  }

  unpauseAll(): Promise<string> {
    return this.call('aria2.unpauseAll')
  }

  remove(gid: string): Promise<string> {
    return this.call('aria2.remove', gid)
  }

  forceRemove(gid: string): Promise<string> {
    return this.call('aria2.forceRemove', gid)
  }

  removeDownloadResult(gid: string): Promise<string> {
    return this.call('aria2.removeDownloadResult', gid)
  }

  purgeDownloadResult(): Promise<string> {
    return this.call('aria2.purgeDownloadResult')
  }

  getServers(gid: string): Promise<Record<string, unknown>[]> {
    return this.call('aria2.getServers', gid)
  }

  getPeers(gid: string): Promise<Record<string, unknown>[]> {
    return this.call('aria2.getPeers', gid)
  }

  getFiles(gid: string): Promise<Record<string, unknown>[]> {
    return this.call('aria2.getFiles', gid)
  }

  getUris(gid: string): Promise<Record<string, unknown>[]> {
    return this.call('aria2.getUris', gid)
  }

  saveSession(): Promise<string> {
    return this.call('aria2.saveSession')
  }

  shutdown(): Promise<string> {
    return this.call('aria2.shutdown')
  }

  forceShutdown(): Promise<string> {
    return this.call('aria2.forceShutdown')
  }

  listNotifications(): Promise<string[]> {
    return this.call('system.listNotifications')
  }

  listMethods(): Promise<string[]> {
    return this.call('system.listMethods')
  }

  // ---- notifications -------------------------------------------------------

  /**
   * Connect the notification socket and record which notification names this
   * build actually advertises, so the supported set is observed rather than
   * assumed.
   */
  connectNotifications(onNotification: NotificationHandler, onLog?: (message: string) => void): void {
    this.handlers.push(onNotification)
    if (this.socket || this.closed) return

    const url = `ws://${this.host}:${this.port}/jsonrpc`
    const socket = new WebSocket(url)
    this.socket = socket

    socket.on('open', () => {
      onLog?.(`notification socket connected (${url})`)
      this.listNotifications()
        .then((names) => {
          for (const name of names) this.notificationCache.add(name)
          onLog?.(`aria2 notifications advertised: ${names.join(', ') || 'none'}`)
        })
        .catch((error: unknown) => onLog?.(`listNotifications failed: ${(error as Error).message}`))
    })

    socket.on('message', (raw: Buffer) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      if (!parsed || typeof parsed !== 'object') return
      const message = parsed as { method?: string; params?: unknown }
      if (typeof message.method !== 'string' || !message.method.startsWith('aria2.')) return
      const params = (message.params ?? {}) as Record<string, unknown>
      const notification: Aria2Notification = {
        method: message.method as Aria2Notification['method'],
        gid: Array.isArray(params.gid) ? String(params.gid[0]) : String(params.gid ?? '')
      }
      for (const handler of this.handlers) handler(notification)
    })

    socket.on('error', (error: Error) => {
      onLog?.(`notification socket error: ${error.message}`)
    })

    socket.on('close', () => {
      this.socket = null
      if (this.closed) return
      this.reconnectTimer = setTimeout(() => this.connectNotifications(() => {}, onLog), 4000)
      this.reconnectTimer.unref?.()
    })
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter((entry) => entry !== handler)
    }
  }

  get supportedNotifications(): string[] {
    return [...this.notificationCache]
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.handlers = []
    try {
      this.socket?.close()
    } catch {
      // Socket already gone.
    }
    this.socket = null
  }
}
