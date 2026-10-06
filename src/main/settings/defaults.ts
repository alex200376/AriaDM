import { randomBytes } from 'node:crypto'

import type { AppPaths, Settings } from '@shared/settings'
import { CONNECTION_PRESETS, DEFAULT_CATEGORIES } from '@shared/settings'

/**
 * A browser-like default User-Agent. aria2's own default advertises itself as
 * "aria2/1.37.0", which a fair number of hosts reject outright, and matching a
 * normal browser is the least surprising behaviour for a download manager.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export function createDefaultSettings(paths: AppPaths): Settings {
  const preset = CONNECTION_PRESETS.standard
  return {
    downloadDir: paths.downloads,
    connectionsPreset: 'standard',
    split: preset.split,
    maxConnectionPerServer: preset.maxConnectionPerServer,
    minSplitSize: preset.minSplitSize,
    maxConcurrentDownloads: 5,

    globalDownloadLimit: 0,
    globalUploadLimit: 0,

    theme: 'dark',
    // The app shipped in Traditional Chinese first, so 'system' is the safe
    // default: English users get English, everyone else keeps what they had.
    language: 'system',
    accent: 'violet',
    // No custom colour and no wallpaper until asked for: both are opt-in, and a
    // default picture would be one more thing to ship and to explain.
    customAccent: '',
    backgroundImage: '',
    backgroundBlur: 0,
    backgroundDim: 40,
    backgroundOpacity: 88,
    // Zoomed to fit and centred: what the picture does with no crop at all.
    backgroundZoom: 100,
    backgroundPositionX: 50,
    backgroundPositionY: 50,
    density: 'comfortable',

    closeToTray: true,
    startMinimised: false,
    notifyOnComplete: true,
    notifyOnError: true,
    soundOnComplete: false,

    clipboardWatch: false,
    clipboardAutoAdd: false,

    handoffEnabled: true,
    handoffPort: 7069,
    handoffToken: randomBytes(16).toString('hex'),
    // On by default: it is the whole point of the browser integration, and it is
    // silent when the extension is not installed.
    showCatchPopup: true,

    ytdlpEnabled: true,
    ytdlpDetectSites: true,
    // On by default: most of the sites people actually want (X, Instagram,
    // Facebook, age-gated YouTube) return nothing without a logged-in session.
    mediaCookiesFromBrowser: 'auto',
    // On by default: without it, a browser whose cookie store yt-dlp cannot read
    // (Perplexity Comet, for instance) can never download anything that needs a
    // login. Nothing is stored or logged beyond the download in question.
    mediaExtensionCookies: true,
    // Five fragments in flight is a comfortable middle: it is several times the
    // default speed on segmented sites without hammering the origin.
    mediaConcurrentFragments: 5,
    // Off by default: it is an extra request per chunk, so it only pays off on a
    // host that throttles a single connection. Measured over a 1.4 MB HLS segment
    // on such a CDN, 1 MiB gave the best median (5.7 s vs 19.2 s unchunked), but
    // the spread was far too wide to call it a consistent win — 256 KiB and 4 MiB
    // were both worse — so this is a knob the user turns on, not a default.
    mediaHttpChunkSize: 0,
    ffmpegPath: '',

    aria2Path: '',
    aria2RpcPort: 6800,
    // Most home networks have no usable IPv6 route while the sites people
    // download from do publish AAAA records, so this fixes more than it breaks.
    disableIpv6: 'auto',
    autoSaveInterval: 30,
    maxTries: 5,
    retryWait: 5,
    userAgent: DEFAULT_USER_AGENT,
    proxy: '',

    seedRatio: 1,
    seedTime: 0,

    useSystemTray: true,
    confirmOnExit: false,

    activeProfileId: null,
    profiles: [
      {
        id: 'standard',
        name: '標準',
        maxOverallDownloadLimit: 0,
        maxOverallUploadLimit: 0,
        maxConcurrentDownloads: 5,
        split: 8,
        maxConnectionPerServer: 8,
        minSplitSize: 4 * 1024 * 1024
      },
      {
        id: 'steady',
        name: '穩健',
        maxOverallDownloadLimit: 0,
        maxOverallUploadLimit: 0,
        maxConcurrentDownloads: 3,
        split: 4,
        maxConnectionPerServer: 4,
        minSplitSize: 8 * 1024 * 1024
      },
      {
        id: 'turbo',
        name: '極速',
        maxOverallDownloadLimit: 0,
        maxOverallUploadLimit: 0,
        maxConcurrentDownloads: 8,
        split: 16,
        maxConnectionPerServer: 16,
        minSplitSize: 1 * 1024 * 1024
      },
      {
        id: 'night',
        name: '夜間無限速',
        maxOverallDownloadLimit: 0,
        maxOverallUploadLimit: 0,
        maxConcurrentDownloads: 8,
        split: 16,
        maxConnectionPerServer: 16,
        minSplitSize: 1 * 1024 * 1024
      },
      {
        id: 'work',
        name: '上班時段限速',
        maxOverallDownloadLimit: 512 * 1024,
        maxOverallUploadLimit: 64 * 1024,
        maxConcurrentDownloads: 3,
        split: 4,
        maxConnectionPerServer: 4,
        minSplitSize: 8 * 1024 * 1024
      }
    ],
    schedules: [],
    categories: DEFAULT_CATEGORIES,
    postAction: { openFile: false, showInFolder: true, notify: true, command: '' },
    hiddenCategories: [],
    // Deliberately small, in the spirit of IDM's compact main window: this is a
    // queue list plus one toolbar, not a document window. It is resized and
    // remembered from there.
    window: { width: 880, height: 560, x: null, y: null, maximised: false }
  }
}
