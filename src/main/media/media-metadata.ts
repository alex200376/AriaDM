import ogs from 'open-graph-scraper-lite'

/**
 * Media declared in a page's metadata rather than in its markup.
 *
 * `shared/media-sniff.ts` looks for the things a player always has — a `<video>`
 * tag, a streaming manifest — and that is fast and usually right. But plenty of
 * pages carry the player only in metadata: an Open Graph `og:video`, a Twitter
 * player card, or a schema.org `VideoObject` in JSON-LD. Those pages are
 * genuinely video pages and used to be missed, so they fell to aria2 and the
 * user got the HTML.
 *
 * The parser is given the bytes we already fetched, so nothing is fetched, and
 * it makes no request of its own: this reads metadata out of an existing string.
 * Every failure — malformed markup, a parser bug — is reported as "no media"
 * rather than thrown. A link is only ever promoted to yt-dlp on positive
 * evidence; anything less must keep its previous, safe answer.
 */

/** The result fields that mean "this page plays a video or an audio track". */
interface MetadataLike {
  ogVideo?: { url?: string }[]
  ogVideoURL?: string[]
  twitterPlayer?: { stream?: string[] | string }[]
}

/**
 * Does this page's metadata declare playable media?
 *
 * `og:video` and `twitter:player:stream` are the two open standards for it, and
 * a JSON-LD `VideoObject` is the schema.org spelling of the same claim. A page
 * that only carries `og:image` is an article with a picture, not a video.
 */
export async function pageHasMediaMetadata(html: string): Promise<boolean> {
  try {
    const { result } = await ogs({ html })
    if (hasVideoMeta(result)) return true
    return jsonLdDeclaresVideo(result.jsonLD)
  } catch {
    // A parser that cannot read the page has learned nothing, and "nothing"
    // must not become a yt-dlp download.
    return false
  }
}

function hasVideoMeta(result: unknown): boolean {
  const meta = result as MetadataLike
  if (Array.isArray(meta.ogVideo) && meta.ogVideo.some((video) => Boolean(video?.url))) {
    return true
  }
  if (meta.ogVideoURL?.length) return true
  // Twitter Card: `stream` is the actual media URL and `url` is the iframe that
  // wraps it. Either one means there is a video to fetch.
  const players = meta.twitterPlayer ?? []
  return players.some((player) => Boolean(streamOf(player)))
}

function streamOf(player: { stream?: string[] | string }): string {
  const stream = player.stream
  if (Array.isArray(stream)) return stream.find(Boolean) ?? ''
  return stream ?? ''
}

/**
 * True when any JSON-LD node is a schema.org `VideoObject`.
 *
 * A page usually has one node, but `@graph` and nested objects are common, so
 * the search walks the whole structure. `@type` may be a string or an array.
 * Visited objects are tracked because a malformed graph can contain a cycle.
 */
export function jsonLdDeclaresVideo(nodes: unknown): boolean {
  const seen = new Set<unknown>()

  const visit = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false
    if (seen.has(node)) return false
    seen.add(node)

    if (Array.isArray(node)) return node.some(visit)

    const record = node as Record<string, unknown>
    const type = record['@type']
    if (typeof type === 'string' && type.toLowerCase() === 'videoobject') return true
    if (Array.isArray(type) && type.some((entry) => String(entry).toLowerCase() === 'videoobject')) {
      return true
    }
    return Object.values(record).some(visit)
  }

  return Array.isArray(nodes) ? nodes.some(visit) : visit(nodes)
}
