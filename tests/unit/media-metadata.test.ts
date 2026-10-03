import { describe, expect, it } from 'vitest'

import { jsonLdDeclaresVideo, pageHasMediaMetadata } from '../../src/main/media/media-metadata'

/**
 * The metadata parser is the second opinion for a page whose player is declared
 * only in metadata. Its two failure modes both matter: a page that carries an
 * `og:video` must be recognised, and an ordinary article must not be — a false
 * positive sends a page to yt-dlp, and a false negative saves the HTML.
 */

describe('pageHasMediaMetadata', () => {
  it('recognises an Open Graph video', async () => {
    const html = '<html><head><meta property="og:video" content="https://cdn.example/v.mp4"></head></html>'
    expect(await pageHasMediaMetadata(html)).toBe(true)
  })

  it('recognises a Twitter player stream', async () => {
    const html = [
      '<html><head>',
      '<meta name="twitter:player" content="https://cdn.example/player.html">',
      '<meta name="twitter:player:stream" content="https://cdn.example/v.mp4">',
      '</head></html>'
    ].join('')
    expect(await pageHasMediaMetadata(html)).toBe(true)
  })

  it('recognises a JSON-LD VideoObject', async () => {
    const html = [
      '<html><head><script type="application/ld+json">',
      '{"@context":"https://schema.org","@type":"VideoObject","name":"v","contentUrl":"https://cdn.example/v.mp4"}',
      '</script></head></html>'
    ].join('')
    expect(await pageHasMediaMetadata(html)).toBe(true)
  })

  it('leaves an article with only an image alone', async () => {
    const html = [
      '<html><head>',
      '<meta property="og:type" content="article">',
      '<meta property="og:image" content="https://cdn.example/i.png">',
      '<meta property="og:title" content="A story">',
      '</head><body><p>Text.</p></body></html>'
    ].join('')
    expect(await pageHasMediaMetadata(html)).toBe(false)
  })

  it('returns false rather than throwing on markup it cannot read', async () => {
    // A broken page must keep its previous, safe answer, not become a download.
    await expect(pageHasMediaMetadata('<<<>>>not really html<<<')).resolves.toBe(false)
    await expect(pageHasMediaMetadata('')).resolves.toBe(false)
  })
})

describe('jsonLdDeclaresVideo', () => {
  it('accepts a top-level VideoObject', () => {
    expect(jsonLdDeclaresVideo([{ '@type': 'VideoObject', name: 'v' }])).toBe(true)
  })

  it('accepts a VideoObject nested in an @graph', () => {
    const graph = [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, { '@type': 'VideoObject' }] }]
    expect(jsonLdDeclaresVideo(graph)).toBe(true)
  })

  it('accepts an array @type', () => {
    expect(jsonLdDeclaresVideo([{ '@type': ['Article', 'VideoObject'] }])).toBe(true)
  })

  it('rejects a graph without a video', () => {
    expect(jsonLdDeclaresVideo([{ '@type': 'NewsArticle', headline: 'x' }])).toBe(false)
    expect(jsonLdDeclaresVideo(undefined)).toBe(false)
  })

  it('does not loop forever on a self-referential graph', () => {
    const node: Record<string, unknown> = { '@type': 'WebPage' }
    node.about = node
    expect(jsonLdDeclaresVideo([node])).toBe(false)
  })
})
