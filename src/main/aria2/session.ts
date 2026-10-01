import fsp from 'node:fs/promises'

/**
 * AriaDM does not restore the previous queue on startup.
 *
 * aria2 can persist its queue to a session file and replay it via `--input-file`,
 * but that brings back every paused and errored download it ever recorded. In
 * practice those accumulate without bound, so a launch a week later surfaced
 * hundreds of downloads the user had long forgotten about. Downloads live in our
 * own history store instead, and the queue always starts empty.
 *
 * This class exists only to delete a session file that an older build left
 * behind, so upgrading users are cleaned up on their first launch.
 */
export class SessionFile {
  readonly path: string

  constructor(sessionPath: string) {
    this.path = sessionPath
  }

  /** Remove the legacy session file; a missing file is not an error. */
  async purge(): Promise<void> {
    try {
      await fsp.rm(this.path, { force: true })
    } catch {
      // Best effort: the engine must still start even if the path is locked.
    }
  }
}
