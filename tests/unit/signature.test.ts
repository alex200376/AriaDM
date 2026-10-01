import { describe, expect, it } from 'vitest'

import { verifyInstallerSignature, type SignatureInfo } from '../../src/main/update/signature'

/**
 * The updater downloads an executable and runs it silently. Once the app is
 * signed, a file that is not must not run — that is the whole point of the
 * check. While the app is unsigned there is nothing to compare against, so the
 * check stands aside rather than blocking every update.
 */

const APP = 'C:/Program Files/AriaDM/AriaDM.exe'
const INSTALLER = 'C:/Temp/ariadm-update/AriaDM-0.1.7-setup.exe'
const PUBLISHER = 'CN=SignPath Foundation, O=SignPath Foundation, L=Vienna, C=AT'

function reader(entries: Record<string, SignatureInfo | null>) {
  return async (file: string): Promise<SignatureInfo | null> => entries[file] ?? null
}

describe('verifyInstallerSignature', () => {
  it('stands aside while the running build is unsigned', async () => {
    const verdict = await verifyInstallerSignature({
      appPath: APP,
      installerPath: INSTALLER,
      read: reader({ [APP]: { status: 'NotSigned', subject: '' } })
    })

    expect(verdict).toEqual({ ok: true })
  })

  it('accepts an installer signed by the same publisher as the app', async () => {
    const verdict = await verifyInstallerSignature({
      appPath: APP,
      installerPath: INSTALLER,
      read: reader({
        [APP]: { status: 'Valid', subject: PUBLISHER },
        // Same certificate, different spacing: the comparison ignores that.
        [INSTALLER]: { status: 'Valid', subject: 'CN=SignPath Foundation,O=SignPath  Foundation,L=Vienna,C=AT' }
      })
    })

    expect(verdict.ok).toBe(true)
  })

  it('refuses an unsigned installer once the app is signed', async () => {
    const verdict = await verifyInstallerSignature({
      appPath: APP,
      installerPath: INSTALLER,
      read: reader({
        [APP]: { status: 'Valid', subject: PUBLISHER },
        [INSTALLER]: { status: 'NotSigned', subject: '' }
      })
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/未經簽章/)
  })

  it('refuses a signature that does not verify', async () => {
    const verdict = await verifyInstallerSignature({
      appPath: APP,
      installerPath: INSTALLER,
      read: reader({
        [APP]: { status: 'Valid', subject: PUBLISHER },
        // A HashMismatch means the file changed after it was signed.
        [INSTALLER]: { status: 'HashMismatch', subject: PUBLISHER }
      })
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/HashMismatch/)
  })

  it('refuses an installer signed by somebody else', async () => {
    const verdict = await verifyInstallerSignature({
      appPath: APP,
      installerPath: INSTALLER,
      read: reader({
        [APP]: { status: 'Valid', subject: PUBLISHER },
        [INSTALLER]: { status: 'Valid', subject: 'CN=Somebody Else' }
      })
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/簽章者/)
  })

  it('refuses when the installer cannot be inspected at all', async () => {
    const verdict = await verifyInstallerSignature({
      appPath: APP,
      installerPath: INSTALLER,
      read: reader({ [APP]: { status: 'Valid', subject: PUBLISHER } })
    })

    expect(verdict.ok).toBe(false)
  })
})
