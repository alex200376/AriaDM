import type { AriaDmApi, HandoffInfo, UpdateProgress } from '@shared/ipc'
import type { CategoryRule, Settings, SpeedProfile } from '@shared/settings'
import type { DownloadItem, GlobalStat, HistoryRow, TickPayload, ToolkitStatus } from '@shared/download'
import { DEFAULT_CATEGORIES } from '@shared/settings'
import { matchMediaSite } from '@shared/media-sites'
import { classifyUriList, extensionOf, fileNameFromUri, isSupportedUri, parseUriList } from '@shared/uri'

/**
 * A stand-in for the preload bridge.
 *
 * Present so the UI can run under a plain Vite dev server in a browser, which
 * makes design iteration and screenshot review possible without booting Electron
 * and the aria2 engine. It is installed only when `window.api` is absent, and it
 * is imported lazily so it never reaches the packaged renderer bundle.
 */
const now = Date.now()

const SCENARIOS: {
  name: string
  kind: DownloadItem['kind']
  status: DownloadItem['status']
  total: number
  started: number
  speed: number
  connections: number
}[] = [
  { name: 'ubuntu-24.04.1-desktop-amd64.iso', kind: 'http', status: 'active', total: 6_340_000_000, started: 2_410_000_000, speed: 11_800_000, connections: 16 },
  { name: 'Blender-4.2.1-windows-x64.msi', kind: 'http', status: 'active', total: 312_000_000, started: 96_000_000, speed: 4_120_000, connections: 8 },
  { name: 'springfield.s01.1080p.BluRay.x264', kind: 'bittorrent', status: 'active', total: 18_900_000_000, started: 4_100_000_000, speed: 2_640_000, connections: 42 },
  { name: 'Deep Work - Cal Newport.epub', kind: 'metalink', status: 'waiting', total: 4_100_000, started: 0, speed: 0, connections: 0 },
  { name: 'rustup-init.exe', kind: 'http', status: 'paused', total: 12_600_000, started: 7_400_000, speed: 0, connections: 0 },
  { name: 'dataset-embeddings-v3.tar.zst', kind: 'http', status: 'complete', total: 2_140_000_000, started: 2_140_000_000, speed: 0, connections: 0 },
  { name: 'documentary-4k-hdr.mkv', kind: 'media', status: 'complete', total: 8_720_000_000, started: 8_720_000_000, speed: 0, connections: 0 },
  { name: 'archive-2019-corrupt.7z', kind: 'http', status: 'error', total: 940_000_000, started: 12_000_000, speed: 0, connections: 0 }
]

function categoryFor(name: string): string {
  const extension = extensionOf(name)
  for (const rule of DEFAULT_CATEGORIES) {
    if (rule.extensions.includes(extension)) return rule.id
  }
  return 'other'
}

function buildItems(): DownloadItem[] {
  return SCENARIOS.map((scenario, index) => ({
    gid: `mock-${index}`,
    engine: scenario.kind === 'media' ? ('ytdlp' as const) : ('aria2' as const),
    kind: scenario.kind,
    status: scenario.status,
    name: scenario.name,
    dir: 'C:\\Users\\WOW\\Downloads\\AriaDM',
    files: [
      {
        index: 1,
        path: `C:\\Users\\WOW\\Downloads\\AriaDM\\${scenario.name}`,
        name: scenario.name,
        length: scenario.total,
        completedLength: scenario.started,
        selected: true,
        uris: [{ uri: `https://mirror.example.net/${scenario.name}`, status: 'used' as const }]
      }
    ],
    numFiles: 1,
    totalLength: scenario.total,
    completedLength: scenario.started,
    downloadSpeed: scenario.speed,
    uploadSpeed: scenario.kind === 'bittorrent' ? 218_000 : 0,
    connections: scenario.connections,
    numSeeders: scenario.kind === 'bittorrent' ? 18 : 0,
    seeder: false,
    pieceLength: 262_144,
    numPieces: 4096,
    errorCode: scenario.status === 'error' ? 32 : 0,
    errorMessage: scenario.status === 'error' ? 'piece hash mismatch' : '',
    verifiedLength: 0,
    verifyIntegrityPending: false,
    infoHash: scenario.kind === 'bittorrent' ? 'c1f0a4d9e7b23a56' : null,
    bittorrent:
      scenario.kind === 'bittorrent'
        ? {
            announceList: [['udp://tracker.opentrackr.org:1337/announce']],
            comment: 'AriaDM demo',
            creationDate: now,
            mode: 'multi'
          }
        : null,
    category: categoryFor(scenario.name),
    tags: [],
    addedAt: now - (index + 1) * 640_000,
    completedAt: scenario.status === 'complete' ? now - 300_000 : null,
    source: index % 3 === 0 ? ('clipboard' as const) : ('manual' as const),
    queuePosition: scenario.status === 'waiting' ? 0 : -1,
    maxDownloadLimit: 0,
    split: 16,
    maxConnectionPerServer: 16,
    referer: '',
    userAgent: 'Mozilla/5.0',
    postActionState: scenario.status === 'complete' ? ('done' as const) : ('idle' as const),
    postActionError: '',
    notified: scenario.status === 'complete',
    mediaFormat: scenario.kind === 'media' ? '2160p · mp4' : null,
    metadataPending: false
  }))
}

const items = buildItems()

function toHistoryRow(item: DownloadItem): HistoryRow {
  return {
    gid: item.gid,
    name: item.name,
    dir: item.dir,
    category: item.category,
    tags: item.tags,
    kind: item.kind,
    engine: item.engine,
    uris: item.files.flatMap((file) => file.uris.map((uri) => uri.uri)),
    totalLength: item.totalLength,
    addedAt: item.addedAt,
    completedAt: item.completedAt,
    source: item.source,
    status: item.status,
    mediaFormat: item.mediaFormat,
    errorCode: item.errorCode,
    errorMessage: item.errorMessage,
    postActionState: item.postActionState,
    notified: item.notified
  }
}

let settings: Settings = {
  downloadDir: 'C:\\Users\\WOW\\Downloads\\AriaDM',
  connectionsPreset: 'standard',
  split: 8,
  maxConnectionPerServer: 8,
  minSplitSize: 4 * 1024 * 1024,
  maxConcurrentDownloads: 5,
  globalDownloadLimit: 0,
  globalUploadLimit: 0,
  theme: 'dark',
  language: 'system',
  accent: 'violet',
  customAccent: '',
  backgroundImage: '',
  backgroundBlur: 0,
  backgroundDim: 40,
  backgroundOpacity: 88,
  backgroundZoom: 100,
  backgroundPositionX: 50,
  backgroundPositionY: 50,
  density: 'comfortable',
  closeToTray: true,
  startMinimised: false,
  notifyOnComplete: true,
  notifyOnError: true,
  soundOnComplete: false,
  clipboardWatch: true,
  clipboardAutoAdd: false,
  handoffEnabled: true,
  handoffPort: 7069,
  handoffToken: 'demo-token-4f2a91c7',
  showCatchPopup: true,
  ytdlpEnabled: true,
  mediaCookiesFromBrowser: 'auto',
  mediaExtensionCookies: true,
  mediaConcurrentFragments: 5,
  mediaHttpChunkSize: 0,
  ytdlpDetectSites: true,
  ffmpegPath: '',
  aria2Path: "C:\\AriaDM\\resources\\bin\\aria2c.exe",
  aria2RpcPort: 6800,
  disableIpv6: 'auto',
  autoSaveInterval: 30,
  maxTries: 5,
  retryWait: 5,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
  proxy: '',
  seedRatio: 1,
  seedTime: 0,
  btTrackers: [],
  btRequireEncryption: false,
  btMinCryptoLevel: 'plain',
  btListenPort: 0,
  btDht: true,
  btDht6: false,
  btPex: true,
  btLpd: true,
  btMaxPeers: 0,
  btDetachSeedOnly: false,
  btStopTimeout: 0,
  btPeerIdPrefix: '',
  btPeerAgent: '',
  useSystemTray: true,
  confirmOnExit: false,
  activeProfileId: null,
  profiles: [
    { id: 'standard', name: '標準', maxOverallDownloadLimit: 0, maxOverallUploadLimit: 0, maxConcurrentDownloads: 5, split: 8, maxConnectionPerServer: 8, minSplitSize: 4 * 1024 * 1024 },
    { id: 'turbo', name: '極速', maxOverallDownloadLimit: 0, maxOverallUploadLimit: 0, maxConcurrentDownloads: 8, split: 16, maxConnectionPerServer: 16, minSplitSize: 1024 * 1024 },
    { id: 'work', name: '上班時段限速', maxOverallDownloadLimit: 524288, maxOverallUploadLimit: 65536, maxConcurrentDownloads: 3, split: 4, maxConnectionPerServer: 4, minSplitSize: 8 * 1024 * 1024 }
  ],
  schedules: [
    {
      id: 'night',
      name: '夜間全速',
      enabled: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '01:00',
      end: '07:30',
      action: 'applyProfile',
      profileId: 'turbo',
      shutdownOnFinish: false
    }
  ],
  categories: DEFAULT_CATEGORIES,
  postAction: { openFile: false, showInFolder: true, notify: true, command: '' },
  hiddenCategories: [],
  window: { width: 1280, height: 800, x: null, y: null, maximised: false }
}

const series: { at: number; download: number; upload: number }[] = []
for (let index = 0; index < 120; index += 1) {
  const wave = Math.sin(index / 7) * 2_400_000 + Math.sin(index / 3.3) * 900_000
  series.push({ at: now - (120 - index) * 1000, download: Math.max(0, 9_400_000 + wave), upload: 260_000 })
}

const global: GlobalStat = {
  downloadSpeed: 18_560_000,
  uploadSpeed: 218_000,
  numActive: 3,
  numWaiting: 1,
  numStopped: 4,
  numStoppedTotal: 4
}

function tick(): TickPayload {
  // Advance one sample so the graph and the rows visibly animate in the browser.
  const wave = Math.sin(Date.now() / 2400) * 2_600_000
  series.push({ at: Date.now(), download: Math.max(0, 9_400_000 + wave), upload: 260_000 })
  if (series.length > 120) series.shift()

  return {
    items,
    // The mock has no previous tick to diff against, so every payload it sends
    // is the whole list — which is what `full` means.
    removedGids: [],
    full: true,
    global,
    engine: {
      state: 'ready',
      pid: 4242,
      port: 6800,
      version: '1.37.0',
      message: '',
      restarts: 0,
      lastError: '',
      logTail: '',
      startedAt: now
    },
    at: Date.now(),
    speedSeries: series
  }
}

const listeners = new Set<(payload: TickPayload) => void>()
const updateListeners = new Set<(progress: UpdateProgress) => void>()

/**
 * Walk a fake download from 0 to 100% so the updater's progress bar can be
 * reviewed in the browser. The real download streams a much larger file at
 * whatever speed the network allows.
 */
async function mockUpdateDownload(): Promise<UpdateProgress> {
  const total = 197_000_000
  const steps = 30
  for (let step = 0; step <= steps; step += 1) {
    const received = Math.round((total * step) / steps)
    const progress: UpdateProgress = {
      phase: step === steps ? 'ready' : 'downloading',
      received,
      total,
      percent: Math.round((step / steps) * 100),
      error: ''
    }
    for (const listener of updateListeners) listener(progress)
    await new Promise((resolve) => window.setTimeout(resolve, 55))
  }
  return { phase: 'ready', received: total, total, percent: 100, error: '' }
}
window.setInterval(() => {
  const payload = tick()
  for (const listener of listeners) listener(payload)
}, 1000)

const handoff: HandoffInfo = {
  enabled: settings.handoffEnabled,
  port: settings.handoffPort,
  token: settings.handoffToken,
  url: `http://127.0.0.1:${settings.handoffPort}/add`,
  running: true,
  retrying: false,
  lastError: '',
  discoveryPort: 7071,
  discoveryPorts: [7070, 7071, 7072, 7073, 7074]
}

// Mutable so the preview can walk the "yt-dlp is missing → install → media band"
// path the real app goes through.
let toolkit: ToolkitStatus = {
  aria2: { name: 'aria2', path: settings.aria2Path, version: '1.37.0', present: true, source: 'bundled', expectedVersion: '1.37.0', integrityError: '' },
  ytdlp: { name: 'yt-dlp', path: '', version: '', present: false, source: 'missing', expectedVersion: '最新版', integrityError: '' },
  ffmpeg: { name: 'ffmpeg', path: '', version: '', present: false, source: 'missing', expectedVersion: '最新版', integrityError: '' }
}

const noop = async (): Promise<void> => {}

/**
 * A stand-in wallpaper for the browser-only preview.
 *
 * In the app the main process reads whatever picture the user picked and hands
 * the renderer a data URL. Here the "file" is an inline gradient, so the
 * appearance controls can be reviewed — and screenshotted — without an Electron
 * window.
 */
const MOCK_WALLPAPER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0%" stop-color="#1b1035"/>' +
      '<stop offset="45%" stop-color="#4b1d6b"/>' +
      '<stop offset="100%" stop-color="#0b2a4a"/>' +
      '</linearGradient></defs>' +
      '<rect width="1600" height="900" fill="url(#g)"/>' +
      '<circle cx="1240" cy="180" r="240" fill="#7c5cff" opacity="0.35"/>' +
      '<circle cx="260" cy="720" r="300" fill="#06b6d4" opacity="0.22"/>' +
      '</svg>'
  )

export function createMockApi(): AriaDmApi {
  return {
    platform: 'win32',
    version: '0.1.0-mock',
    runtime: { electron: '0.0.0-mock', chromium: '0.0.0-mock' },

    engine: {
      getStatus: async () => tick().engine,
      restart: async () => tick().engine,
      getVersion: async () => '1.37.0',
      getGlobalStat: async () => global,
      getLogTail: async () => '[demo] aria2 引擎以模擬模式執行',
      openLog: noop,
      setGlobalLimits: async (limits) => {
        if (limits.download !== undefined) settings = { ...settings, globalDownloadLimit: limits.download }
        return global
      }
    },

    downloads: {
      list: async () => items,
      add: async (input) => {
        const uri = input.uris[0] ?? 'https://example.net/file.bin'
        items.unshift({
          ...items[0]!,
          gid: `mock-${Date.now()}`,
          name: input.out || fileNameFromUri(uri),
          status: input.paused ? 'waiting' : 'active',
          completedLength: 0,
          downloadSpeed: input.paused ? 0 : 3_000_000,
          addedAt: Date.now()
        })
        return { gids: [`mock-${Date.now()}`], duplicates: [], warnings: [] }
      },
      pause: noop,
      resume: noop,
      remove: async (gids) => {
        for (const gid of gids) {
          const index = items.findIndex((entry) => entry.gid === gid)
          if (index >= 0) items.splice(index, 1)
        }
      },
      move: noop,
      changeOptions: noop,
      retry: async () => ({ gids: [], duplicates: [], warnings: [] }),
      openFile: noop,
      showInFolder: noop,
      copyLink: noop,
      getFiles: async (gid) => items.find((entry) => entry.gid === gid)?.files ?? [],
      getServers: async () => [
        { index: 1, currentUri: 'https://mirror-a.example.net/ubuntu.iso', downloadSpeed: 6_200_000, uri: 'https://mirror-a.example.net/ubuntu.iso' },
        { index: 2, currentUri: 'https://mirror-b.example.net/ubuntu.iso', downloadSpeed: 5_600_000, uri: 'https://mirror-b.example.net/ubuntu.iso' }
      ],
      // Derived from the row's own progress so the browser preview exercises the
      // real component instead of showing an empty state.
      getPieces: async (gid) => {
        const entry = items.find((candidate) => candidate.gid === gid)
        if (!entry || entry.totalLength === 0) return null

        const pieceLength = Math.max(1024, Math.floor(entry.totalLength / 96))
        const numPieces = Math.ceil(entry.totalLength / pieceLength)
        const fraction = Math.min(1, entry.completedLength / entry.totalLength)
        const done = Math.round(numPieces * fraction)
        const pieces = Array.from({ length: numPieces }, (_, index) => index < done)

        let bitfield = ''
        for (let index = 0; index < numPieces; index += 4) {
          let nibble = 0
          for (let bit = 0; bit < 4; bit += 1) {
            nibble = (nibble << 1) | (pieces[index + bit] ? 1 : 0)
          }
          bitfield += nibble.toString(16)
        }

        return { numPieces, pieceLength, completedPieces: done, pieces, bitfield }
      },
      getPeers: async () => [
        { peerId: '-qB1234-aBcDeFgHiJkL', ip: '203.0.113.42', port: 51413, bitfield: 'ffff', amChoking: false, peerChoking: false, downloadSpeed: 820_000, uploadSpeed: 42_000, seeder: true },
        { peerId: '-qB5678-ZyXwVuTsRqPo', ip: '198.51.100.7', port: 6881, bitfield: 'f0f0', amChoking: false, peerChoking: true, downloadSpeed: 320_000, uploadSpeed: 0, seeder: false }
      ],
      getOptions: async () => ({ split: '16', 'max-connection-per-server': '16', dir: settings.downloadDir }),
      clearCompleted: async () => {
        for (let index = items.length - 1; index >= 0; index -= 1) {
          if (items[index]!.status === 'complete') items.splice(index, 1)
        }
      },
      pauseAll: noop,
      resumeAll: noop,
      // The same two shared functions the main process uses, so the preview's
      // "N downloads will be created" line tells the truth — a stub that always
      // answered "0" made a working add look like a dead button.
      parseUriList: async (text) =>
        classifyUriList(parseUriList(text).filter((uri) => isSupportedUri(uri))),
      runPostAction: noop
    },

    history: {
      query: async (query) => {
        const rows = items
          .filter((entry) => query.status === 'all' || entry.status === query.status)
          .map(toHistoryRow)
        return { total: rows.length, rows: rows.slice(0, query.limit) }
      },
      delete: noop,
      clear: noop
    },

    settings: {
      get: async () => settings,
      patch: async (patch) => {
        settings = { ...settings, ...patch } as Settings
        return settings
      },
      saveProfile: async (profile: SpeedProfile) => {
        settings = {
          ...settings,
          profiles: [...settings.profiles.filter((entry) => entry.id !== profile.id), profile]
        }
        return settings
      },
      deleteProfile: async (id) => {
        settings = { ...settings, profiles: settings.profiles.filter((entry) => entry.id !== id) }
        return settings
      },
      saveSchedule: async () => settings,
      deleteSchedule: async (id) => {
        settings = { ...settings, schedules: settings.schedules.filter((entry) => entry.id !== id) }
        return settings
      },
      saveCategory: async (rule: CategoryRule) => {
        settings = {
          ...settings,
          categories: [...settings.categories.filter((entry) => entry.id !== rule.id), rule]
        }
        return settings
      },
      deleteCategory: async (id) => {
        settings = { ...settings, categories: settings.categories.filter((entry) => entry.id !== id) }
        return settings
      },
      applyProfile: async (id) => {
        settings = { ...settings, activeProfileId: id }
        return settings
      },
      getPaths: async () => ({
        userData: 'C:\\Users\\WOW\\AppData\\Roaming\\ariadm',
        downloads: settings.downloadDir,
        logs: 'C:\\Users\\WOW\\AppData\\Roaming\\ariadm\\logs',
        bin: 'C:\\Users\\WOW\\AppData\\Roaming\\ariadm\\bin',
        session: 'C:\\Users\\WOW\\AppData\\Roaming\\ariadm\\session.aria2',
        aria2Log: 'C:\\Users\\WOW\\AppData\\Roaming\\ariadm\\logs\\aria2.log',
        appLog: 'C:\\Users\\WOW\\AppData\\Roaming\\ariadm\\logs\\ariadm.log',
        history: 'C:\\Users\\WOW\\AppData\\Roaming\\ariadm\\history.json',
        settings: 'C:\\Users\\WOW\\AppData\\Roaming\\ariadm\\settings.json',
        extensions: 'C:\\Users\\WOW\\AppData\\Roaming\\ariadm\\extensions',
        updateLog: 'C:\\Users\\WOW\\AppData\\Roaming\\ariadm\\update.log'
      }),
      chooseDirectory: async () => 'C:\\Users\\WOW\\Downloads\\Chosen',
      chooseImage: async () => 'C:\\Users\\WOW\\Pictures\\wallpaper.svg',
      readImage: async () => MOCK_WALLPAPER
    },

    integrations: {
      setClipboardWatch: noop,
      getHandoffInfo: async () => handoff,
      rotateHandoffToken: async () => ({ ...handoff, token: 'rotated-demo-token' }),
      // Deliberately delayed so the dialog's debounced probe, its spinner and
      // the quality picker's populated state can all be watched in the preview.
      getMediaFormats: async (url) => {
        await new Promise((resolve) => window.setTimeout(resolve, 700))
        if (!toolkit.ytdlp.present) throw new Error('尚未安裝 yt-dlp')
        // The real strings, wrapper and all, so the dialog's translation of them
        // can be exercised here: `x.com` reproduces what the user actually saw.
        if (url.includes('gone') || url.includes('x.com')) {
          throw new Error(
            "Error invoking remote method 'integrations:getMediaFormats': Error: ERROR: [twitter] 2104816801968509100: Video #1 is unavailable"
          )
        }
        if (url.includes('botcheck')) {
          throw new Error("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot")
        }
        if (url.includes('broken')) {
          throw new Error('ERROR: [youtube] dQw4w9WgXcQ: Unable to extract player response')
        }
        return {
          formats: [
            { formatId: 'bestvideo+bestaudio/best', label: '最佳畫質（自動合併音訊）', ext: 'mp4', resolution: '2160p', filesize: null, vcodec: 'auto', acodec: 'auto', note: '需要 ffmpeg 才能合併', needsFfmpeg: true },
            { formatId: '137', label: '2160p · mp4', ext: 'mp4', resolution: '2160p', filesize: 1_820_000_000, vcodec: 'avc1', acodec: 'none', note: '2160p', needsFfmpeg: true },
            { formatId: '22', label: '720p · mp4', ext: 'mp4', resolution: '720p', filesize: 214_000_000, vcodec: 'avc1', acodec: 'mp4a', note: '720p', needsFfmpeg: false },
            { formatId: '140', label: '純音訊 · m4a · 128kbps', ext: 'm4a', resolution: 'audio', filesize: 48_000_000, vcodec: 'none', acodec: 'mp4a', note: 'medium', needsFfmpeg: false }
          ],
          subtitles: [
            { code: 'zh-Hant', auto: false },
            { code: 'zh-Hans', auto: true },
            { code: 'en', auto: true },
            { code: 'ja', auto: false }
          ],
          isPlaylist: url.includes('playlist') || url.includes('list=')
        }
      },
      detectMedia: async (url) => {
        await new Promise((resolve) => window.setTimeout(resolve, 250))
        const site = matchMediaSite(url)
        if (site !== null) return { media: true, site, mediaUrls: [] }
        // The harness has no real page fetch, so an unknown host is guessed from
        // its path: enough to exercise the "unknown host video page" flow. A path
        // that names a media file exercises the page-with-direct-media flow.
        if (/direct|\.mp4/i.test(url)) {
          return {
            media: true,
            site: null,
            mediaUrls: ['https://cdn.example.test/media/clip-2160p.mp4']
          }
        }
        const media = /\.(?:html?|php)(?:[?#]|$)/i.test(url) || /\/(?:video|gif|watch)\//i.test(url)
        return { media, site: null, mediaUrls: [] }
      },
      getMediaPlaylist: async (url) => {
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        if (!url) throw new Error('缺少連結。')
        return {
          title: '示範播放清單',
          entries: Array.from({ length: 8 }, (_, index) => ({
            id: String(index + 1),
            title: `第 ${index + 1} 集：示範項目`,
            durationSeconds: 180 + index * 37,
            url: `${url}&index=${index + 1}`,
            thumbnail: ''
          }))
        }
      },
      addMedia: async () => ({ gids: ['ytdlp:mock'] }),
      checkToolkits: async () => toolkit,
      downloadToolkit: async (kind) => {
        await new Promise((resolve) => window.setTimeout(resolve, 600))
        if (kind === 'ytdlp') {
          toolkit = {
            ...toolkit,
            ytdlp: {
              ...toolkit.ytdlp,
              path: 'C:\\Users\\WOW\\AppData\\Roaming\\ariadm\\bin\\yt-dlp.exe',
              version: '2026.09.01',
              present: true,
              source: 'userData'
            }
          }
        }
        return toolkit
      },
      openExtensionFolder: noop,
      systemPower: noop,
      dismissDetected: noop
    },

    app: {
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener')
      },
      reveal: async () => {}
    },

    update: {
      // Reports an update so the whole download-and-install flow can be exercised
      // in the browser-only dev server, where there is no installer to run.
      check: async () => ({
        current: '0.1.0-mock',
        latest: '9.9.9-mock',
        available: true,
        releaseUrl: 'https://github.com/alex200376/AriaDM/releases',
        downloadUrl: 'https://example.test/AriaDM-9.9.9-setup.exe',
        downloadSize: 197_000_000,
        // A digest no real file will match: the mock stands in for a release
        // whose check code the downloader would compare against.
        downloadSha256: '0'.repeat(64),
        canInstall: true,
        installKind: 'dev' as const,
        needsElevation: false,
        pendingInstaller: null,
        error: ''
      }),
      download: mockUpdateDownload,
      install: async () => {},
      cancel: async () => {},
      openInstaller: async () => {},
      diagnostics: async () => ({
        text: 'AriaDM 0.1.0-mock\nplatform: mock\ninstall kind: dev',
        logPath: '/mock/update.log'
      }),
      repair: async () => ({ checked: 0, removed: 0, kept: 0, bytesFreed: 0 })
    },

    // The browser has no window for the app to control: the buttons are there so
    // the merged caption row can be reviewed, and they do nothing.
    window: {
      minimise: noop,
      toggleMaximise: noop,
      close: noop,
      isMaximised: async () => false
    },

    catcher: {
      // In the browser-only dev server there is no popup window and no capture
      // behind it. Returning a preview capture lets the popup's own document be
      // reviewed by opening /catcher.html directly.
      get: async () => ({
        gids: ['mock-capture'],
        title: 'ubuntu-24.04.1-desktop-amd64.iso',
        host: 'mirror.example.net',
        count: 1,
        locale: 'zh-TW' as const,
        theme: 'dark' as const,
        accent: 'violet',
        customAccent: ''
      }),
      resolve: async () => {}
    },

    on: {
      tick: (handler) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      engineStatus: () => () => {},
      clipboardDetected: () => () => {},
      toast: () => () => {},
      navigate: () => () => {},
      catcherUpdate: () => () => {},
      windowState: () => () => {},
      updateProgress: (handler) => {
        updateListeners.add(handler)
        return () => updateListeners.delete(handler)
      }
    }
  }
}

/** True when the app is running in a browser without the Electron bridge. */
export function needsMockBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.api === 'undefined'
}
