import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { extensionFolderFor } from '../../src/main/integrations/extension-folder'

/**
 * The extension is built per browser, and only the subfolder has a manifest.
 * Opening the parent — which is what the button used to do — leaves "load
 * unpacked" with nothing to pick, so these assertions are about the one thing
 * the user does with this button.
 */
describe('extensionFolderFor', () => {
  const created: string[] = []

  function makeExtensionDir(withBuilds: boolean): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadm-ext-'))
    created.push(root)
    if (withBuilds) {
      for (const browser of ['chrome', 'firefox']) {
        const dir = path.join(root, browser)
        fs.mkdirSync(dir)
        fs.writeFileSync(path.join(dir, 'manifest.json'), '{}')
      }
    }
    return root
  }

  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('opens the build folder that actually holds a manifest', () => {
    const root = makeExtensionDir(true)

    expect(extensionFolderFor(root, 'chrome')).toBe(path.join(root, 'chrome'))
    expect(extensionFolderFor(root, 'firefox')).toBe(path.join(root, 'firefox'))
    expect(fs.existsSync(path.join(extensionFolderFor(root, 'firefox'), 'manifest.json'))).toBe(true)
  })

  it('defaults to the Chromium build when the caller names no browser', () => {
    const root = makeExtensionDir(true)

    expect(extensionFolderFor(root, undefined)).toBe(path.join(root, 'chrome'))
  })

  it('falls back to the root when the builds have not been generated', () => {
    const root = makeExtensionDir(false)

    // Better a folder the user can look inside than a path that does not exist.
    expect(extensionFolderFor(root, 'firefox')).toBe(root)
  })
})
