import { describe, expect, it } from 'vitest'

import {
  classifyUriList,
  detectKindFromList,
  extensionOf,
  fileNameFromPath,
  fileNameFromUri,
  hasFileExtension,
  isListFileName,
  isReservedDeviceName,
  isSupportedUri,
  kindFromUri,
  parseUriList,
  sanitizeFileName
} from '@shared/uri'

describe('sanitizeFileName', () => {
  it('keeps only the last path segment on both separator conventions', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('C:\\Users\\me\\file.txt')).toBe('file.txt')
    expect(sanitizeFileName('/var/tmp/archive.tar.gz')).toBe('archive.tar.gz')
  })

  it('replaces characters Windows forbids', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt')
    expect(sanitizeFileName('tab\tname.bin')).toBe('tab_name.bin')
  })

  it('strips leading dots and trailing dots/spaces', () => {
    expect(sanitizeFileName('.hidden')).toBe('hidden')
    expect(sanitizeFileName('name.txt. ')).toBe('name.txt')
    expect(sanitizeFileName('...')).toBe('download')
  })

  it('escapes reserved device names', () => {
    expect(isReservedDeviceName('CON')).toBe(true)
    expect(isReservedDeviceName('con.txt')).toBe(true)
    expect(isReservedDeviceName('console.txt')).toBe(false)
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt')
    expect(sanitizeFileName('lpt1')).toBe('_lpt1')
  })

  it('falls back for empty input and preserves the extension when truncating', () => {
    expect(sanitizeFileName('   ', 'fallback.bin')).toBe('fallback.bin')
    expect(sanitizeFileName('')).toBe('download')

    const long = `${'a'.repeat(300)}.mp4`
    const result = sanitizeFileName(long)
    expect(result.length).toBeLessThanOrEqual(180)
    expect(result.endsWith('.mp4')).toBe(true)
  })
})

describe('fileNameFromUri', () => {
  it('reads and decodes the last path segment', () => {
    expect(fileNameFromUri('https://example.com/dir/file.zip?token=abc')).toBe('file.zip')
    expect(fileNameFromUri('https://example.com/%E6%AA%94%E6%A1%88.zip')).toBe('檔案.zip')
  })

  it('does not throw on a malformed percent escape', () => {
    expect(fileNameFromUri('https://example.com/%E0%A4%A.bin')).toBe('%E0%A4%A.bin')
  })

  it('derives a name from the display name of a magnet link', () => {
    expect(fileNameFromUri('magnet:?xt=urn:btih:abc&dn=Ubuntu%2024.04.iso')).toBe('Ubuntu 24.04.iso')
    expect(fileNameFromUri('magnet:?xt=urn:btih:abc')).toBe('magnet 下載')
  })

  it('falls back to host plus path when the path has no filename', () => {
    expect(fileNameFromUri('https://example.com/')).toBe('example.com_')
  })

  it('handles input that is not a URL at all', () => {
    expect(fileNameFromUri('just-a-name.bin')).toBe('just-a-name.bin')
  })
})

describe('extensionOf / fileNameFromPath', () => {
  it('returns the lowercased extension without the dot', () => {
    expect(extensionOf('archive.tar.GZ')).toBe('gz')
    expect(extensionOf('.bashrc')).toBe('')
    expect(extensionOf('noext')).toBe('')
    expect(extensionOf('trailing.')).toBe('')
  })

  it('extracts the final segment of either path separator', () => {
    expect(fileNameFromPath('C:\\a\\b\\c.txt')).toBe('c.txt')
    expect(fileNameFromPath('/a/b/')).toBe('b')
  })
})

describe('parseUriList', () => {
  it('drops blanks and comments and removes exact duplicates', () => {
    const text = ['# a comment', '', 'https://a.example/f', '  https://b.example/f  ', 'https://a.example/f'].join('\n')
    expect(parseUriList(text)).toEqual(['https://a.example/f', 'https://b.example/f'])
  })
})

describe('hasFileExtension', () => {
  it('treats a named payload as a file', () => {
    expect(hasFileExtension('https://example.com/archive.zip')).toBe(true)
    expect(hasFileExtension('https://example.com/clip.mp4')).toBe(true)
    expect(hasFileExtension('https://example.com/ubuntu-24.04.iso?token=abc')).toBe(true)
    expect(hasFileExtension('magnet:?xt=urn:btih:abc')).toBe(true)
  })

  it('does not treat a web page as a file', () => {
    // The reported misrouting: a video page with a `.html` suffix is a page, not
    // a payload, and handing it to aria2 saved the HTML instead of the video.
    expect(hasFileExtension('https://www.acgmho.com/gif/883534.html')).toBe(false)
    expect(hasFileExtension('https://example.com/watch/123.php')).toBe(false)
    expect(hasFileExtension('https://example.com/show.aspx?id=1')).toBe(false)
    expect(hasFileExtension('https://example.com/index.htm')).toBe(false)
  })

  it('still trusts an explicit filename when the server declares one', () => {
    // `?filename=page.html` is the server naming a download, not a page URL.
    expect(hasFileExtension('https://example.com/get?filename=report.html')).toBe(true)
  })

  it('leaves a dotless path and a slug alone', () => {
    expect(hasFileExtension('https://x.com/someone/status/12345')).toBe(false)
    expect(hasFileExtension('https://example.com/v2.1.3-release-notes')).toBe(false)
  })
})

describe('classifyUriList', () => {
  it('groups URIs that share a filename as mirrors of one download', () => {
    const result = classifyUriList([
      'https://mirror1.example/file.iso',
      'https://mirror2.example/file.iso',
      'https://other.example/separate.zip'
    ])
    expect(result.mirrors).toEqual([['https://mirror1.example/file.iso', 'https://mirror2.example/file.iso']])
    expect(result.singles).toEqual(['https://other.example/separate.zip'])
  })

  it('never merges two magnet links, which have no shared filename', () => {
    const result = classifyUriList(['magnet:?xt=urn:btih:aaa', 'magnet:?xt=urn:btih:bbb'])
    expect(result.mirrors).toHaveLength(0)
    expect(result.singles).toHaveLength(2)
  })
})

describe('kind detection', () => {
  it('classifies schemes', () => {
    expect(kindFromUri('magnet:?xt=urn:btih:abc')).toBe('bittorrent')
    expect(kindFromUri('ftp://host/file')).toBe('ftp')
    expect(kindFromUri('sftp://host/file')).toBe('ftp')
    expect(kindFromUri('https://host/file')).toBe('http')
  })

  it('accepts the schemes the engine supports and rejects the rest', () => {
    expect(isSupportedUri('https://host/file')).toBe(true)
    expect(isSupportedUri('magnet:?xt=urn:btih:abc')).toBe(true)
    expect(isSupportedUri('gopher://host/file')).toBe(false)
    expect(isSupportedUri('file:///etc/passwd')).toBe(false)
  })

  it('prefers torrent over ftp over http across a mixed list', () => {
    expect(detectKindFromList(['https://a/1', 'magnet:?xt=urn:btih:x'])).toBe('bittorrent')
    expect(detectKindFromList(['https://a/1', 'ftp://b/2'])).toBe('ftp')
    expect(detectKindFromList(['https://a/1'])).toBe('http')
  })
})

describe('isListFileName', () => {
  it('recognises a text or playlist file of links', () => {
    expect(isListFileName('links.txt')).toBe(true)
    expect(isListFileName('download.LIST')).toBe(true)
    expect(isListFileName('playlist.m3u')).toBe(true)
    expect(isListFileName('playlist.m3u8')).toBe(true)
    expect(isListFileName('  urls.urls  ')).toBe(true)
  })

  it('leaves anything that is itself a download alone', () => {
    // A `.torrent` and a `.metalink` have their own drop handling, and a media
    // file is not a list of links.
    expect(isListFileName('ubuntu.torrent')).toBe(false)
    expect(isListFileName('pack.metalink')).toBe(false)
    expect(isListFileName('video.mp4')).toBe(false)
    expect(isListFileName('archive.zip')).toBe(false)
  })

  it('finds the links in a playlist through parseUriList', () => {
    // The `#EXTINF` directives are comments, which parseUriList already drops.
    const playlist = ['#EXTM3U', '#EXTINF:-1,One', 'https://example.test/one', '', 'https://example.test/two'].join(
      '\n'
    )
    expect(parseUriList(playlist)).toEqual(['https://example.test/one', 'https://example.test/two'])
  })
})
