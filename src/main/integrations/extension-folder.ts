import fs from 'node:fs'
import path from 'node:path'

/**
 * Which extension folder to open for a browser.
 *
 * The extension directory holds one build per browser and each build's
 * `manifest.json` sits inside its own subfolder — the parent has none at all.
 * Opening the parent therefore made "load unpacked" impossible to finish: the
 * file picker that opens has nothing to select.
 *
 * The fallback matters for a source checkout, where the builds are produced by
 * `npm run build:extension` and may not exist yet. Opening the root is useless
 * for loading, but it is at least a folder the user can see, and it beats an
 * error about a path that does not exist.
 */
export function extensionFolderFor(
  extensionDir: string,
  browser: 'chrome' | 'firefox' | undefined
): string {
  const target = path.join(extensionDir, browser === 'firefox' ? 'firefox' : 'chrome')
  return fs.existsSync(target) ? target : extensionDir
}
