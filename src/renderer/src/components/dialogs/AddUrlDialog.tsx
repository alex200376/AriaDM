import { Captions, FileUp, FolderOpen, Link2, Loader2, Settings2, Sparkles, Wrench } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { formatBytes } from '@shared/format'
import { classifyMediaError, type MediaErrorAction, type MediaErrorInfo } from '@shared/media-errors'
import {
  defaultFormatId,
  provisionalFormatId,
  provisionalFormatOption
} from '@shared/media-formats'
import { matchMediaSite, needsPageSniff, splitByMediaSite } from '@shared/media-sites'
import type {
  AddDownloadInput,
  AudioFormat,
  MediaFormatInfo,
  MediaPlaylistEntry,
  SubtitleTrack
} from '@shared/settings'
import { CONNECTION_PRESETS, type ConnectionsPreset } from '@shared/settings'
import { fileNameFromUri, isListFileName, parseUriList } from '@shared/uri'

import { useApp } from '../../store/app-store'
import { cn } from '../../lib/cn'
import { useT } from '../../lib/i18n'
import { Badge, Button, Field, Input, Modal, Row, SelectField, TextArea, Toggle } from '../ui/primitives'
import { PlaylistPicker } from './PlaylistPicker'

/**
 * Base64-encode bytes without blowing the call stack.
 *
 * A torrent file is small, but `String.fromCharCode(...bytes)` on a large array
 * would overflow, so the chunks are joined incrementally.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

/**
 * Radix rejects an empty string as an item value, so the "automatic" category
 * round-trips through this sentinel and is mapped back to `''` on change.
 */
const AUTO_CATEGORY = '__auto__'

/** How long the pasted URL must sit still before a format probe is launched. */
const PROBE_DEBOUNCE_MS = 450

/** One row of the quality picker, built from a probed format. */
function formatOptionLabel(format: MediaFormatInfo): string {
  const size = format.filesize ? ` · ${formatBytes(format.filesize)}` : ''
  return `${format.label}${size}`
}

export function AddUrlDialog(): JSX.Element | null {
  const dialog = useApp((state) => state.dialog)
  const seed = useApp((state) => state.dialogSeed)
  const settings = useApp((state) => state.settings)
  const toolkits = useApp((state) => state.toolkits)
  const closeDialog = useApp((state) => state.closeDialog)
  const addDownload = useApp((state) => state.addDownload)
  const pushToast = useApp((state) => state.pushToast)
  const runAction = useApp((state) => state.runAction)
  const refreshToolkits = useApp((state) => state.refreshToolkits)
  const patchSettings = useApp((state) => state.patchSettings)
  const t = useT()

  const [text, setText] = useState('')
  const [torrent, setTorrent] = useState<{ name: string; base64: string } | null>(null)
  const [metalink, setMetalink] = useState<{ name: string; base64: string } | null>(null)
  const [out, setOut] = useState('')
  const [dir, setDir] = useState('')
  const [category, setCategory] = useState('')
  const [preset, setPreset] = useState<ConnectionsPreset>('standard')
  const [paused, setPaused] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [referer, setReferer] = useState('')
  const [userAgent, setUserAgent] = useState('')
  const [cookies, setCookies] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [proxy, setProxy] = useState('')
  const [headers, setHeaders] = useState('')
  const [maxLimit, setMaxLimit] = useState('')
  const [dropActive, setDropActive] = useState(false)
  const [classification, setClassification] = useState<{ mirrors: string[][]; singles: string[] }>({
    mirrors: [],
    singles: []
  })

  // --- media (yt-dlp) state -------------------------------------------------
  const [formats, setFormats] = useState<MediaFormatInfo[] | null>(null)
  const [formatId, setFormatId] = useState('')
  const [probing, setProbing] = useState(false)
  const [mediaError, setMediaError] = useState<MediaErrorInfo | null>(null)
  const [audioOnly, setAudioOnly] = useState(false)
  const [playlist, setPlaylist] = useState(false)
  const [audioFormat, setAudioFormat] = useState<AudioFormat>('native')
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([])
  const [subtitleLangs, setSubtitleLangs] = useState<string[]>([])
  const [embedSubtitles, setEmbedSubtitles] = useState(false)
  const [isPlaylist, setIsPlaylist] = useState(false)
  /** Items the user ticked in the playlist picker, as 1-based positions. */
  const [selectedItems, setSelectedItems] = useState<number[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [playlistLoading, setPlaylistLoading] = useState(false)
  const [playlistTitle, setPlaylistTitle] = useState('')
  const [playlistEntries, setPlaylistEntries] = useState<MediaPlaylistEntry[]>([])
  /** The user asked for a plain aria2 download even though the site is known. */
  const [forceAria2, setForceAria2] = useState(false)
  const [installing, setInstalling] = useState<string>('')
  /** Bumped to re-run the probe after an action (a fix, or 重新偵測). */
  const [probeNonce, setProbeNonce] = useState(0)
  /** Installing yt-dlp is automatic, but only tried once per URL. */
  const autoInstallTried = useRef(false)
  /**
   * Whether the user has chosen a format themselves.
   *
   * The probe runs after the picker is already usable, so a choice made while it
   * is still in flight must not be overwritten by the answer when it arrives.
   */
  const formatTouched = useRef(false)
  /** A page sniff found a video on a host the curated list does not know. */
  const [sniffedMedia, setSniffedMedia] = useState(false)
  /**
   * Media files a sniffed page points at (`.mp4` and friends).
   *
   * These are the download themselves: a page that embeds a plain video file is
   * served better by fetching that file than by handing the page to yt-dlp to
   * find the same address again, and unlike a page they can be split across
   * connections.
   */
  const [pageMedia, setPageMedia] = useState<string[]>([])
  /** Seconds the in-flight probe has been running, so the wait has a visible size. */
  const [probeElapsed, setProbeElapsed] = useState(0)
  /**
   * The user chose to stop watching this probe.
   *
   * It only stops the *waiting*: the request is already in flight and its answer
   * is still applied when it lands (and is remembered for the download that
   * follows), so stopping costs nothing and cannot leave a stale menu behind.
   */
  const [probeStopped, setProbeStopped] = useState(false)
  /**
   * Set by a fix-it action, so the next probe re-tries the credentials it has
   * just changed instead of skipping them as a failure it already remembers.
   */
  const refreshCredentials = useRef(false)

  const open = dialog === 'add'

  useEffect(() => {
    if (!open) return
    setText(seed)
    setTorrent(null)
    setMetalink(null)
    setOut('')
    setDir(settings?.downloadDir ?? '')
    setCategory('')
    setPreset(settings?.connectionsPreset === 'custom' ? 'standard' : (settings?.connectionsPreset ?? 'standard'))
    setPaused(false)
    setAdvanced(false)
    setFormats(null)
    setFormatId('')
    setMediaError(null)
    setAudioOnly(false)
    setPlaylist(false)
    setAudioFormat('native')
    setSubtitleTracks([])
    setSubtitleLangs([])
    setEmbedSubtitles(false)
    setIsPlaylist(false)
    setSelectedItems([])
    setPickerOpen(false)
    setPlaylistEntries([])
    setPlaylistTitle('')
    setForceAria2(false)
    setInstalling('')
    setSniffedMedia(false)
    setPageMedia([])
    autoInstallTried.current = false
    setProbeStopped(false)
    setProbeElapsed(0)
    refreshCredentials.current = false
  }, [open, seed, settings?.downloadDir, settings?.connectionsPreset])

  const uris = useMemo(() => parseUriList(text), [text])
  // A paste can hold video pages and plain files at once, and the two need
  // different engines. Splitting them is what keeps the video links out of the
  // aria2 path without dropping the rest of the list.
  const mediaSplit = useMemo(() => splitByMediaSite(uris), [uris])
  /** A single video page gets the full "recognised site" panel; a list of them
      gets the same panel with a count instead of a site name. */
  const mediaSite = uris.length === 1 ? matchMediaSite(uris[0]!) : null
  const batchMedia = uris.length > 1 && mediaSplit.media.length > 0
  /**
   * A single link on a host the curated list does not know.
   *
   * This is the only case the page sniffer is asked about: the list already
   * settled a known site, and a URL that names a file is never a page.
   */
  const sniffTarget = useMemo(
    () => (uris.length === 1 && mediaSite === null ? uris[0]! : ''),
    [uris, mediaSite]
  )
  const hasYtDlp = toolkits?.ytdlp.present ?? false
  const hasFfmpeg = toolkits?.ffmpeg.present ?? false

  // Read an unknown host's page to see whether it holds a video. The main
  // process owns the fetch; every in-flight answer is dropped once the link
  // changes, exactly like the format probe below.
  useEffect(() => {
    if (!open || sniffTarget === '' || !needsPageSniff(sniffTarget)) {
      setSniffedMedia(false)
      setPageMedia([])
      return
    }
    let cancelled = false
    setSniffedMedia(false)
    setPageMedia([])
    void window.api.integrations
      .detectMedia(sniffTarget)
      .then((result) => {
        if (cancelled) return
        // Files the page points at win over handing the page to yt-dlp, so the
        // media panel (and its quality picker) stays out of the way for them.
        const files = result.mediaUrls ?? []
        setPageMedia(files)
        setSniffedMedia(files.length === 0 && result.media)
      })
      .catch(() => {
        if (cancelled) return
        setSniffedMedia(false)
        setPageMedia([])
      })
    return () => {
      cancelled = true
    }
  }, [open, sniffTarget])

  /**
   * Fetch a helper tool.
   *
   * Neither yt-dlp nor ffmpeg ships with the app, and a missing yt-dlp is the
   * most common reason a media link appears to do nothing — so this is called
   * automatically on detection rather than only from a button.
   */
  const installToolkit = useCallback(
    async (kind: 'ytdlp' | 'ffmpeg'): Promise<boolean> => {
      setInstalling(kind)
      try {
        await window.api.integrations.downloadToolkit(kind)
        await refreshToolkits()
        pushToast({
          title: kind === 'ytdlp' ? t('add.engineReady') : t('add.ffmpegReady'),
          body: t('add.engineReadyBody'),
          tone: 'success'
        })
        return true
      } catch (error) {
        pushToast({
          title: t('add.installFailed'),
          body: classifyMediaError((error as Error).message).message,
          tone: 'error'
        })
        return false
      } finally {
        setInstalling('')
      }
    },
    [pushToast, refreshToolkits, t]
  )

  // Autosetup: a recognised media page with no engine gets one, with no detour
  // through the settings. Attempted once per URL so a failure (no network) does
  // not spin.
  useEffect(() => {
    if (!open || (mediaSite === null && !batchMedia && !sniffedMedia) || hasYtDlp || forceAria2 || autoInstallTried.current) return
    autoInstallTried.current = true
    void installToolkit('ytdlp')
  }, [open, mediaSite, batchMedia, sniffedMedia, hasYtDlp, forceAria2, installToolkit])

  // Auto-detection is offered for a video page and for a pasted list that holds
  // any. Anything else stays on the aria2 path, which cannot surprise anyone.
  const mediaMode = (mediaSite !== null || sniffedMedia || batchMedia) && !forceAria2 && !torrent && !metalink
  const useYtDlp = mediaMode && hasYtDlp

  /** The links the chosen format applies to: the page, or every video in it. */
  const mediaTargets = useMemo(() => {
    if (mediaSite !== null) return [uris[0]!]
    if (mediaSplit.media.length > 0) return mediaSplit.media
    return sniffTarget !== '' ? [sniffTarget] : []
  }, [mediaSite, uris, mediaSplit, sniffTarget])

  /**
   * The links aria2 will receive.
   *
   * A paste that goes to yt-dlp is not also queued in aria2 — that would download
   * everything twice. A video link does fall back to aria2 when yt-dlp cannot be
   * used, which is what the "改用一般下載" toggle and the missing-engine warning
   * are about, and what stops a batch from silently losing its video links.
   */
  const aria2Urls = useMemo(() => {
    // Media files found in a page are ordinary files, so they are what aria2
    // receives — not the page that links them.
    if (pageMedia.length > 0) return pageMedia
    // The single video page that goes to yt-dlp is not also queued in aria2 —
    // whether the list recognised it or the page sniff did.
    if (mediaSite !== null || (sniffedMedia && uris.length === 1)) return useYtDlp ? [] : uris
    // In a batch only the non-video links belong to aria2 — unless yt-dlp is
    // unusable, and then the video links fall back to it rather than being
    // dropped on the floor.
    if (useYtDlp || (hasYtDlp && !forceAria2)) return mediaSplit.plain
    return uris
  }, [pageMedia, useYtDlp, mediaSite, hasYtDlp, forceAria2, uris, mediaSplit])
  /** Only the aria2 links are classified; a video page is not a file. */
  const aria2Text = useMemo(() => aria2Urls.join('\n'), [aria2Urls])

  /** The link whose formats the picker shows: the first video in the paste. */
  const probeUrl =
    mediaSite !== null
      ? (uris[0] ?? '')
      : (mediaSplit.media[0] ?? (sniffedMedia ? sniffTarget : ''))
  /** Whether the media panel applies to this paste at all. */
  const showMediaPanel = (mediaSite !== null || sniffedMedia || batchMedia) && !torrent && !metalink

  // Ask the main process to classify, so the mirror/single decision matches
  // exactly what the backend will do when the download is created.
  useEffect(() => {
    if (!open || aria2Text === '') {
      setClassification({ mirrors: [], singles: [] })
      return
    }
    let cancelled = false
    void window.api.downloads
      .parseUriList(aria2Text)
      .then((result) => {
        if (!cancelled) setClassification(result)
      })
      .catch(() => {
        if (!cancelled) setClassification({ mirrors: [], singles: aria2Urls })
      })
    return () => {
      cancelled = true
    }
  }, [open, aria2Text])

  // Probe formats as soon as a recognised page settles, so the quality picker is
  // already populated by the time the user looks at it. The probe is debounced
  // while typing and every in-flight result is dropped once the URL changes.
  //
  // The picker does not wait for the answer: a default format is named up front
  // (see `provisionalFormatId`), so the common "just download it in the best
  // quality" action starts immediately and the probe only fills in the specific
  // tiers underneath. On a YouTube page the probe is a few seconds of yt-dlp
  // boot and network work that the user no longer has to sit through.
  useEffect(() => {
    if (!open || !useYtDlp || probeUrl === '') {
      setFormats(null)
      setFormatId('')
      setMediaError(null)
      setSubtitleTracks([])
      setSubtitleLangs([])
      setIsPlaylist(false)
      setProbing(false)
      formatTouched.current = false
      return
    }

    let cancelled = false
    setProbing(true)
    setProbeStopped(false)
    setMediaError(null)
    setFormats(null)
    // A fresh link starts from a fresh default, so a choice made for the previous
    // one cannot leak in, and the answer below is then free to refine it.
    formatTouched.current = false
    setFormatId(provisionalFormatId(hasFfmpeg, audioOnly))

    const timer = window.setTimeout(() => {
      // Read and clear: a retry after a fix applies to the run it triggered and
      // must not leak into the next link's probe.
      const refresh = refreshCredentials.current
      refreshCredentials.current = false
      void window.api.integrations
        .getMediaFormats(probeUrl, refresh)
        .then((result) => {
          if (cancelled) return
          setFormats(result.formats)
          setSubtitleTracks(result.subtitles)
          setSubtitleLangs([])
          setIsPlaylist(result.isPlaylist)
          if (result.formats.length === 0) {
            // Nothing was found to download, so the provisional default is a lie:
            // clear it and let the error below take the form over.
            setFormatId('')
            setMediaError({
              kind: 'unknown',
              message: t('add.noFormats'),
              action: 'retry',
              actionLabel: t('add.retryProbe')
            })
          } else if (!formatTouched.current) {
            // The best entry is only usable with ffmpeg; without it the picker
            // opens on the best single-file format instead of on a download that
            // is going to fail. Skipped when the user has already chosen, so the
            // wait they skipped past does not undo what they picked.
            setFormatId(defaultFormatId(result.formats, hasFfmpeg))
          }
        })
        .catch((error: Error) => {
          if (cancelled) return
          /*
           * The provisional default is deliberately kept. Clearing it disabled
           * the primary button, so a link whose probe failed — a stalled
           * extraction, a site that refuses to answer — could not be downloaded
           * at all, not even at the best quality the user came for. The error
           * banner explains what happened and offers the fix, and the download
           * stays available so a failed probe is a warning rather than a dead end.
           */
          setMediaError(
            classifyMediaError(error.message, { ytdlpVersion: toolkits?.ytdlp.version ?? '' })
          )
        })
        .finally(() => {
          if (!cancelled) {
            setProbing(false)
            // The answer is in, so a stopped wait is over and the normal
            // "formats are ready" text takes the line back.
            setProbeStopped(false)
          }
        })
    }, PROBE_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, useYtDlp, probeUrl, probeNonce, hasFfmpeg, toolkits?.ytdlp.version])

  /**
   * Tick while a probe is in flight, so a probe that is taking its time says so
   * instead of looking like a hang.
   */
  useEffect(() => {
    if (!probing) {
      setProbeElapsed(0)
      return
    }
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setProbeElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    return () => window.clearInterval(timer)
  }, [probing])

  /**
   * The rows the format picker offers.
   *
   * The probe's own list once it answers; until then a single provisional row,
   * so the download can be started without waiting for it (see the effect above).
   */
  const choiceList = useMemo(
    () => (formats && formats.length > 0 ? formats : [provisionalFormatOption(hasFfmpeg, audioOnly)]),
    [formats, hasFfmpeg, audioOnly]
  )

  if (!open) return null

  const isTorrent = torrent !== null || uris.some((uri) => uri.startsWith('magnet:'))
  const downloadCount = classification.mirrors.length + classification.singles.length
  const mirrorCount = classification.mirrors.length
  const canSubmit =
    torrent !== null || metalink !== null ? true : useYtDlp ? formatId !== '' : uris.length > 0

  /**
   * Whether the quality panel has something usable to show.
   *
   * True while the probe is running (the provisional default) and once it has
   * answered, false when it failed or found nothing — the error message owns the
   * form in those cases.
   */
  const showFormatPanel =
    useYtDlp && formatId !== '' && (formats === null || formats.length > 0)

  const chosenFormat = choiceList.find((format) => format.formatId === formatId) ?? null
  // A merged stream and an mp3 conversion both need ffmpeg; a plain progressive
  // format does not, which is exactly the trade-off the hint explains.
  const needsFfmpeg = chosenFormat?.needsFfmpeg ?? false

  /** Append dropped text to the box, keeping whatever is already typed there. */
  const appendText = (addition: string): void => {
    setText((previous) => (previous ? `${previous}\n${addition}` : addition))
  }

  const handleDrop = async (event: React.DragEvent): Promise<void> => {
    event.preventDefault()
    setDropActive(false)
    const files = Array.from(event.dataTransfer.files)

    const torrentFile = files.find((file) => file.name.toLowerCase().endsWith('.torrent'))
    if (torrentFile) {
      const bytes = new Uint8Array(await torrentFile.arrayBuffer())
      setTorrent({ name: torrentFile.name, base64: bytesToBase64(bytes) })
      return
    }

    const metalinkFile = files.find((file) => file.name.toLowerCase().endsWith('.metalink'))
    if (metalinkFile) {
      const bytes = new Uint8Array(await metalinkFile.arrayBuffer())
      setMetalink({ name: metalinkFile.name, base64: bytesToBase64(bytes) })
      return
    }

    // A list file is a paste that arrived as a file: `.txt`, or a playlist whose
    // `#EXTINF` directives `parseUriList` drops for us.
    const listFile = files.find((file) => isListFileName(file.name))
    if (listFile) {
      appendText(await listFile.text())
      return
    }

    // Anything else is treated as text; a dragged link is a common gesture.
    const dropped = event.dataTransfer.getData('text')
    if (dropped) appendText(dropped)
  }

  /**
   * Do the thing that fixes the reported failure, then probe again.
   *
   * Every action here answers a specific yt-dlp error (see shared/media-errors),
   * which is the difference between a message that explains itself and one that
   * just reports a failure.
   */
  const fixMediaError = (action: MediaErrorAction): void => {
    // The user is retrying after changing something, so the remembered "these
    // credentials do not work here" verdict must not answer for them.
    refreshCredentials.current = true
    switch (action) {
      case 'enable-cookies':
        void patchSettings({ mediaCookiesFromBrowser: 'auto' }).then(() => setProbeNonce((value) => value + 1))
        break
      case 'install-ffmpeg':
        void installToolkit('ffmpeg').then((ok) => {
          if (ok) setProbeNonce((value) => value + 1)
        })
        break
      case 'update-ytdlp':
        void installToolkit('ytdlp').then((ok) => {
          if (ok) setProbeNonce((value) => value + 1)
        })
        break
      default:
        setProbeNonce((value) => value + 1)
    }
  }

  /**
   * Send every video link in the paste to yt-dlp, all with the chosen format.
   *
   * One link failing must not cancel the others: the reason to paste a list is
   * that the user does not want to babysit it. Failures are collected and
   * reported together, and only a batch where nothing at all was added comes
   * back as an error for the dialog to stay open on.
   */
  const submitMedia = async (): Promise<boolean> => {
    if (!settings || !formatId || mediaTargets.length === 0) return true
    return runAction(t('add.actionQueue'), async () => {
      const gids: string[] = []
      const failures: { url: string; message: string }[] = []
      for (const url of mediaTargets) {
        try {
          const result = await window.api.integrations.addMedia({
            url,
            formatId,
            dir,
            audioOnly,
            playlist: playlist || selectedItems.length > 0,
            maxConcurrent: settings.maxConcurrentDownloads,
            ...(selectedItems.length > 0 ? { playlistItems: selectedItems } : {}),
            ...(subtitleLangs.length > 0
              ? { subtitles: { codes: subtitleLangs, embed: embedSubtitles } }
              : {}),
            ...(audioFormat !== 'native' ? { audioFormat } : {})
          })
          gids.push(...result.gids)
        } catch (error) {
          failures.push({ url, message: (error as Error).message })
        }
      }
      if (gids.length === 0 && failures.length > 0) throw new Error(failures[0]!.message)

      pushToast({
        title: t('add.mediaQueued'),
        body: t('add.mediaQueuedBody', { count: gids.length }),
        tone: 'success'
      })
      if (failures.length > 0) {
        pushToast({
          title: t('add.failedCount', { count: failures.length }),
          body: failures[0]!.message,
          tone: 'error'
        })
      }
    })
  }

  /**
   * Add whatever aria2 should take from this paste.
   *
   * A torrent or metalink is one download; otherwise each mirror group becomes
   * one download with several sources and each unique filename its own.
   */
  /**
   * Open the playlist picker and load the list behind it.
   *
   * The list is fetched on demand rather than at probe time: it is a second
   * yt-dlp run, and most links are a single video that has no playlist to list.
   */
  const openPlaylistPicker = async (): Promise<void> => {
    if (probeUrl === '') return
    setPickerOpen(true)
    setPlaylistLoading(true)
    setPlaylistEntries([])
    try {
      const info = await window.api.integrations.getMediaPlaylist(probeUrl)
      setPlaylistTitle(info.title)
      setPlaylistEntries(info.entries)
    } catch (error) {
      pushToast({
        title: t('add.playlistFailed'),
        body: classifyMediaError((error as Error).message).message,
        tone: 'error'
      })
      setPickerOpen(false)
    } finally {
      setPlaylistLoading(false)
    }
  }

  const addPlainDownloads = async (): Promise<void> => {
    if (!settings) return
    const presetValues = preset === 'custom' ? null : CONNECTION_PRESETS[preset]
    const split = presetValues?.split ?? settings.split
    const maxConnectionPerServer = presetValues?.maxConnectionPerServer ?? settings.maxConnectionPerServer
    const minSplitSize = presetValues?.minSplitSize ?? settings.minSplitSize

    const base: Omit<AddDownloadInput, 'uris'> = {
      out,
      dir,
      split,
      maxConnectionPerServer,
      minSplitSize,
      maxDownloadLimit: maxLimit.trim() === '' ? 0 : Number(maxLimit) * 1024 * 1024,
      referer,
      userAgent,
      cookieHeader: cookies,
      headers: headers
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      username,
      password,
      proxy,
      paused,
      seedRatio: settings.seedRatio,
      seedTime: settings.seedTime,
      selectFileIndices: [],
      category,
      tags: [],
      source: 'manual',
      torrentBase64: null,
      metalinkBase64: null,
      allowDuplicate: false,
      engine: 'auto'
    }

    if (torrent) {
      await addDownload({
        ...base,
        uris: [],
        torrentBase64: torrent.base64,
        out: out || torrent.name.replace(/\.torrent$/i, '')
      })
    } else if (metalink) {
      await addDownload({ ...base, uris: [], metalinkBase64: metalink.base64 })
    } else {
      // Each mirror group becomes one download with several sources; each unique
      // filename becomes its own download.
      for (const group of classification.mirrors) {
        await addDownload({ ...base, uris: group, out: downloadCount === 1 ? out : '' })
      }
      for (const uri of classification.singles) {
        await addDownload({ ...base, uris: [uri], out: downloadCount === 1 ? out : '', category })
      }
    }
  }

  const submit = async (): Promise<void> => {
    if (!settings) return

    if (useYtDlp) {
      const ok = await submitMedia()
      if (!ok) return
      // A paste that mixes video pages and plain files sends both: the videos
      // through yt-dlp, the rest through aria2, in one action.
      if (aria2Urls.length > 0) await addPlainDownloads()
      closeDialog()
      return
    }

    await addPlainDownloads()
    closeDialog()
  }

  const footerNote = torrent
    ? t('add.torrentFooter', { name: torrent.name })
    : metalink
      ? t('add.metalinkFooter', { name: metalink.name })
      : useYtDlp
        ? probing
          ? t('add.footer.probing')
          : formatId
            ? mediaTargets.length > 1
              ? `${t('add.targets', { count: mediaTargets.length })}${
                  aria2Urls.length > 0
                    ? t('add.targetsPlain', { count: aria2Urls.length })
                    : ''
                }`
              : t('add.footer.media')
            : t('add.footer.noFormats')
        : uris.length > 0
          ? `${t('add.footer.count', { count: downloadCount })}${
              mirrorCount > 0 ? t('add.footer.mirrors', { count: mirrorCount }) : ''
            }`
          : t('add.footer.none')

  return (
    <>
    <Modal
      open={open && !pickerOpen}
      title={t('add.title')}
      subtitle={t('add.subtitle')}
      onClose={closeDialog}
      width="max-w-3xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-faint">{footerNote}</span>
          <Button variant="ghost" onClick={closeDialog}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {useYtDlp
              ? mediaTargets.length > 1
                ? t('add.submitCount', { count: mediaTargets.length })
                : t('add.submitMedia')
              : t('add.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDropActive(true)
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(event) => void handleDrop(event)}
          className={cn(
            'rounded-xl border-2 border-dashed p-3 transition-colors',
            dropActive ? 'border-brand bg-brand/10' : 'border-line bg-elevated/30'
          )}
        >
          <div className="mb-2 flex items-center gap-2 text-[11.5px] text-muted">
            <Link2 size={13} />
            <span>{t('add.urisLabel')}</span>
            <div className="flex-1" />
            <span className="flex items-center gap-1 text-faint">
              <FileUp size={12} />
              {t('add.dropHint')}
            </span>
          </div>
          <TextArea
            rows={5}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('add.placeholder')}
            autoFocus
          />
        </div>

        {torrent && (
          <div className="flex items-center justify-between rounded-lg border border-ok/30 bg-ok/10 px-3 py-2">
            <span className="text-[12px] text-fg">
              {t('add.torrentLoaded', { name: torrent.name })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setTorrent(null)}>
              {t('common.remove')}
            </Button>
          </div>
        )}

        {metalink && (
          <div className="flex items-center justify-between rounded-lg border border-info/30 bg-info/10 px-3 py-2">
            <span className="text-[12px] text-fg">
              {t('add.metalinkLoaded', { name: metalink.name })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setMetalink(null)}>
              {t('common.remove')}
            </Button>
          </div>
        )}

        {pageMedia.length > 0 && (
          <div className="rounded-xl border border-brand/30 bg-brand/10 px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles size={14} className="text-brand" />
              <span className="text-[12.5px] font-medium text-fg">
                {t('add.foundFiles', { count: pageMedia.length })}
              </span>
              <Badge tone="brand">{t('add.directBadge')}</Badge>
            </div>
            <ul className="mt-1.5 space-y-0.5">
              {pageMedia.slice(0, 5).map((url) => (
                <li key={url} className="truncate font-mono text-[10.5px] text-muted" title={url}>
                  {url}
                </li>
              ))}
              {pageMedia.length > 5 && (
                <li className="text-[10.5px] text-faint">
                  {t('add.foundFilesMore', { count: pageMedia.length - 5 })}
                </li>
              )}
            </ul>
          </div>
        )}

        {showMediaPanel && (
          <div className="rounded-xl border border-brand/30 bg-brand/10 px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles size={14} className="text-brand" />
              {/* One video page names its site; a batch shows how many it holds,
                  because the format picked below applies to every one of them. */}
              <span className="text-[12.5px] font-medium text-fg">
                {mediaSite !== null
                  ? t('add.mediaDetected')
                  : batchMedia
                    ? t('add.batchDetected', { count: mediaTargets.length })
                    : t('add.autoDetected')}
              </span>
              <Badge tone="brand">
                {mediaSite ?? (batchMedia ? t('add.batchBadge') : t('add.autoBadge'))}
              </Badge>
              {aria2Urls.length > 0 && uris.length > 1 && (
                <Badge tone="muted">{t('add.alsoPlain', { count: aria2Urls.length })}</Badge>
              )}
              {forceAria2 ? (
                <Badge tone="muted">{t('add.plainBadge')}</Badge>
              ) : (
                <Badge tone={hasYtDlp ? 'brand' : 'warn'}>yt-dlp</Badge>
              )}
              <div className="flex-1" />
              {probing && !probeStopped && (
                <span className="flex items-center gap-1.5 text-[11px] text-muted">
                  <Loader2 size={12} className="animate-spin" />
                  {probeElapsed > 0
                    ? t('add.probingSeconds', { count: probeElapsed })
                    : t('add.mediaDetecting')}
                  <button
                    type="button"
                    onClick={() => setProbeStopped(true)}
                    className="text-brand hover:underline"
                  >
                    {t('add.stopWaiting')}
                  </button>
                </span>
              )}
              {probing && probeStopped && (
                <span className="flex items-center gap-1.5 text-[11px] text-muted">
                  {t('add.stoppedWaiting')}
                  <button
                    type="button"
                    onClick={() => setProbeNonce((value) => value + 1)}
                    className="text-brand hover:underline"
                  >
                    {t('add.retryProbe')}
                  </button>
                </span>
              )}
              <button
                type="button"
                onClick={() => setForceAria2((value) => !value)}
                className="text-[11px] text-brand hover:underline"
              >
                {forceAria2 ? t('add.mediaUseYtDlp') : t('add.mediaUseAria2')}
              </button>
            </div>

            {probing && !probeStopped && probeElapsed >= 6 && (
              <p className="mt-2.5 rounded-lg border border-line bg-elevated/30 px-3 py-2 text-[11.5px] leading-relaxed text-muted">
                {t('add.probeSlow')}
              </p>
            )}

            {!hasYtDlp && !forceAria2 && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-warn/25 bg-warn/10 px-3 py-2">
                <span className="text-[11.5px] leading-relaxed text-warn">
                  {installing === 'ytdlp'
                    ? t('add.installingEngine')
                    : t('add.engineMissing', {
                        target: uris.length > 1 ? t('add.linkMany') : t('add.linkOne')
                      })}
                </span>
                {installing === 'ytdlp' ? (
                  <Loader2 size={14} className="animate-spin text-warn" />
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Sparkles size={13} />}
                    onClick={() => void installToolkit('ytdlp')}
                  >
                    {t('add.installNow')}
                  </Button>
                )}
              </div>
            )}

            {mediaError && !probing && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
                <span className="text-[11.5px] leading-relaxed text-danger">{mediaError.message}</span>
                {(mediaError.kind === 'bot-check' ||
                  mediaError.kind === 'auth' ||
                  mediaError.kind === 'cookies-missing' ||
                  mediaError.kind === 'cookies-locked' ||
                  mediaError.kind === 'cookies-undecryptable') && (
                  <span className="text-[11px] leading-relaxed text-muted">{t('add.cookiesHint')}</span>
                )}
                {formatId !== '' && (
                  <span className="text-[11px] leading-relaxed text-muted">{t('add.canStillTry')}</span>
                )}
                {mediaError.action && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={installing !== ''}
                    icon={
                      installing !== '' ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Wrench size={13} />
                      )
                    }
                    onClick={() => fixMediaError(mediaError.action!)}
                  >
                    {mediaError.actionLabel ?? t('common.retry')}
                  </Button>
                )}
              </div>
            )}

            {showFormatPanel && (
              <>
                <div className="mt-2.5 grid grid-cols-2 gap-3">
                  <SelectField
                    label={probing ? t('add.formatProbing') : t('add.format')}
                    hint={t('add.formatHint')}
                    value={formatId}
                    options={choiceList.map((format) => ({
                      value: format.formatId,
                      label: formatOptionLabel(format)
                    }))}
                    onValueChange={(value) => {
                      formatTouched.current = true
                      setFormatId(value)
                    }}
                  />
                  <Field label={t('add.dir')}>
                    <div className="flex gap-2">
                      <Input value={dir} onChange={(event) => setDir(event.target.value)} />
                      <Button
                        variant="secondary"
                        icon={<FolderOpen size={14} />}
                        onClick={() => {
                          void window.api.settings.chooseDirectory(dir).then((chosen) => {
                            if (chosen) setDir(chosen)
                          })
                        }}
                      />
                    </div>
                  </Field>
                </div>

                <div className="mt-1 grid grid-cols-2 gap-x-6 border-t border-brand/20 pt-1">
                  <Row label={t('add.audioOnly')} hint={t('add.audioOnlyHint')}>
                    <Toggle
                      checked={audioOnly}
                      onChange={(next) => {
                        setAudioOnly(next)
                        formatTouched.current = true
                        if (next) {
                          const audio = formats?.find((format) => format.resolution === 'audio')
                          setFormatId(audio?.formatId ?? provisionalFormatId(hasFfmpeg, true))
                        } else if (chosenFormat?.resolution === 'audio') {
                          setFormatId(formats?.[0]?.formatId ?? provisionalFormatId(hasFfmpeg, false))
                        }
                      }}
                      label={t('add.audioOnly')}
                    />
                  </Row>
                  <Row
                    label={t('add.playlist')}
                    hint={
                      selectedItems.length > 0
                        ? t('add.playlistChosen', { count: selectedItems.length })
                        : isPlaylist
                          ? t('add.playlistDetected')
                          : t('add.playlistHint')
                    }
                  >
                    {isPlaylist ? (
                      <div className="flex items-center gap-2">
                        {selectedItems.length > 0 && (
                          <button
                            type="button"
                            className="text-[11px] text-brand hover:underline"
                            onClick={() => {
                              setSelectedItems([])
                              setPlaylist(false)
                            }}
                          >
                            {t('add.playlistClear')}
                          </button>
                        )}
                        <Button variant="secondary" size="sm" onClick={() => void openPlaylistPicker()}>
                          {t('add.playlistChoose')}
                        </Button>
                      </div>
                    ) : (
                      <Toggle checked={playlist} onChange={setPlaylist} label={t('add.playlist')} />
                    )}
                  </Row>
                </div>

                {audioOnly && (
                  <SelectField
                    className="mt-2"
                    label={t('add.audioFormat')}
                    hint={t('add.audioFormatHint')}
                    value={audioFormat}
                    options={[
                      { value: 'native', label: t('add.audio.native') },
                      { value: 'mp3', label: 'MP3' },
                      { value: 'm4a', label: 'M4A' },
                      { value: 'flac', label: 'FLAC' },
                      { value: 'opus', label: 'OPUS' },
                      { value: 'wav', label: 'WAV' }
                    ]}
                    onValueChange={(value) => setAudioFormat(value as AudioFormat)}
                  />
                )}

                {subtitleTracks.length > 0 && (
                  <div className="mt-2 border-t border-brand/20 pt-2">
                    <div className="flex items-center gap-2 text-[11.5px] text-muted">
                      <Captions size={13} />
                      <span>{t('add.subtitleLang')}</span>
                      <span className="text-faint">{t('add.subtitleHint')}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {subtitleTracks.map((track) => {
                        const active = subtitleLangs.includes(track.code)
                        return (
                          <button
                            key={track.code}
                            type="button"
                            onClick={() =>
                              setSubtitleLangs((previous) =>
                                active ? previous.filter((code) => code !== track.code) : [...previous, track.code]
                              )
                            }
                            className={cn(
                              'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                              active
                                ? 'border-brand bg-brand/15 text-fg'
                                : 'border-line bg-elevated/40 text-muted hover:text-fg'
                            )}
                          >
                            {track.code}
                            {track.auto ? t('add.subtitleAuto') : ''}
                          </button>
                        )
                      })}
                    </div>
                    {subtitleLangs.length > 0 && (
                      <Row label={t('add.embedSubtitles')} hint={t('add.embedSubtitlesHint')}>
                        <Toggle
                          checked={embedSubtitles}
                          onChange={setEmbedSubtitles}
                          label={t('add.embedSubtitles')}
                        />
                      </Row>
                    )}
                  </div>
                )}

                {needsFfmpeg && !hasFfmpeg && (
                  <p className="rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-[11.5px] leading-relaxed text-warn">
                    {t('add.needsFfmpeg')}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {useYtDlp ? null : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Field
                label={t('add.saveAs')}
                hint={isTorrent ? t('add.saveAsTorrent') : t('add.saveAsHint')}
              >
                <Input
                  value={out}
                  onChange={(event) => setOut(event.target.value)}
                  placeholder={uris[0] ? fileNameFromUri(uris[0]) : t('add.placeholderAuto')}
                  disabled={isTorrent}
                />
              </Field>

              <Field label={t('add.dir')}>
                <div className="flex gap-2">
                  <Input value={dir} onChange={(event) => setDir(event.target.value)} />
                  <Button
                    variant="secondary"
                    icon={<FolderOpen size={14} />}
                    onClick={() => {
                      void window.api.settings.chooseDirectory(dir).then((chosen) => {
                        if (chosen) setDir(chosen)
                      })
                    }}
                  />
                </div>
              </Field>

              <SelectField
                label={t('add.category')}
                value={category || AUTO_CATEGORY}
                options={[
                  { value: AUTO_CATEGORY, label: t('add.categoryAuto') },
                  ...(settings?.categories ?? []).map((entry) => ({ value: entry.id, label: entry.name }))
                ]}
                onValueChange={(value) => setCategory(value === AUTO_CATEGORY ? '' : value)}
              />

              <SelectField
                label={t('add.connections')}
                value={preset}
                options={[
                  { value: 'standard', label: t('add.preset.standard') },
                  { value: 'steady', label: t('add.preset.steady') },
                  { value: 'turbo', label: t('add.preset.turbo') },
                  { value: 'single', label: t('add.preset.single') }
                ]}
                onValueChange={(value) => setPreset(value as ConnectionsPreset)}
              />
            </div>

            <div className="rounded-lg border border-line bg-elevated/30 px-3 py-1">
              <Row label={t('add.queueOnly')} hint={t('add.queueOnlyHint')}>
                <Toggle checked={paused} onChange={setPaused} label={t('add.queueOnly')} />
              </Row>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setAdvanced((value) => !value)}
                className="flex items-center gap-1.5 text-[12px] text-brand hover:underline"
              >
                <Settings2 size={13} />
                {advanced ? t('common.advanced.hide') : t('common.advanced.show')}
              </button>

              {advanced && (
                <div className="mt-3 space-y-4 rounded-lg border border-line bg-elevated/30 p-3">
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Referer" hint={t('add.refererHint')}>
                      <Input
                        value={referer}
                        onChange={(event) => setReferer(event.target.value)}
                        placeholder={t('add.placeholderAuto')}
                      />
                    </Field>
                    <Field label="User-Agent" hint={t('add.userAgentHint')}>
                      <Input
                        value={userAgent}
                        onChange={(event) => setUserAgent(event.target.value)}
                        placeholder={t('add.placeholderDefault')}
                      />
                    </Field>
                    <Field label="Cookie" hint={t('add.cookieHint')}>
                      <Input
                        value={cookies}
                        onChange={(event) => setCookies(event.target.value)}
                        placeholder="key=value; key2=value2"
                      />
                    </Field>
                    <Field label={t('add.limit')} hint={t('add.limitHint')}>
                      <Input
                        value={maxLimit}
                        onChange={(event) => setMaxLimit(event.target.value)}
                        placeholder={t('common.unlimited')}
                      />
                    </Field>
                    <Field label={t('add.httpUser')}>
                      <Input value={username} onChange={(event) => setUsername(event.target.value)} />
                    </Field>
                    <Field label={t('add.httpPassword')}>
                      <Input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    </Field>
                    <Field label={t('add.proxy')} hint={t('add.proxyHint')}>
                      <Input value={proxy} onChange={(event) => setProxy(event.target.value)} />
                    </Field>
                    <Field label={t('add.headers')} hint={t('add.headersHint')}>
                      <TextArea
                        rows={3}
                        value={headers}
                        onChange={(event) => setHeaders(event.target.value)}
                        placeholder="X-Custom: value"
                      />
                    </Field>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {uris.length > 1 && mirrorCount > 0 && (
          <p className="rounded-lg border border-info/25 bg-info/10 px-3 py-2 text-[11.5px] leading-relaxed text-info">
            {t('add.mirrorNotice')}
          </p>
        )}
      </div>
    </Modal>
      <PlaylistPicker
        open={pickerOpen}
        loading={playlistLoading}
        title={playlistTitle}
        entries={playlistEntries}
        onClose={() => setPickerOpen(false)}
        onConfirm={(indices) => {
          setSelectedItems(indices)
          setPlaylist(true)
          setPickerOpen(false)
        }}
      />
    </>
  )
}
