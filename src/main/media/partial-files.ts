import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * The working files a yt-dlp run leaves in the download folder.
 *
 * yt-dlp never writes into the file it was asked for. It writes the bytes into
 * `<name>.part` and renames it onto `<name>` once the transfer is complete, and a
 * fragmented stream (HLS/DASH) is fetched in pieces, each of which is its own
 * `<name>.part-Frag<N>` — itself written through a `<name>.part-Frag<N>.part`. A
 * run being resumed keeps a `<name>.ytdl` beside them, and an ffmpeg merge writes
 * `<name>.temp.<ext>` before renaming it onto the download.
 *
 * Every one of them carries the download's own name as a prefix, which is what
 * makes them recognisable — and why a download that is gone from the list still
 * has to take them with it. Nothing else can: no row is left to resume from, and
 * no viewer can open a half-written fragment. What that looks like from outside
 * is a download folder slowly filling with `index [index].mp4.part-Frag7.part`
 * and a `.ytdl` next to it.
 */

/** How many times a file another process still holds is retried, and how far apart. */
const REMOVE_ATTEMPTS = 5
const REMOVE_BACKOFF_MS = 150

/**
 * What yt-dlp writes after a download's own name while it works.
 *
 * `.part` is the file the bytes are going into — and, with an index, one piece of
 * a fragmented stream; `.ytdl` is the session of a run being continued; and
 * `.temp.<ext>` is what a merge or a remux writes before renaming it onto the
 * download. Each is matched in full rather than by prefix, because a name that
 * merely begins with one of them is a different file altogether:
 * `a video.mp4.partial-notes.txt` is not something yt-dlp wrote.
 */
const WORKING_SUFFIXES = [
  /^\.part(-Frag\d+)?(\.part)?$/,
  /^\.temp(\.[A-Za-z0-9]{1,5})?$/,
  /^\.ytdl$/
]

/**
 * The name a working file belongs to, with its temporary suffixes removed.
 *
 * `<name>.part-Frag7.part` is a fragment still arriving, `<name>.part-Frag7` one
 * that has, and `<name>.part` the whole transfer's own temp file: one pass per
 * suffix means any of them, and any nesting of them, lands on the download's real
 * name.
 */
export function partialStem(filePath: string): string {
  let stem = filePath
  for (;;) {
    const stripped = stem.replace(/\.part(-Frag\d+)?$/, '')
    if (stripped === stem) return stem
    stem = stripped
  }
}

/** True for one of `name`'s working files rather than for a finished download. */
export function isPartialOf(name: string, candidate: string): boolean {
  if (!name || !candidate.startsWith(name)) return false
  const suffix = candidate.slice(name.length)
  return WORKING_SUFFIXES.some((pattern) => pattern.test(suffix))
}

/**
 * Delete one file, allowing for a writer that has not let go of it yet.
 *
 * Windows refuses to remove a file another process still has open: the attempt
 * fails outright rather than being honoured when the handle closes. The caller
 * waits for the run to exit first, so this is the second line of defence — for a
 * process that outlived its exit, or a handle released a moment after it. Any
 * other error is a real refusal, reported instead of retried.
 */
export async function removeFile(
  filePath: string,
  log?: (message: string) => void
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rm(filePath, { force: true })
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const held = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
      if (!held || attempt + 1 >= REMOVE_ATTEMPTS) {
        log?.(`failed to delete ${filePath}: ${(error as Error).message}`)
        return false
      }
      await delay(REMOVE_BACKOFF_MS * (attempt + 1))
    }
  }
}

/**
 * Delete the working files of every name in `bases`, and return what was removed.
 *
 * The names come from the app rather than from the download folder: only entries
 * that begin with a download's own name are touched, so an unrelated file that
 * happens to live beside it is never in scope however the folder is arranged. A
 * name that is already the download itself is left alone — that file belongs to
 * the caller's decision about deleting files, not to this cleanup.
 */
export async function removePartialFiles(
  bases: Iterable<string>,
  log?: (message: string) => void
): Promise<string[]> {
  const removed: string[] = []
  const listings = new Map<string, string[] | null>()
  const seen = new Set<string>()

  for (const base of bases) {
    const stem = partialStem(base)
    const dir = path.dirname(stem)
    const name = path.basename(stem)
    // A path with no file name cannot be matched against anything, and one with
    // no directory (`video.mp4`) would run the scan in the process's own working
    // directory — which for a packaged app is its installation folder.
    if (!name || !dir || dir === '.') continue
    if (seen.has(stem)) continue
    seen.add(stem)

    let entries = listings.get(dir)
    if (entries === undefined) {
      try {
        entries = await fsp.readdir(dir)
      } catch {
        // A folder that cannot be listed has nothing to clean in it.
        entries = null
      }
      listings.set(dir, entries)
    }
    if (!entries) continue

    for (const entry of entries) {
      if (!isPartialOf(name, entry)) continue
      const target = path.join(dir, entry)
      if (await removeFile(target, log)) removed.push(target)
    }
  }

  return removed
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
