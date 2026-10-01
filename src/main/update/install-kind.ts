import fs from 'node:fs'
import path from 'node:path'

import type { UpdateInstallKind } from '@shared/ipc'

/**
 * Working out whether an update can be installed quietly, and what to tell the
 * NSIS installer about where to put itself.
 *
 * The failure this prevents: AriaDM installed "for all users" into
 * `C:\Program Files\AriaDM`. A silent upgrade there needs administrator rights,
 * and electron-builder's installer handles that by re-running itself elevated —
 * which raises a UAC prompt that the user never saw, because the app had already
 * closed. Declining or missing it made the installer exit immediately with no
 * window and no message, which is indistinguishable from "the update did
 * nothing". Knowing the install kind lets the UI say what is about to happen
 * before the app quits.
 *
 * The mode flag matters for the same reason. NSIS decides per-machine versus
 * per-user from its own registry key, so a silent run usually gets it right, but
 * only for a previous install it can recognise. Passing `/allusers` states it
 * outright and makes the elevation path deterministic.
 */

export interface InstallInfo {
  kind: UpdateInstallKind
  /** True when replacing the installed files needs administrator rights. */
  needsElevation: boolean
  /** Directory the app runs from, or '' in development. */
  dir: string
  /** Extra installer argument that pins the install mode, or '' to let NSIS decide. */
  modeFlag: string
}

export interface InstallEnvironment {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** Read for `PORTABLE_EXECUTABLE_DIR`, which electron-builder sets for portable builds. */
  env: NodeJS.ProcessEnv
  /** The running executable, i.e. `process.execPath`. */
  exePath: string
  /** Injectable so the classification is testable without Program Files. */
  isWritable?: (dir: string) => boolean
}

/** True when `dir` sits inside one of the given roots, case-insensitively. */
function underAny(dir: string, roots: string[]): boolean {
  const normalized = path.resolve(dir).toLowerCase()
  return roots.some((root) => {
    if (!root) return false
    const base = path.resolve(root).toLowerCase().replace(/[\\/]+$/, '')
    return normalized === base || normalized.startsWith(`${base}${path.sep}`)
  })
}

/**
 * Can this process create a file in `dir` as it is currently running?
 *
 * A real answer matters here: an administrator whose token is not elevated still
 * cannot write to Program Files, and that is precisely the case where the
 * installer will need to elevate.
 */
export function canWriteTo(dir: string): boolean {
  const probe = path.join(dir, `.ariadm-write-test-${process.pid}`)
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' })
    fs.rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

export function detectInstallInfo(environment: InstallEnvironment): InstallInfo {
  const dir = environment.exePath ? path.dirname(environment.exePath) : ''
  const isWritable = environment.isWritable ?? canWriteTo

  // The portable build runs from wherever the user put the single .exe. Running
  // the NSIS installer there would leave a second, installed copy behind, which
  // is why it keeps the manual download instead.
  if (environment.env.PORTABLE_EXECUTABLE_DIR) {
    return { kind: 'portable', needsElevation: false, dir: '', modeFlag: '' }
  }

  if (!environment.isPackaged || !dir) {
    return { kind: 'dev', needsElevation: false, dir, modeFlag: '' }
  }

  const inProgramFiles = underAny(dir, [
    environment.env.ProgramFiles ?? '',
    environment.env['ProgramFiles(x86)'] ?? '',
    environment.env.ProgramW6432 ?? '',
    // A machine install can also be pointed somewhere custom; both of the
    // standard roots are covered above, so anything else falls back to the
    // writability probe.
    'C:\\Program Files',
    'C:\\Program Files (x86)'
  ])

  // Program Files is authoritative when it matches; otherwise the probe decides,
  // because a per-user install under %LOCALAPPDATA% is writable and a locked-down
  // custom directory is not.
  const needsElevation = inProgramFiles || !isWritable(dir)

  return needsElevation
    ? { kind: 'machine', needsElevation: true, dir, modeFlag: '/allusers' }
    : { kind: 'user', needsElevation: false, dir, modeFlag: '' }
}
