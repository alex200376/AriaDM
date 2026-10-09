import { t } from './i18n'
import type { MediaFormatInfo } from './settings'

/**
 * Which format a click should use when the user did not pick one.
 *
 * The interesting case is a machine without ffmpeg. YouTube serves its good
 * resolutions as separate video and audio streams, so "best" there means "merge
 * two streams" — and merging is precisely what cannot happen. Choosing it anyway
 * is how "I can't download YouTube videos" happens: the entry is first in the
 * list, so it is what everyone selects, and the download then fails on a message
 * about ffmpeg.
 *
 * With ffmpeg present, the best entry wins as before. Without it, the first
 * single-file (already muxed) format is used, so the download simply works at
 * whatever quality the site offers as one stream.
 */
export function defaultFormatId(formats: MediaFormatInfo[], hasFfmpeg: boolean): string {
  const fallback = 'bestvideo+bestaudio/best'
  if (formats.length === 0) return fallback
  if (hasFfmpeg) return formats[0]!.formatId

  const single = formats.find(
    (format) => !format.needsFfmpeg && format.vcodec !== 'none' && format.acodec !== 'none'
  )
  // A video-only or audio-only list is still better than refusing to try.
  return (single ?? formats.find((format) => !format.needsFfmpeg) ?? formats[0]!).formatId
}

/**
 * The format a download uses before any probe has answered.
 *
 * The quality picker used to stay un-submittable until yt-dlp had listed the
 * formats, which on a YouTube page is a few seconds of network work plus the
 * process boot — the whole delay the user waits through to do the one thing they
 * came for. Naming the format `defaultFormatId` would eventually choose lets the
 * download start immediately, while the probe still runs to fill in the tiers.
 *
 * `best` is yt-dlp's best already-muxed single file, which is exactly what a
 * machine without ffmpeg can produce. With ffmpeg the synthetic merged entry is
 * the better default. An audio-only request names the best audio the same way
 * the probe's own audio entry does.
 */
export function provisionalFormatId(hasFfmpeg: boolean, audioOnly: boolean): string {
  if (audioOnly) return 'bestaudio/best'
  return hasFfmpeg ? 'bestvideo+bestaudio/best' : 'best'
}

/**
 * The single picker row shown while the probe is still running.
 *
 * Shaped like the entry the probe replaces it with (see `parseFormats`) so the
 * menu does not visibly change size when the answer arrives — only the options
 * around it gain their resolutions and containers.
 */
export function provisionalFormatOption(
  hasFfmpeg: boolean,
  audioOnly: boolean
): MediaFormatInfo {
  if (audioOnly) {
    return {
      formatId: 'bestaudio/best',
      label: t('main.format.audioOnlyBest'),
      ext: 'm4a',
      resolution: 'audio',
      filesize: null,
      vcodec: 'none',
      acodec: 'auto',
      note: t('main.format.audioOnlyNote'),
      needsFfmpeg: false
    }
  }
  if (hasFfmpeg) {
    return {
      formatId: 'bestvideo+bestaudio/best',
      label: t('main.format.best'),
      ext: 'mp4',
      resolution: t('main.format.bestResolution'),
      filesize: null,
      vcodec: 'auto',
      acodec: 'auto',
      note: t('main.format.recommended'),
      needsFfmpeg: true
    }
  }
  return {
    formatId: 'best',
    label: t('main.format.singleFile'),
    ext: 'mp4',
    resolution: t('main.format.bestResolution'),
    filesize: null,
    vcodec: 'auto',
    acodec: 'auto',
    note: t('main.format.noFfmpegNote'),
    needsFfmpeg: false
  }
}

/** True when nothing in the list can be produced without ffmpeg. */
export function needsFfmpegForAnything(formats: MediaFormatInfo[]): boolean {
  return formats.length > 0 && formats.every((format) => format.needsFfmpeg)
}

/** Pixel height from a resolution string: `1080p`, `1920x1080`, `278x480`. */
function heightOf(resolution: string): number {
  const tall = /(\d{2,4})p$/i.exec(resolution)
  if (tall) return Number(tall[1])
  const box = /^(\d{2,5})x(\d{2,5})$/i.exec(resolution)
  if (box) return Math.min(Number(box[1]), Number(box[2]))
  return 0
}

/**
 * The formats worth putting in a menu.
 *
 * The download dialog shows the extractor's own list, which on YouTube is dozens
 * of entries — the same picture again in another codec, container or HDR flavour.
 * That is fine when every line has room to explain itself and wrong for a picker
 * next to a video, so this keeps one entry per resolution (highest first,
 * preferring the one that needs no merging) plus a single audio-only option, and
 * leaves "just pick something good" to `defaultFormatId`.
 */
export function formatChoices(
  formats: MediaFormatInfo[],
  options: { hasFfmpeg: boolean; limit?: number }
): MediaFormatInfo[] {
  const limit = Math.max(1, options.limit ?? 5)

  const best = new Map<number, MediaFormatInfo>()
  for (const format of formats) {
    if (format.resolution === 'audio') continue
    // The synthetic "best" entry is a request, not a stream: it is what the
    // caller gets when it names no format at all, so it does not belong in a
    // list of things to choose between.
    if (format.formatId === 'bestvideo+bestaudio/best') continue
    // Without ffmpeg a video-only stream cannot be made into a file at all.
    if (format.needsFfmpeg && !options.hasFfmpeg) continue

    const height = heightOf(format.resolution)
    const existing = best.get(height)
    // Same picture, different codec: the single-file stream is the more useful
    // of the two, because it plays without anything installed.
    if (!existing || (existing.needsFfmpeg && !format.needsFfmpeg)) best.set(height, format)
  }

  const tiers = [...best.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map(([, format]) => format)

  if (tiers.length >= limit) return tiers
  const audio = formats.find((format) => format.formatId === 'bestaudio/best')
  return audio ? [...tiers, audio] : tiers
}
