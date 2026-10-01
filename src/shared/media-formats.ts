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

/** True when nothing in the list can be produced without ffmpeg. */
export function needsFfmpegForAnything(formats: MediaFormatInfo[]): boolean {
  return formats.length > 0 && formats.every((format) => format.needsFfmpeg)
}
