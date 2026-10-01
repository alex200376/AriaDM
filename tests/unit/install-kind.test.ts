import { describe, expect, it } from 'vitest'

import { detectInstallInfo } from '../../src/main/update/install-kind'

/**
 * Getting this wrong is what made an update look like it did nothing: a
 * per-machine install in Program Files needs administrator rights to replace,
 * and the silent installer's own UAC prompt is invisible once the app has
 * already quit.
 */

const BASE = {
  platform: 'win32' as const,
  isPackaged: true,
  env: {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)'
  }
}

describe('detectInstallInfo', () => {
  it('treats the portable build as portable, with nothing to install over', () => {
    const info = detectInstallInfo({
      ...BASE,
      env: { ...BASE.env, PORTABLE_EXECUTABLE_DIR: 'D:\\Downloads' },
      exePath: 'D:\\Downloads\\AriaDM-0.1.7-portable.exe'
    })

    expect(info.kind).toBe('portable')
    expect(info.needsElevation).toBe(false)
    expect(info.modeFlag).toBe('')
  })

  it('treats an unpackaged run as a development build', () => {
    const info = detectInstallInfo({
      ...BASE,
      isPackaged: false,
      exePath: 'C:/AriaDM/node_modules/electron/dist/electron.exe'
    })

    expect(info.kind).toBe('dev')
    expect(info.needsElevation).toBe(false)
  })

  it('classifies a Program Files install as per-machine, needing elevation', () => {
    const info = detectInstallInfo({
      ...BASE,
      exePath: 'C:/Program Files/AriaDM/AriaDM.exe',
      // Even a writable directory there is still a machine install: the mode
      // comes from where the app lives, not from the ACL of the moment.
      isWritable: () => true
    })

    expect(info.kind).toBe('machine')
    expect(info.needsElevation).toBe(true)
    // Stated outright rather than left to NSIS's own registry sniffing.
    expect(info.modeFlag).toBe('/allusers')
    // `dir` is `path.dirname(exePath)` verbatim, so it keeps the input's separators.
    expect(info.dir).toBe('C:/Program Files/AriaDM')
  })

  it('classifies a per-user install as needing no elevation and no mode flag', () => {
    const info = detectInstallInfo({
      ...BASE,
      exePath: 'C:/Users/me/AppData/Local/Programs/AriaDM/AriaDM.exe',
      isWritable: () => true
    })

    expect(info.kind).toBe('user')
    expect(info.needsElevation).toBe(false)
    // Left to NSIS: the previous install already records how it was made.
    expect(info.modeFlag).toBe('')
  })

  it('treats an install it cannot write to as needing elevation', () => {
    const info = detectInstallInfo({
      ...BASE,
      exePath: 'D:/Apps/AriaDM/AriaDM.exe',
      isWritable: () => false
    })

    expect(info.kind).toBe('machine')
    expect(info.needsElevation).toBe(true)
    expect(info.modeFlag).toBe('/allusers')
  })
})
