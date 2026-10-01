import type { DownloadKind, DownloadStatus, EngineState } from '@shared/download'
import { t } from '@shared/i18n'
import { describeAria2Error } from '@shared/aria2-errors'

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'muted' | 'brand'

/**
 * Human labels for the model's enums.
 *
 * These call the module-level `t` rather than taking a translator, because the
 * store keeps that locale in step with the settings *before* the re-render that
 * follows a language change, so every caller gets the right language without
 * having to thread a translator through five components.
 */
export function statusLabel(status: DownloadStatus): string {
  switch (status) {
    case 'active':
      return t('status.active')
    case 'waiting':
      return t('status.waiting')
    case 'paused':
      return t('status.paused')
    case 'complete':
      return t('status.complete')
    case 'error':
      return t('status.error')
    default:
      return t('status.removed')
  }
}

export function statusTone(status: DownloadStatus): Tone {
  switch (status) {
    case 'active':
      return 'brand'
    case 'waiting':
      return 'info'
    case 'paused':
      return 'muted'
    case 'complete':
      return 'ok'
    case 'error':
      return 'danger'
    default:
      return 'muted'
  }
}

export function engineLabel(state: EngineState): string {
  switch (state) {
    case 'ready':
      return t('engine.ready')
    case 'starting':
      return t('engine.starting')
    case 'restarting':
      return t('engine.restarting')
    case 'failed':
      return t('engine.failed')
    default:
      return t('engine.stopped')
  }
}

export function engineTone(state: EngineState): Tone {
  switch (state) {
    case 'ready':
      return 'ok'
    case 'starting':
    case 'restarting':
      return 'warn'
    case 'failed':
      return 'danger'
    default:
      return 'muted'
  }
}

export function kindLabel(kind: DownloadKind): string {
  switch (kind) {
    case 'bittorrent':
      return t('kind.torrent')
    case 'metalink':
      return t('kind.metalink')
    case 'media':
      return t('kind.media')
    case 'ftp':
      return t('kind.ftp')
    default:
      return t('kind.http')
  }
}

export function sourceLabel(source: string): string {
  switch (source) {
    case 'clipboard':
      return t('source.clipboard')
    case 'browser':
      return t('source.browser')
    case 'file':
      return t('source.file')
    case 'protocol':
      return t('source.protocol')
    case 'session':
      return t('source.session')
    case 'retry':
      return t('source.retry')
    case 'schedule':
      return t('source.schedule')
    default:
      return t('source.manual')
  }
}

export function errorSummary(code: number, fallback: string): string {
  const info = describeAria2Error(code, fallback)
  return info.short
}

export function errorDetail(code: number, fallback: string): string {
  return describeAria2Error(code, fallback).detail
}

export function canRetry(code: number): boolean {
  return describeAria2Error(code).retryable
}

/** Short glyph used in the file-type column. */
export function kindGlyph(kind: DownloadKind): string {
  switch (kind) {
    case 'bittorrent':
      return '⬡'
    case 'metalink':
      return '≡'
    case 'media':
      return '▶'
    case 'ftp':
      return '⤓'
    default:
      return '⊞'
  }
}
