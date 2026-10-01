import { UPDATE_REPO, type UpdateCheckResult } from '@shared/ipc'

/**
 * In-app update check.
 *
 * Deliberately not `electron-updater`: that library wants a signed build and a
 * publish provider, and this app ships unsigned installers that users download
 * by hand. All the updater needs to do is answer "is there a newer release?" and
 * hand the user a link, so it reads the public GitHub Releases API directly and
 * has no dependencies.
 *
 * The check never throws. A network failure or a repository with no releases yet
 * is a normal outcome, reported in `UpdateInfo.error` / a null `latest`, not an
 * exception the UI has to guard against.
 */

const RELEASE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`

const RESPONSE_TIMEOUT_MS = 8000

/** The shape of the GitHub payload we actually read. */
interface GithubRelease {
  tag_name?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  assets?: { name?: string; browser_download_url?: string; size?: number; digest?: string }[]
}

/** Minimal slice of `fetch` this module uses, so tests can inject a stub. */
export interface UpdateResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type UpdateFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<UpdateResponse>

/** `v1.2.3-beta.1+build` -> `1.2.3`. */
function normalise(version: string): string {
  return version
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/)[0]!
}

/** Standard version comparison: -1, 0 or 1. Missing segments count as zero. */
export function compareVersions(a: string, b: string): number {
  const segments = (value: string): number[] =>
    normalise(value)
      .split('.')
      .map((piece) => {
        const parsed = Number.parseInt(piece, 10)
        return Number.isFinite(parsed) ? parsed : 0
      })

  const left = segments(a)
  const right = segments(b)
  const length = Math.max(left.length, right.length)

  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

function unavailable(current: string, error = ''): UpdateCheckResult {
  return {
    current,
    latest: null,
    available: false,
    releaseUrl: null,
    downloadUrl: null,
    downloadSize: 0,
    downloadSha256: '',
    // Whether the running build can self-install is decided by the caller, which
    // is the only place that knows the app is packaged and not portable.
    canInstall: false,
    error
  }
}

/**
 * The SHA-256 the release published for an asset, if it published one.
 *
 * The API reports it as `sha256:<hex>`. Anything else — another algorithm, a
 * truncated value — is treated as "no digest", so the downloader falls back to
 * the size check instead of refusing every update on a field it cannot read.
 */
function readDigest(digest: unknown): string {
  if (typeof digest !== 'string') return ''
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim())
  return match?.[1] ? match[1].toLowerCase() : ''
}

/** Turn a GitHub release payload into an update check result. Exported for tests. */
export function parseRelease(json: unknown, current: string): UpdateCheckResult {
  const release = (json ?? {}) as GithubRelease
  if (release.draft === true || release.prerelease === true) return unavailable(current)

  const latest = typeof release.tag_name === 'string' ? normalise(release.tag_name) : ''
  if (!latest) return unavailable(current)

  const assets = Array.isArray(release.assets) ? release.assets : []
  // Prefer the NSIS installer; fall back to any .exe (portable) before the page.
  const installer =
    assets.find((asset) => /setup.*\.exe$/i.test(asset.name ?? '')) ??
    assets.find((asset) => /\.exe$/i.test(asset.name ?? ''))

  return {
    current,
    latest,
    available: compareVersions(latest, current) > 0,
    releaseUrl: typeof release.html_url === 'string' ? release.html_url : null,
    downloadUrl: installer?.browser_download_url ?? null,
    // The size lets the download report real progress and reject a truncated
    // file; the GitHub API reports it for every asset, but it is optional here.
    downloadSize: typeof installer?.size === 'number' ? installer.size : 0,
    downloadSha256: readDigest(installer?.digest),
    canInstall: false,
    error: ''
  }
}

/**
 * Ask GitHub for the newest release and compare it with the running version.
 *
 * @param current the version to compare against, normally `app.getVersion()`
 * @param fetchImpl injectable for tests
 */
export async function checkForUpdate(
  current: string,
  fetchImpl: UpdateFetch = fetch as unknown as UpdateFetch
): Promise<UpdateCheckResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS)
  timer.unref?.()

  try {
    const response = await fetchImpl(RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'AriaDM'
      },
      signal: controller.signal
    })

    // 404 is the healthy answer before the first release exists.
    if (response.status === 404) return unavailable(current)
    if (!response.ok) return unavailable(current, `HTTP ${response.status}`)

    return parseRelease(await response.json(), current)
  } catch (error) {
    return unavailable(current, (error as Error).message || String(error))
  } finally {
    clearTimeout(timer)
  }
}
