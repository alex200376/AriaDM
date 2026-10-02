import { describe, expect, it } from 'vitest'

import { buildDownloadArgs, formatPlaylistItems, parsePlaylist } from '../../src/main/media/ytdlp'

/**
 * Selecting part of a playlist.
 *
 * The flat probe gives the picker its titles and durations, and the chosen
 * positions have to reach yt-dlp as a valid `--playlist-items` value — an empty
 * or malformed one makes yt-dlp refuse the whole run, so the formatting is
 * pinned here rather than trusted.
 */

describe('formatPlaylistItems', () => {
  it('collapses consecutive positions into ranges', () => {
    expect(formatPlaylistItems([1, 2, 3, 5, 7, 8])).toBe('1-3,5,7-8')
  })

  it('sorts, deduplicates and drops anything that is not a position', () => {
    expect(formatPlaylistItems([3, 1, 1, 0, -2, 2.5])).toBe('1,3')
  })

  it('is empty for an empty selection', () => {
    expect(formatPlaylistItems([])).toBe('')
  })
})

describe('parsePlaylist', () => {
  it('reads titles, ids and durations from a flat probe', () => {
    const info = parsePlaylist({
      title: 'A channel',
      entries: [
        { id: 'a', title: 'First', duration: 12, webpage_url: 'https://x/a' },
        { id: 'b', duration: 34 }
      ]
    })

    expect(info.title).toBe('A channel')
    expect(info.entries[0]).toEqual({
      id: 'a',
      title: 'First',
      durationSeconds: 12,
      url: 'https://x/a',
      thumbnail: ''
    })
    // Falls back to the id rather than showing a blank row.
    expect(info.entries[1]!.title).toBe('b')
  })

  it('is empty when there are no entries', () => {
    expect(parsePlaylist({}).entries).toEqual([])
  })
})

describe('playlist download arguments', () => {
  const run = {
    binaryPath: 'yt-dlp.exe',
    url: 'https://www.youtube.com/playlist?list=abc',
    formatId: 'bestvideo+bestaudio/best',
    dir: 'C:/downloads',
    ffmpegDir: '',
    audioOnly: false,
    playlist: true,
    overwrite: false
  }

  it('narrows the run to the chosen positions', () => {
    const args = buildDownloadArgs({ ...run, playlistItems: [1, 2, 4] })

    expect(args[args.indexOf('--playlist-items') + 1]).toBe('1-2,4')
  })

  it('leaves the option out entirely when nothing was chosen', () => {
    // The plain "whole playlist" toggle means no positions, which is yt-dlp's
    // own default and must not become `--playlist-items ''`.
    expect(buildDownloadArgs(run)).not.toContain('--playlist-items')
  })
})
