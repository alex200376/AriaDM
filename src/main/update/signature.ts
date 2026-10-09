import { execFile } from 'node:child_process'

import { t } from '@shared/i18n'

/**
 * Checking who signed an update before running it.
 *
 * The updater downloads an executable from the internet and runs it silently, so
 * the byte count and the `MZ` header it already verifies are not the whole story:
 * a signed build should refuse to install an unsigned — or differently signed —
 * file, which is what a hijacked download or a tampered release would look like.
 *
 * The check only applies once the *running* app is signed. An unsigned build has
 * nothing to compare against, and refusing to update until a certificate exists
 * would break the very builds that most need the updater.
 */

export interface SignatureInfo {
  /** `Valid`, `NotSigned`, `HashMismatch`, … straight from Windows. */
  status: string
  /** The signing certificate's subject, or '' when there is none. */
  subject: string
}

/** Reads a file's Authenticode signature. Injectable so decisions are testable. */
export type SignatureReader = (file: string) => Promise<SignatureInfo | null>

/** PowerShell's status for "there is no signature at all". */
const UNSIGNED = new Set(['', 'notsigned', 'unknownerror'])

/**
 * Ask Windows about a file's signature.
 *
 * `Get-AuthenticodeSignature` is the authority here: it is the same check
 * SmartScreen and the installer's own UAC prompt do, and it needs no extra
 * tooling on a Windows machine.
 */
export function readAuthenticode(file: string): Promise<SignatureInfo | null> {
  // Single-quoted for PowerShell, with any single quote in the path doubled.
  const quoted = `'${file.replace(/'/g, "''")}'`
  const script =
    `$s = Get-AuthenticodeSignature -LiteralPath ${quoted}; ` +
    `$subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }; ` +
    `ConvertTo-Json -Compress @{ status = $s.Status.ToString(); subject = $subject }`

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as { status?: unknown; subject?: unknown }
          resolve({
            status: typeof parsed.status === 'string' ? parsed.status : '',
            subject: typeof parsed.subject === 'string' ? parsed.subject : ''
          })
        } catch {
          resolve(null)
        }
      }
    )
  })
}

/** Compare two certificate subjects without caring about spacing or case. */
function samePublisher(left: string, right: string): boolean {
  const normalise = (value: string): string => value.toLowerCase().replace(/\s+/g, '')
  return normalise(left) === normalise(right)
}

export interface VerifyOptions {
  /** The running executable, i.e. `app.getPath('exe')`. */
  appPath: string
  /** The downloaded installer about to be launched. */
  installerPath: string
  read?: SignatureReader
}

/**
 * May this installer run?
 *
 * Returns `ok: true` for an unsigned app as well as for a correctly signed
 * installer, so the only failures are the ones worth stopping for: the app is
 * signed and the update is not, is signed by somebody else, or has been altered
 * since it was signed.
 */
export async function verifyInstallerSignature(options: VerifyOptions): Promise<{ ok: boolean; reason?: string }> {
  const read = options.read ?? readAuthenticode

  const app = await read(options.appPath).catch(() => null)
  if (!app || UNSIGNED.has(app.status.toLowerCase())) {
    // No certificate to compare against yet; the byte-count and MZ checks in the
    // updater remain the only guarantees, which is the status quo.
    return { ok: true }
  }

  const installer = await read(options.installerPath).catch(() => null)
  if (!installer) return { ok: false, reason: t('update.signatureUnreadable') }

  const status = installer.status.toLowerCase()
  if (UNSIGNED.has(status)) return { ok: false, reason: t('update.signatureMissing') }
  if (status !== 'valid') return { ok: false, reason: t('update.signatureStatus', { status: installer.status }) }
  if (!samePublisher(app.subject, installer.subject)) {
    return { ok: false, reason: t('update.signaturePublisherMismatch') }
  }

  return { ok: true }
}
