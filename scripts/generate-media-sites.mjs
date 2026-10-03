import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Keep the extension's host list in step with the app's.
 *
 * The extension is plain JavaScript with no bundler, so it cannot import
 * `src/shared/media-sites.ts` and has to carry a copy of the host list as JSON.
 * That copy drifting from the app is the bug this script prevents: the
 * TypeScript array is the single source of truth, and this writes the JSON from
 * it. `tests/unit/media-sites.test.ts` also asserts the two are equal, so a
 * drift is caught by the test suite as well.
 *
 * Usage:
 *   node scripts/generate-media-sites.mjs            # rewrite the JSON
 *   node scripts/generate-media-sites.mjs --check    # fail if it is out of date
 *   node scripts/generate-media-sites.mjs --candidates  # list yt-dlp hosts we lack
 *
 * The `--candidates` mode is deliberately advisory. yt-dlp's `--list-extractors`
 * prints extractor *names*, and only about seventy of the ~1750 are a bare
 * domain; the rest are identifiers like `youtube:tab`. There is no portable way
 * to read each extractor's URL pattern from the binary, so this cannot generate
 * the list on its own — it proposes the domains it can see and a human merges
 * the useful ones into `media-sites.ts`.
 */

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceFile = path.join(projectRoot, 'src', 'shared', 'media-sites.ts')
const targetFile = path.join(projectRoot, 'resources', 'extension', 'src', 'media-sites.json')
const ytDlp = path.join(projectRoot, 'resources', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

/** The host array, in the order it appears in the source. */
function readHosts() {
  const source = readFileSync(sourceFile, 'utf8')
  const start = source.indexOf('export const MEDIA_SITE_HOSTS = [')
  if (start === -1) throw new Error('在 media-sites.ts 找不到 MEDIA_SITE_HOSTS')
  const end = source.indexOf('] as const', start)
  if (end === -1) throw new Error('MEDIA_SITE_HOSTS 沒有結束的 ] as const')

  const body = source.slice(start, end)
  const hosts = []
  for (const line of body.split('\n')) {
    // Drop comments so a quoted word inside one is never read as a host.
    const code = line.replace(/\/\/.*$/, '')
    for (const match of code.matchAll(/'([^']+)'/g)) hosts.push(match[1])
  }
  if (hosts.length === 0) throw new Error('MEDIA_SITE_HOSTS 是空的')
  return hosts
}

function serialize(hosts) {
  return `${JSON.stringify(hosts, null, 2)}\n`
}

function candidates(hosts) {
  if (!existsSync(ytDlp)) {
    console.log('找不到 resources/bin 的 yt-dlp，略過候選清單。')
    return
  }
  const output = execFileSync(ytDlp, ['--list-extractors'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const known = new Set(hosts)
  const found = new Set()
  for (const line of output.split('\n')) {
    const name = line.replace(/ \(.*$/, '').trim()
    // A bare domain, not an extractor identifier like `youtube:tab`.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+\.[a-z]{2,}$/.test(name)) continue
    if (known.has(name)) continue
    found.add(name)
  }
  const list = [...found].sort()
  console.log(`yt-dlp 有 ${list.length} 個尚未收錄的網域：`)
  for (const host of list) console.log(`  ${host}`)
}

function main() {
  const hosts = readHosts()
  const args = new Set(process.argv.slice(2))

  if (args.has('--candidates')) {
    candidates(hosts)
    return
  }

  const json = serialize(hosts)
  const current = existsSync(targetFile) ? readFileSync(targetFile, 'utf8') : ''

  if (args.has('--check')) {
    if (current !== json) {
      console.error('media-sites.json 與 media-sites.ts 不同步，請執行 node scripts/generate-media-sites.mjs')
      process.exit(1)
    }
    console.log(`media-sites.json 已同步（${hosts.length} 個網域）。`)
    return
  }

  if (current === json) {
    console.log(`media-sites.json 沒有變更（${hosts.length} 個網域）。`)
    return
  }
  writeFileSync(targetFile, json, 'utf8')
  console.log(`已寫入 media-sites.json（${hosts.length} 個網域）。`)
}

main()
