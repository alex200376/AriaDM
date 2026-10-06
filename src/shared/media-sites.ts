import { isStreamManifestUrl } from './media-sniff'
import { hasFileExtension } from './uri'

/**
 * Which URLs belong to yt-dlp rather than aria2.
 *
 * This is deliberately a curated host list rather than a heuristic on the URL
 * shape. A download manager has to be predictable: sending a link to the wrong
 * engine either produces a broken file or an empty download, and the user has no
 * way to tell which happened. A site we have never heard of goes to aria2, which
 * is the safe answer for the overwhelming majority of links.
 */

/**
 * Host suffixes that serve pages yt-dlp understands.
 *
 * The first block is the video platforms the app was built around. The rest are
 * sites the bundled yt-dlp ships a dedicated extractor for, taken from its own
 * `--list-extractors` (see `scripts/generate-media-sites.mjs`). Listing a host
 * here only saves a network sniff — an unknown host is still sniffed, and the
 * metadata parser catches the ones whose player is declared in `og:video`. So
 * the list is an optimisation, not the definition of a video site, and a host
 * that turns out not to be video (a news article on a broadcaster's site) is
 * still safe: a failed yt-dlp probe falls back to aria2.
 */
export const MEDIA_SITE_HOSTS = [
  'x.com',
  'twitter.com',
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'reddit.com',
  'twitch.tv',
  'dailymotion.com',
  'soundcloud.com',
  'bilibili.com',
  'nicovideo.jp',
  'vk.com',
  'threads.net',
  'rumble.com',
  'kick.com',
  'streamable.com',
  'weibo.com',
  'youku.com',
  'iqiyi.com',
  'imgur.com',
  'bsky.app',
  // From yt-dlp's own extractor list.
  '24tv.ua',
  '56.com',
  '9now.com.au',
  'abc.net.au',
  'aol.com',
  'archive.org',
  'arte.sky.it',
  'bbc.co.uk',
  'blogger.com',
  'canalc2.tv',
  'cbc.ca',
  'cielotv.it',
  'croatian.film',
  'cu.ntv.co.jp',
  'daum.net',
  'dzen.ru',
  'faz.net',
  'freespeech.org',
  'gem.cbc.ca',
  'ign.com',
  'iq.com',
  'la7.it',
  'maariv.co.il',
  'massengeschmack.tv',
  'media.ccc.de',
  'megaphone.fm',
  'mir24.tv',
  'n-tv.de',
  'nfl.com',
  'nhl.com',
  'nick.com',
  'nts.live',
  'ntv.ru',
  'ocw.mit.edu',
  'onet.pl',
  'onet.tv',
  'parliamentlive.tv',
  'peer.tv',
  'phoenix.de',
  'play.tv',
  'player.sky.it',
  'radio.de',
  'rtl.nl',
  'rtvslo.si',
  'sbs.co.kr',
  'senate.gov',
  'sky.it',
  'southpark.cc.com',
  'southpark.de',
  'southpark.lat',
  'southparkstudios.co.uk',
  'southparkstudios.com.br',
  'southparkstudios.nu',
  't-online.de',
  'techtv.mit.edu',
  'tou.tv',
  'tv.dfb.de',
  'tv2play.hu',
  'tv2playseries.hu',
  'tv8.it',
  'uol.com.br',
  'vh1.com',
  'video.arnes.si',
  'video.sky.it',
  'vids.io',
  'wat.tv',
  'wikimedia.org'
] as const

/**
 * The host suffix this URL belongs to, or null.
 *
 * Matching on whole labels means `notx.com` does not match `x.com`, while
 * `www.x.com` and `mobile.twitter.com` do.
 */
export function matchMediaSite(url: string): string | null {
  let host: string
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    host = parsed.hostname.toLowerCase()
  } catch {
    return null
  }

  for (const site of MEDIA_SITE_HOSTS) {
    if (host === site || host.endsWith(`.${site}`)) return site
  }
  return null
}

/**
 * True when a URL should be handed to yt-dlp.
 *
 * A link that names a file still goes to aria2 even on a media host: sites serve
 * their CDN payloads from the same domain family, and aria2 handles a plain file
 * far better than yt-dlp does.
 *
 * A streaming manifest is the one exception, and it is an exception on *any*
 * host. `.m3u8` and `.mpd` are the right length to look like a file extension,
 * but the payload is a play list and not the video: handed to aria2 it is saved
 * as a text file under a `.mp4` name. Only yt-dlp can fetch the segments and mux
 * them, so a manifest copied straight out of a player still downloads.
 */
export function isMediaSiteUrl(url: string): boolean {
  if (isStreamManifestUrl(url)) return true
  if (matchMediaSite(url) === null) return false
  return !hasFileExtension(url)
}

/**
 * True when this link is worth reading the page to decide.
 *
 * The host list settles the sites we know, and a URL that names a file is a file
 * — both are answered without any network. Everything else that is a single
 * ordinary page link is a candidate: it may be a video page on a host we have
 * never heard of, which is exactly what a content sniff is for. See
 * `MediaSniffer`.
 */
export function needsPageSniff(url: string): boolean {
  if (matchMediaSite(url) !== null) return false
  if (hasFileExtension(url)) return false
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export interface MediaUrlSplit {
  /** Links to media pages, in the order they were pasted. */
  media: string[]
  /** Everything else: plain files, magnet links, hosts we do not recognise. */
  plain: string[]
}

/**
 * Separate a pasted list into video pages and ordinary links.
 *
 * `chooseEngine` refuses to auto-detect anything but a single link, because a
 * pasted list is usually a batch of files — but it can just as easily be a batch
 * of videos, and then the yt-dlp path is exactly what the user wants. Splitting
 * here is what lets one paste keep both: every video page goes to yt-dlp,
 * everything else stays with aria2, instead of the first link deciding for all of
 * them.
 */
export function splitByMediaSite(urls: string[]): MediaUrlSplit {
  const media: string[] = []
  const plain: string[] = []
  for (const url of urls) {
    if (isMediaSiteUrl(url)) media.push(url)
    else plain.push(url)
  }
  return { media, plain }
}

export type EngineChoice = 'aria2' | 'ytdlp'

export interface EngineRequest {
  uris: string[]
  /** The caller's explicit request; 'auto' defers to detection. */
  engine: 'auto' | 'aria2' | 'ytdlp'
  hasTorrent?: boolean
  hasMetalink?: boolean
  /**
   * A page sniff (see `needsPageSniff`) found a player on an unknown host.
   *
   * The sniff runs in the main process and needs the network, so it cannot live
   * in this pure function; the caller passes its answer in. A curated host match
   * does not depend on it.
   */
  detectedMedia?: boolean
}

export interface EngineAvailability {
  ytdlpEnabled: boolean
  /** The user's 自動辨識 switch. */
  autoDetect: boolean
  ytdlpAvailable: boolean
}

/**
 * Pick the engine for one add request.
 *
 * Order matters, and getting it wrong is what broke "download this video":
 *
 *  - A torrent or metalink body is structurally impossible for yt-dlp.
 *  - An explicit choice is never second-guessed. This must come *before* the
 *    自動辨識 switch, because that switch governs automatic detection only. When
 *    it was consulted first, the extension's button — which asks for yt-dlp
 *    outright — was downgraded to aria2 wherever auto-detection was off, and
 *    aria2 then saved the YouTube *page* as the file.
 *  - Turning yt-dlp off entirely still wins over an explicit request, or the
 *    setting would mean nothing.
 */
export function chooseEngine(request: EngineRequest, options: EngineAvailability): EngineChoice {
  if (request.hasTorrent || request.hasMetalink) return 'aria2'
  if (!options.ytdlpEnabled) return 'aria2'

  if (request.engine === 'ytdlp') return options.ytdlpAvailable ? 'ytdlp' : 'aria2'
  if (request.engine === 'aria2') return 'aria2'

  // Automatic detection from here on.
  if (!options.autoDetect) return 'aria2'

  // Detection is only meaningful for a single link; a pasted list is a batch of
  // files, not a media page.
  if (request.uris.length !== 1) return 'aria2'
  const url = request.uris[0]!
  // A curated host that names a file is still aria2; an unknown host is only
  // media when the caller's page sniff said so.
  if (!isMediaSiteUrl(url) && !request.detectedMedia) return 'aria2'
  return options.ytdlpAvailable ? 'ytdlp' : 'aria2'
}

export interface HandoffEngineRequest {
  urls: string[]
  /** An engine the caller named outright, when it had a real reason to. */
  engine?: 'auto' | 'aria2' | 'ytdlp'
  /** The extension's "this is a video" hint from its download button. */
  media?: boolean
}

/**
 * The engine a browser handoff should use.
 *
 * `media` is the extension's "this is a video" signal, and it is better evidence
 * than our host list: the on-page panel only appears on sites we recognise, but
 * the popup's button is offered on any page. It is still only a *hint*, not an
 * instruction.
 *
 * A URL that names a file is a file. yt-dlp fetches a bare payload over one
 * connection, after its own process startup and an extraction pass, and reports
 * no size — on a plain 3.5 MB CDN file that measured tens of times slower than
 * aria2, with a speed readout that is pure noise. Handing it to aria2 is what
 * the user actually wants, whichever button they pressed.
 *
 * An engine the caller named outright is honoured untouched: only the extension's
 * hint is treated as fallible.
 */
export function resolveHandoffEngine(request: HandoffEngineRequest): 'auto' | 'aria2' | 'ytdlp' {
  if (request.engine) return request.engine
  if (!request.media) return 'auto'

  // 'auto' rather than 'aria2' so the ordinary detection still runs; a URL with a
  // file extension is never a media *page*, so it lands on aria2 either way.
  const first = request.urls[0]
  if (first && hasFileExtension(first)) return 'auto'
  return 'ytdlp'
}

/**
 * True when detection wanted yt-dlp but it could not be used, so the caller can
 * explain the fallback instead of silently doing something different.
 */
export function shouldWarnAboutMissingYtDlp(request: EngineRequest, options: EngineAvailability): boolean {
  if (options.ytdlpAvailable || !options.ytdlpEnabled) return false
  if (request.hasTorrent || request.hasMetalink) return false

  // A request that asked for yt-dlp outright deserves an explanation whenever it
  // cannot be honoured; 自動辨識 has nothing to do with it.
  if (request.engine === 'ytdlp') return true

  if (!options.autoDetect) return false
  if (request.uris.length !== 1) return false
  const url = request.uris[0]!
  return isMediaSiteUrl(url) || request.detectedMedia === true
}
