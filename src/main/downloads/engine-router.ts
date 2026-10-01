import type { AddDownloadInput, AddDownloadResult, Settings } from '@shared/settings'
import { defaultFormatId } from '@shared/media-formats'
import { chooseEngine, shouldWarnAboutMissingYtDlp } from '@shared/media-sites'

import type { DownloadManager } from './manager'
import type { MediaJobs } from '../media/jobs'
import type { HttpContext } from '../media/ytdlp'

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
      // The engine is named rather than inherited: a request that asked for
      // yt-dlp but could not have it would otherwise be recorded, and shown, as
      // a yt-dlp download that aria2 actually performed.
      const result = await this.options.manager.add({ ...input, engine: 'aria2' })
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

    const http: HttpContext = {
      cookieHeader: input.cookieHeader,
      referer: input.referer,
      userAgent: input.userAgent
    }

    try {
      /*
       * Probe here rather than inside the media engine, so *this* function can
       * still change its mind about the engine. A probe that found nothing but a
       * single plain HTTP payload means the link was a file, not a media page —
       * sometimes a page whose only media is that file. yt-dlp would fetch it on
       * one connection after a startup and an extraction pass; aria2 does it with
       * its full fan-out and a real size. See MediaProbe.directUrl.
       */
      const probe = await this.options.mediaJobs.probe(url, http)

      if (probe.directUrl) {
        this.options.log(`engine router: ${url} resolved to a direct file; using aria2`)
        // The engine is named rather than left to default, or the history row
        // would claim this download was made by yt-dlp.
        return await this.options.manager.add({ ...input, engine: 'aria2', uris: [probe.directUrl] })
      }

      // A requested format is honoured only when the probe actually offered it:
      // a stale picker, or a link that changed between the menu and the click,
      // must not turn into "Requested format is not available".
      const requested = probe.formats.some((format) => format.formatId === input.mediaFormatId)
        ? input.mediaFormatId!
        : ''

      const { gid } = await this.options.mediaJobs.add(
        {
          url,
          // Not `formats[0]`: on a machine without ffmpeg the best entry cannot
          // be produced at all, and this path is the extension's "download this
          // video" — it has to just work.
          formatId: requested || defaultFormatId(probe.formats, this.options.mediaJobs.hasFfmpeg),
          // A browser capture carries no directory, and aria2 hides that: it
          // falls back to the engine's own --dir, so plain handoffs landed in the
          // right place. yt-dlp is told where to write per run, so an empty value
          // became `--paths ''` and the file went next to the app instead —
          // inside Program Files for an installed build, which is where the
          // "[Errno 13] Permission denied" on a .part file came from.
          dir: input.dir || settings.downloadDir,
          audioOnly: false,
          playlist: false,
          maxConcurrent: 0
        },
        probe,
        http
      )
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
