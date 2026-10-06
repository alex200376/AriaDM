import { DIRECT_MEDIA_TAG } from '@shared/download'
import { isStreamManifestUrl } from '@shared/media-sniff'
import { MEDIA_DIRECT_CONNECTIONS, type AddDownloadInput, type AddDownloadResult, type Settings } from '@shared/settings'
import { defaultFormatId, provisionalFormatOption } from '@shared/media-formats'
import {
  chooseEngine,
  needsPageSniff,
  shouldWarnAboutMissingYtDlp,
  type EngineAvailability
} from '@shared/media-sites'

import { boundedValue } from '../bounded'
import type { DownloadManager } from './manager'
import type { MediaJobs } from '../media/jobs'
import type { MediaSniffer, PageScan } from '../media/page-sniff'
import { resolveDirectFile, type HttpContext, type MediaProbe } from '../media/ytdlp'

export interface EngineRouterOptions {
  manager: DownloadManager
  mediaJobs: MediaJobs
  /**
   * Optional so tests (and any caller without one) keep the pure host-list
   * behaviour; production always supplies it via the main process.
   */
  sniffer?: MediaSniffer
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
/**
 * Attach the direct-media provenance marker to a request's tags.
 *
 * These rows look like an ordinary aria2 download even though the user asked for
 * a video; the marker is what makes it visible in the detail view that the link
 * resolved to one plain file and was fetched with aria2's fan-out. Existing tags
 * are kept, and the marker is never added twice.
 */
function withDirectMediaTag(tags: string[] | undefined): string[] {
  return [...new Set([...(tags ?? []), DIRECT_MEDIA_TAG])]
}

/**
 * An answer for a link that was not read, shaped like one that was.
 *
 * Returning this rather than null keeps every caller on one path: what to do with
 * a page is decided in one place, whether or not a page was fetched.
 */
function noScan(): PageScan {
  return { verdict: 'not-media', mediaUrls: [], streamUrls: [], title: '', blocked: false }
}

/**
 * How long an auto-best download waits for the format probe.
 *
 * The probe is an optimisation for this request: it can route a plain payload to
 * aria2, and it warms the cache the quality menu reads. It is not required —
 * yt-dlp resolves `bestvideo+bestaudio/best` in its own download run — so it must
 * not become the thing the click waits on. On a site that rejects the browser
 * session, the credential-free retry alone runs for many seconds; waiting it out
 * is the stall that made the extension's button look dead.
 */
const PROBE_BUDGET_MS = 4_000

/**
 * The probe-shaped stand-in a download starts with when no probe answered.
 *
 * `MediaJobs.add` reads the format list to honour a named quality and to decide
 * whether merging is possible; a list holding only the provisional default gives
 * it the same answers a real probe would for the one choice that was made — the
 * default one. yt-dlp then resolves that selector during the download itself.
 */
function provisionalProbe(url: string, hasFfmpeg: boolean): MediaProbe {
  return {
    url,
    title: url,
    id: '',
    durationSeconds: 0,
    thumbnail: '',
    formats: [provisionalFormatOption(hasFfmpeg, false)],
    subtitles: [],
    isPlaylist: false,
    extractor: '',
    directUrl: '',
    formatUrls: {}
  }
}

export class EngineRouter {
  constructor(private readonly options: EngineRouterOptions) {}

  /**
   * Ask for a probe, but do not let a slow or broken one decide the click.
   *
   * Resolves as soon as the probe answers, and otherwise after `budgetMs` or the
   * probe's own failure — whichever comes first — reporting what went wrong so
   * the caller can still explain it for a request that named a quality. The
   * probe itself keeps running and caches its answer for the menu that follows.
   */
  private async probeWithin(
    url: string,
    http: HttpContext,
    budgetMs: number
  ): Promise<{ probe: MediaProbe | null; error: string }> {
    const result = await boundedValue(this.options.mediaJobs.probe(url, http), budgetMs)
    return { probe: result.value ?? null, error: result.error?.message ?? '' }
  }

  /**
   * Read an unknown-host page and report everything it holds.
   *
   * The verdict alone was not enough: on a hand-rolled player the page is not
   * something yt-dlp can read at all, so knowing it is video only helps if we
   * also know *what* to hand over — the manifest inside the frame, or the plain
   * file it links. That is what `PageScan` carries, so it is what this returns.
   *
   * Nothing is fetched for every case the pure host list already answers — a
   * curated host, a link that names a file, a paste of several links — so the
   * network is only touched for the one case that needs it.
   */
  private async scanPage(input: AddDownloadInput, availability: EngineAvailability): Promise<PageScan> {
    const sniffer = this.options.sniffer
    if (!sniffer) return noScan()
    // An explicit aria2 request is a file download; there is no page to read.
    if (input.engine === 'aria2') return noScan()
    if (!availability.ytdlpEnabled || !availability.ytdlpAvailable) return noScan()
    /*
     * 自動辨識 governs an automatic *guess*. An explicit video request is not a
     * guess, and reading the page is the only way to find the manifest behind its
     * player — which is the difference between a download and an error for the
     * sites this exists for.
     */
    if (input.engine === 'auto' && !availability.autoDetect) return noScan()
    if (input.uris.length !== 1) return noScan()

    const url = input.uris[0]!
    if (!needsPageSniff(url)) return noScan()

    const scan = await sniffer.scan(url, {
      cookieHeader: input.cookieHeader,
      referer: input.referer,
      userAgent: input.userAgent
    })
    if (scan.verdict === 'media') {
      this.options.log(
        `engine router: ${url} sniffed as a media page (` +
          `${scan.mediaUrls.length} file(s), ${scan.streamUrls.length} manifest(s))`
      )
    }
    return scan
  }

  /**
   * Add a download, choosing the engine from the request and the settings.
   *
   * A media URL that arrives without a chosen format takes the best available
   * one: the caller asked for "this video", not for a quality decision.
   */
  async add(input: AddDownloadInput): Promise<AddDownloadResult> {
    const settings = this.options.getSettings()
    const availability = {
      ytdlpEnabled: settings.ytdlpEnabled,
      autoDetect: settings.ytdlpDetectSites,
      ytdlpAvailable: this.options.mediaJobs.binaryAvailable
    }

    // Reading the page is only worth it for an automatic, single, unknown-host
    // link, and only when yt-dlp could act on the answer anyway.
    const scan = await this.scanPage(input, availability)
    const detectedMedia =
      scan.verdict === 'media' || scan.mediaUrls.length > 0 || scan.streamUrls.length > 0

    const request = {
      uris: input.uris,
      engine: input.engine,
      hasTorrent: Boolean(input.torrentBase64),
      hasMetalink: Boolean(input.metalinkBase64),
      detectedMedia
    }

    const engine = chooseEngine(request, availability)

    if (engine === 'aria2') {
      /*
       * A manifest is a play list, and aria2 would save the text of it under a
       * `.mp4` name — a broken file the user cannot play or explain. yt-dlp is
       * the only engine that can fetch the segments and mux them, so without it
       * the honest answer is to say so rather than produce rubbish.
       */
      const only = input.uris.length === 1 ? input.uris[0]! : ''
      if (only !== '' && isStreamManifestUrl(only)) {
        throw new Error(
          '這個連結是串流影音清單（HLS/DASH），需要 yt-dlp 才能下載成影片，請先安裝 yt-dlp。'
        )
      }

      // The engine is named rather than inherited: a request that asked for
      // yt-dlp but could not have it would otherwise be recorded, and shown, as
      // a yt-dlp download that aria2 actually performed.
      const result = await this.options.manager.add({ ...input, engine: 'aria2' })
      const warnings = [...result.warnings]
      if (shouldWarnAboutMissingYtDlp(request, availability)) {
        warnings.push('偵測到影音網站，但尚未安裝 yt-dlp，已改用一般下載。')
      }
      /*
       * A page the site refused to serve is a different thing from a page that
       * was read and found to hold no video, and the aria2 error that follows
       * says nothing about which happened. This is the only place the user finds
       * out that a bot check — not the link — is what stopped it, and it is also
       * the case that reaches this branch most often: a 403 answers the page
       * fetch, so no player is ever seen.
       */
      if (scan.blocked) {
        warnings.push(
          '這個網頁拒絕了讀取（伺服器回應錯誤，可能有 Cloudflare 等防護），已改用一般下載；若仍失敗，請改用瀏覽器或擴充功能按鈕下載。'
        )
      }
      return { ...result, warnings }
    }

    const url = input.uris[0]!

    /*
     * What yt-dlp is actually handed.
     *
     * A player page is usually not something yt-dlp can read: the bundled build
     * answers "Unsupported URL" for both the episode page and the `/_watch/1234`
     * frame it embeds, while the manifest the frame hides downloads perfectly the
     * moment it is handed over directly. So the sniff's manifest wins over the
     * page URL whenever there is one.
     */
    const streamUrl = scan.streamUrls[0] ?? ''

    /*
     * A page that names exactly one plain file *is* that file. It needs no
     * extraction at all — the CDN serves it — and aria2 fetches one file with its
     * full fan-out where yt-dlp uses one connection after a process startup.
     *
     * Only a single candidate: two or more is a listing of episodes rather than
     * one video, and picking one for the user would be a guess.
     */
    const linkedFile =
      scan.streamUrls.length === 0 && scan.mediaUrls.length === 1 ? scan.mediaUrls[0]! : ''

    if (linkedFile !== '') {
      this.options.log(`engine router: ${url} links a single media file; using aria2`)
      return await this.options.manager.add({
        ...input,
        engine: 'aria2',
        uris: [linkedFile],
        tags: withDirectMediaTag(input.tags),
        ...MEDIA_DIRECT_CONNECTIONS
      })
    }

    const target = streamUrl || url
    this.options.log(
      streamUrl ? `engine router: ${url} -> manifest ${streamUrl}` : `engine router: ${url} -> yt-dlp`
    )

    const http: HttpContext = {
      cookieHeader: input.cookieHeader,
      // A CDN serves a manifest only to the player it belongs to, and the page
      // the manifest was found on is exactly the referer a browser would send.
      // A caller's own referer still wins.
      referer: input.referer || (streamUrl ? url : ''),
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
       *
       * Only an explicit video request that named no quality — the extension's
       * button — skips the full probe. yt-dlp resolves the default selector in
       * its own download run, so such a request needs only a short budget (see
       * PROBE_BUDGET_MS) to catch the direct-file case and warm the menu's cache
       * before the download starts, however the probe turned out. A named quality
       * can only be honoured against the list it came from, and an auto-routed
       * link keeps its aria2 fallback, so both still wait for the probe in full.
       */
      const provisionalFallback = !input.mediaFormatId && input.engine === 'ytdlp'

      let probe: MediaProbe | null
      let error = ''
      if (provisionalFallback) {
        const raced = await this.probeWithin(target, http, PROBE_BUDGET_MS)
        probe = raced.probe
        error = raced.error
      } else {
        try {
          probe = await this.options.mediaJobs.probe(target, http)
        } catch (cause) {
          probe = null
          error = (cause as Error).message
        }
      }

      if (probe === null && !provisionalFallback) throw new Error(error || '讀取影片資訊逾時。')

      // `formats[0]` on a real probe is the synthetic best entry, so both paths
      // name the same format. Without a probe, this is the provisional default.
      const resolved = probe ?? provisionalProbe(target, this.options.mediaJobs.hasFfmpeg)

      if (resolved.directUrl) {
        this.options.log(`engine router: ${url} resolved to a direct file; using aria2`)
        // The engine is named rather than left to default, or the history row
        // would claim this download was made by yt-dlp. The fixed fan-out is the
        // point of this route: one plain file, pulled over many connections.
        return await this.options.manager.add({
          ...input,
          engine: 'aria2',
          uris: [resolved.directUrl],
          tags: withDirectMediaTag(input.tags),
          ...MEDIA_DIRECT_CONNECTIONS
        })
      }

      // A requested format is honoured only when the probe actually offered it:
      // a stale picker, or a link that changed between the menu and the click,
      // must not turn into "Requested format is not available".
      const requested = resolved.formats.some((format) => format.formatId === input.mediaFormatId)
        ? input.mediaFormatId!
        : ''

      // Not `formats[0]`: on a machine without ffmpeg the best entry cannot be
      // produced at all, and this path is the extension's "download this video" —
      // it has to just work.
      const formatId = requested || defaultFormatId(resolved.formats, this.options.mediaJobs.hasFfmpeg)

      /*
       * The chosen format may itself be a single plain file: a site yt-dlp
       * recognises that serves one progressive payload rather than a segmented
       * stream. That needs no muxing, so aria2 can fetch it with its full fan-out
       * — the same win as the bare-file case above. A format that needs merging,
       * or any HLS/DASH manifest, resolves to null and stays with yt-dlp below.
       */
      const direct = resolveDirectFile(resolved, formatId)
      if (direct) {
        this.options.log(`engine router: ${url} format ${formatId} is a direct file; using aria2`)
        return await this.options.manager.add({
          ...input,
          engine: 'aria2',
          uris: [direct.url],
          ...(direct.out ? { out: direct.out } : {}),
          tags: withDirectMediaTag(input.tags),
          ...MEDIA_DIRECT_CONNECTIONS
        })
      }

      const { gid } = await this.options.mediaJobs.add(
        {
          url: target,
          // The page's own title, when the download is named after a manifest
          // that has none of its own. See AddMediaInput.title.
          ...(streamUrl && scan.title ? { title: scan.title } : {}),
          formatId,
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
        resolved,
        http
      )
      return { gids: [gid], duplicates: [], warnings: [] }
    } catch (error) {
      // yt-dlp being installed but unable to handle a link is a normal outcome
      // (an age gate, a geo block, a site change). Falling back keeps the link
      // downloadable instead of failing the user's click.
      const message = (error as Error).message
      this.options.log(`engine router: yt-dlp failed for ${url} (${message})`)

      /*
       * There is nothing useful to fall back *to* once a manifest is involved.
       *
       * An explicit "this is a video" request must not quietly turn into an HTML
       * page download — that fallback is how grabbing a video ended up saving the
       * web page: yt-dlp could not resolve the link, aria2 happily fetched the
       * page, and the user got a broken file with no explanation. Handing aria2
       * the manifest instead is worse still: a play list saved under a `.mp4`
       * name. So both cases report the failure.
       */
      if (input.engine === 'ytdlp' || streamUrl !== '') throw new Error(`無法取得影片：${message}`)

      // An auto-routed link is different: the user just wanted the file, so a
      // fallback still gets them something useful.
      this.options.log(`engine router: falling back to aria2 for ${url}`)
      const result = await this.options.manager.add(input)
      return { ...result, warnings: [...result.warnings, `yt-dlp 無法處理此連結，已改用一般下載：${message}`] }
    }
  }
}
