import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderIcon } from './lib/icon-png.mjs'

/**
 * Assemble loadable extension folders from one shared source.
 *
 * Chrome and Firefox both implement MV3 but disagree on how a background script
 * is declared: Chrome requires a service worker, Firefox an event page via
 * `background.scripts`. Everything else is identical, so the shared code lives
 * in `src/` and only the manifest differs.
 */
const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const extensionRoot = path.join(projectRoot, 'resources', 'extension')
const srcDir = path.join(extensionRoot, 'src')

const SHARED_FILES = [
  'background.js',
  'pairing.js',
  'request.js',
  'urls.js',
  'formats.js',
  'popup.html',
  'popup.js',
  'content.js',
  'content.css',
  'media-sites.json'
]

/**
 * The two manifests.
 *
 * The host list is not baked in here any more: the content script applies it at
 * runtime from media-sites.json (see the note on `matches` below), so this stays
 * a pure function of the platform.
 */
function buildManifests() {
  const contentScripts = [
    {
      /*
       * `<all_urls>`, with the host list applied in the script itself.
       *
       * Restricting the match patterns to the media hosts misses the single most
       * common layout: a player embedded in an iframe on some unrelated page.
       * The iframe's own origin is the media host, so the script runs there, sees
       * the real video and shows the panel — but only if it was allowed to run in
       * that frame at all. The host check in content.js is what keeps every other
       * page untouched, and it reads media-sites.json so the app, the extension
       * and this manifest still cannot drift apart.
       *
       * `<all_urls>` is already requested for download interception, so this does
       * not widen what the extension is allowed to access.
       */
      matches: ['<all_urls>'],
      // formats.js first: the panel builds its menu rows with it.
      js: ['formats.js', 'content.js'],
      css: ['content.css'],
      run_at: 'document_idle',
      // Each frame looks for its own player.
      all_frames: true
    }
  ]

  const chromeManifest = {
    manifest_version: 3,
    name: 'AriaDM 下載助手',
    version: '1.0.0',
    description: '把連結與瀏覽器下載直接交給 AriaDM。',
    // `alarms` keeps the pairing self-healing: the extension re-checks every
    // minute so it works whether the browser or the app was started first.
    permissions: ['contextMenus', 'storage', 'cookies', 'downloads', 'notifications', 'scripting', 'activeTab', 'tabs', 'alarms'],
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*', '<all_urls>'],
    background: { service_worker: 'background.js' },
    action: { default_popup: 'popup.html', default_title: 'AriaDM' },
    content_scripts: contentScripts,
    icons: { 16: 'icon16.png', 48: 'icon48.png', 128: 'icon128.png' }
  }

  const firefoxManifest = {
    manifest_version: 3,
    name: 'AriaDM 下載助手',
    version: '1.0.0',
    description: '把連結與瀏覽器下載直接交給 AriaDM。',
    permissions: ['contextMenus', 'storage', 'cookies', 'downloads', 'notifications', 'scripting', 'activeTab', 'tabs', 'alarms'],
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*', '<all_urls>'],
    // Firefox implements MV3 with an event page; it does not run a service
    // worker. Scripts share one global scope and load in order, so request.js and
    // pairing.js define their globals before background.js runs.
    background: { scripts: ['request.js', 'pairing.js', 'background.js'] },
    action: { default_popup: 'popup.html', default_title: 'AriaDM' },
    content_scripts: contentScripts,
    icons: { 16: 'icon16.png', 48: 'icon48.png', 128: 'icon128.png' },
    browser_specific_settings: { gecko: { id: 'ariadm@local', strict_min_version: '115.0' } }
  }

  return { chromeManifest, firefoxManifest }
}

async function writeIcons(destination) {
  // Real PNGs, not SVG: browsers do not accept an SVG as an extension icon, and
  // a missing icon makes an unpacked extension render as a grey puzzle piece.
  for (const size of [16, 48, 128]) {
    await fsp.writeFile(path.join(destination, `icon${size}.png`), renderIcon(size))
  }
}

async function buildVariant(name, manifest) {
  const destination = path.join(extensionRoot, name)
  await fsp.rm(destination, { recursive: true, force: true })
  await fsp.mkdir(destination, { recursive: true })

  for (const file of SHARED_FILES) {
    await fsp.copyFile(path.join(srcDir, file), path.join(destination, file))
  }
  await fsp.writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeIcons(destination)
  return destination
}

async function main() {
  if (!existsSync(srcDir)) throw new Error(`找不到擴充功能原始碼：${srcDir}`)

  const sites = JSON.parse(await fsp.readFile(path.join(srcDir, 'media-sites.json'), 'utf8'))
  if (!Array.isArray(sites) || sites.length === 0) throw new Error('media-sites.json 是空的')

  const { chromeManifest, firefoxManifest } = buildManifests()
  const chromeDir = await buildVariant('chrome', chromeManifest)
  const firefoxDir = await buildVariant('firefox', firefoxManifest)

  const digest = createHash('sha256')
  for (const file of SHARED_FILES) {
    digest.update(await fsp.readFile(path.join(srcDir, file)))
  }

  console.log(`已組裝擴充功能（${sites.length} 個影音網站）：`)
  console.log(`  Chrome / Edge  ${path.relative(projectRoot, chromeDir)}`)
  console.log(`  Firefox        ${path.relative(projectRoot, firefoxDir)}`)
  console.log(`  共用原始碼雜湊  ${digest.digest('hex').slice(0, 16)}`)
  console.log('  說明：resources/extension/README.md')
}

await main()
