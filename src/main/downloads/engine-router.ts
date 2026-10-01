import type { AddDownloadInput, AddDownloadResult, Settings } from '@shared/settings'
import { chooseEngine, shouldWarnAboutMissingYtDlp } from '@shared/media-sites'

import type { DownloadManager } from './manager'
import type { MediaJobs } from '../media/jobs'

export interface EngineRouterOptions {
  manager: DownloadManager
  mediaJobs: MediaJobs
  getSettings(): Settings
  log(line: string): void
}

/**
 * The one place an add request becomes a download.
 *
 * Every entry point funnels through here — the renderer, the browser handoff,
 * the clipboard watcher and the protocol handler — so a link added by any of
 * them behaves identically. Before this existed, `engine: 'auto'` was passed
 * around and then ignored, and only the dedicated media dialog ever reached
 * yt-dlp.
 */
export class EngineRouter {
  constructor(private readonly options: EngineRouterOptions) {}

  /**
   * Add a download, choosing the engine from the request and the settings.
   *
   * A media URL that arrives without a chosen format takes the best available
   * one: the caller asked for "this video", not for a quality decision.
   */
  async add(input: AddDownloadInput): Promise<AddDownloadResult> {
    const settings = this.options.getSettings()
    const request = {
      uris: input.uris,
      engine: input.engine,
      hasTorrent: Boolean(input.torrentBase64),
      hasMetalink: Boolean(input.metalinkBase64)
    }

    const engine = chooseEngine(request, {
      ytdlpEnabled: settings.ytdlpEnabled,
      autoDetect: settings.ytdlpDetectSites,
      ytdlpAvailable: this.options.mediaJobs.binaryAvailable
    })

    if (engine === 'aria2') {
      const result = await this.options.manager.add(input)
      if (shouldWarnAboutMissingYtDlp(request, {
        ytdlpEnabled: settings.ytdlpEnabled,
        autoDetect: settings.ytdlpDetectSites,
        ytdlpAvailable: this.options.mediaJobs.binaryAvailable
      })) {
        return {
          ...result,
          warnings: [...result.warnings, '偵測到影音網站，但尚未安裝 yt-dlp，已改用一般下載。']
        }
      }
      return result
    }

    const url = input.uris[0]!
    this.options.log(`engine router: ${url} -> yt-dlp`)

    try {
      const { gid } = await this.options.mediaJobs.addFromUrl(url, {
        dir: input.dir,
        cookieHeader: input.cookieHeader,
        referer: input.referer,
        userAgent: input.userAgent,
        playlist: false
      })
      return { gids: [gid], duplicates: [], warnings: [] }
    } catch (error) {
      // yt-dlp being installed but unable to handle a link is a normal outcome
      // (an age gate, a geo block, a site change). Falling back keeps the link
      // downloadable instead of failing the user's click.
      const message = (error as Error).message
      this.options.log(`engine router: yt-dlp failed for ${url} (${message})`)

      // An explicit "this is a video" request must not quietly turn into an HTML
      // page download. That fallback is how grabbing a video ended up saving the
      // web page instead: yt-dlp could not resolve the link, aria2 happily
      // fetched the page, and the user got a broken file with no explanation.
      if (input.engine === 'ytdlp') throw new Error(`無法取得影片：${message}`)

      // An auto-routed link is different: the user just wanted the file, so a
      // fallback still gets them something useful.
      this.options.log(`engine router: falling back to aria2 for ${url}`)
      const result = await this.options.manager.add(input)
      return { ...result, warnings: [...result.warnings, `yt-dlp 無法處理此連結，已改用一般下載：${message}`] }
    }
  }
}
