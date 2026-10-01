import os from 'node:os'
import path from 'node:path'

import type { AppPaths } from '@shared/settings'

/**
 * Path resolution kept as a pure function of the user data directory so it can
 * be unit tested without booting Electron.
 */
export function resolvePaths(userDataDir: string, downloadsDir: string): AppPaths {
  const logs = path.join(userDataDir, 'logs')
  return {
    userData: userDataDir,
    downloads: downloadsDir,
    logs,
    bin: path.join(userDataDir, 'bin'),
    session: path.join(userDataDir, 'session.aria2'),
    aria2Log: path.join(logs, 'aria2.log'),
    history: path.join(userDataDir, 'history.json'),
    settings: path.join(userDataDir, 'settings.json'),
    extensions: path.join(userDataDir, 'extensions')
  }
}

export function defaultDownloadDir(): string {
  return path.join(os.homedir(), 'Downloads', 'AriaDM')
}

/**
 * Where bundled binaries live. In a packaged app electron-builder places
 * extraResources under process.resourcesPath; in development they sit in the
 * project's resources/bin folder.
 */
export function bundledBinDir(options: { isPackaged: boolean; resourcesPath: string; appRoot: string }): string {
  if (options.isPackaged) return path.join(options.resourcesPath, 'bin')
  return path.join(options.appRoot, 'resources', 'bin')
}
