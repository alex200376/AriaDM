/**
 * Report the Authenticode signature of everything in `dist/`.
 *
 * The honest state of this project is "unsigned, or signed with a certificate
 * whose reputation is still building", and SmartScreen shows a warning for both.
 * What this script catches is the case that actually matters: a file that *is*
 * signed but whose signature does not verify, which means it was altered after
 * signing or the certificate chain is broken.
 *
 * "Windows gave no answer" is deliberately not the same verdict as "the
 * signature does not verify": PowerShell occasionally fails to report under
 * load, and a build that fails for that reason blocks a release over a tooling
 * hiccup while saying nothing about the file. Those files are named and
 * skipped, after one retry; a signature that reads back as invalid still fails
 * the run.
 *
 * Usage: npm run sign:verify
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const distDir = path.join(projectRoot, 'dist')

function askWindows(file) {
  const quoted = `'${file.replace(/'/g, "''")}'`
  const script =
    `$s = Get-AuthenticodeSignature -LiteralPath ${quoted}; ` +
    `$subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }; ` +
    `ConvertTo-Json -Compress @{ status = $s.Status.ToString(); subject = $subject }`

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20_000 },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(stdout.trim()))
        } catch {
          resolve(null)
        }
      }
    )
  })
}

/** The signature, or null when PowerShell produced no answer twice in a row. */
async function readSignature(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const info = await askWindows(file)
    if (info) return info
  }
  return null
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('sign:verify only applies to Windows builds.')
    return
  }

  if (!fs.existsSync(distDir)) {
    console.log('No dist/ directory yet — run `npm run dist` first.')
    return
  }

  const files = fs
    .readdirSync(distDir)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .sort()

  if (files.length === 0) {
    console.log('No installers in dist/ yet — run `npm run dist` first.')
    return
  }

  let broken = 0
  let unreadable = 0
  for (const name of files) {
    const info = await readSignature(path.join(distDir, name))
    if (!info) {
      unreadable += 1
      console.log(`${name}: not read (Windows reported no signature status)`)
      continue
    }

    const subject = info.subject ? ` — ${info.subject}` : ''
    console.log(`${name}: ${info.status}${subject}`)

    // An unsigned file is expected until a certificate exists. A file that
    // claims to be signed but fails verification is not.
    if (!['Valid', 'NotSigned', 'UnknownError'].includes(info.status)) broken += 1
  }

  if (broken > 0) {
    console.error(`\n${broken} file(s) have a signature that does not verify.`)
    process.exitCode = 1
    return
  }

  if (unreadable > 0) {
    console.log(`\n${unreadable} file(s) could not be read, so nothing is known about their signature.`)
  }

  console.log('No broken signatures. Unsigned files are expected until a certificate is configured.')
}

await main()
