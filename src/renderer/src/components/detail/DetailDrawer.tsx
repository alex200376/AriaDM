import { Copy, ExternalLink, FolderOpen, Link2, Pause, Play, RotateCw, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'

import type { DownloadItem, PeerInfo, PieceMap, ServerInfo } from '@shared/download'
import { etaOf, groupPieces, progressOf } from '@shared/download'
import type { TranslationKey } from '@shared/i18n'
import {
  formatBytes,
  formatBytesPair,
  formatDateTime,
  formatEta,
  formatPercent,
  formatSpeed,
  parseSize
} from '@shared/format'

import { cn } from '../../lib/cn'
// Every string in the panel is resolved during render, so binding the
// translator to the active locale here is what carries a language change into it
// while the drawer stays open.
import { useTranslation } from '../../lib/i18n'
import { errorDetail, kindLabel, sourceLabel, statusLabel, statusTone } from '../../lib/labels'
import { useApp } from '../../store/app-store'
import { ProgressBar } from '../downloads/ProgressBar'
import { Badge, Button, EmptyState, Field, IconButton, Input } from '../ui/primitives'

type Tab = 'overview' | 'files' | 'pieces' | 'peers' | 'servers' | 'options'

/**
 * Docked on a wide window, floating over the list on a narrower one.
 *
 * A 400px panel that always steals space from the table leaves the table
 * unreadable in a small window — which is the size the app opens at. 1360px is
 * where the sidebar, the panel and the table's columns all still fit.
 */
// Written out in full rather than composed from a prefix: Tailwind finds classes
// by scanning source text, so an interpolated `min-[1360px]:` would never be
// generated.
const DRAWER_CLASS = cn(
  'absolute inset-y-0 right-0 z-40 flex w-[min(400px,92vw)] flex-col border-l border-line bg-surface shadow-2xl',
  'min-[1360px]:static min-[1360px]:z-auto min-[1360px]:shrink-0 min-[1360px]:shadow-none'
)

const TABS: { key: Tab; label: TranslationKey }[] = [
  { key: 'overview', label: 'detail.tab.overview' },
  { key: 'files', label: 'detail.tab.files' },
  { key: 'pieces', label: 'detail.tab.pieces' },
  { key: 'peers', label: 'detail.tab.peers' },
  { key: 'servers', label: 'detail.tab.servers' },
  { key: 'options', label: 'detail.tab.options' }
]

/** Render a byte count back into something a person can edit: 2M, 500K, empty. */
function bytesToSizeInput(bytes: number): string {
  if (bytes <= 0) return ''
  for (const [suffix, factor] of [
    ['G', 1024 ** 3],
    ['M', 1024 ** 2],
    ['K', 1024]
  ] as const) {
    if (bytes >= factor) {
      const value = bytes / factor
      return `${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}`
    }
  }
  return String(bytes)
}

function InfoRow({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="shrink-0 text-[11.5px] text-faint">{label}</span>
      <span
        className={cn('min-w-0 break-all text-right text-[12px] text-fg', mono && 'font-mono text-[11px]')}
        data-selectable
      >
        {children}
      </span>
    </div>
  )
}

function OverviewTab({ item }: { item: DownloadItem }): JSX.Element {
  const { t } = useTranslation()
  const fraction = progressOf(item)
  const eta = etaOf(item)

  return (
    <div className="space-y-4">
      {item.status === 'error' && item.errorCode !== 0 && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 p-3">
          <p className="text-[12.5px] font-medium text-danger">{errorDetail(item.errorCode, item.errorMessage)}</p>
          <div className="mt-2">
            <Button
              variant="danger"
              size="sm"
              icon={<RotateCw size={13} />}
              onClick={() => void useApp.getState().retryGids([item.gid])}
            >
              {t('detail.retry')}
            </Button>
          </div>
        </div>
      )}

      <div>
        <ProgressBar
          fraction={fraction}
          status={item.status}
          indeterminate={item.metadataPending || (item.status === 'active' && item.totalLength === 0)}
        />
        <div className="mt-2 flex items-center justify-between text-[11.5px] text-muted">
          <span className="text-tabular">{item.metadataPending ? t('table.metadataPending') : formatPercent(fraction)}</span>
          <span className="text-tabular">
            {item.totalLength > 0
              ? formatBytesPair(item.completedLength, item.totalLength)
              : formatBytes(item.completedLength)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-line bg-elevated/60 p-2.5">
          <p className="text-[10.5px] text-faint">{t('detail.speed')}</p>
          <p className="text-tabular mt-0.5 text-[15px] font-semibold text-fg">{formatSpeed(item.downloadSpeed)}</p>
        </div>
        <div className="rounded-lg border border-line bg-elevated/60 p-2.5">
          <p className="text-[10.5px] text-faint">{t('detail.eta')}</p>
          <p className="text-tabular mt-0.5 text-[15px] font-semibold text-fg">
            {item.status === 'active' ? formatEta(eta) : '—'}
          </p>
        </div>
        <div className="rounded-lg border border-line bg-elevated/60 p-2.5">
          <p className="text-[10.5px] text-faint">{t('detail.connections')}</p>
          <p className="text-tabular mt-0.5 text-[15px] font-semibold text-fg">{item.connections}</p>
        </div>
        <div className="rounded-lg border border-line bg-elevated/60 p-2.5">
          <p className="text-[10.5px] text-faint">{t('detail.uploadSpeed')}</p>
          <p className="text-tabular mt-0.5 text-[15px] font-semibold text-fg">
            {item.uploadSpeed > 0 ? formatSpeed(item.uploadSpeed) : '—'}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-elevated/40 px-3 py-1.5">
        <InfoRow label={t('detail.status')}>
          <Badge tone={statusTone(item.status)} dot>
            {statusLabel(item.status)}
          </Badge>
        </InfoRow>
        <InfoRow label={t('detail.kind')}>{kindLabel(item.kind)}</InfoRow>
        <InfoRow label={t('detail.engine')}>{item.engine === 'ytdlp' ? 'yt-dlp' : 'aria2'}</InfoRow>
        <InfoRow label={t('detail.category')}>{item.category}</InfoRow>
        <InfoRow label={t('detail.source')}>{sourceLabel(item.source)}</InfoRow>
        {item.tags.length > 0 && (
          <InfoRow label={t('detail.tags')}>
            <span className="flex flex-wrap justify-end gap-1">
              {item.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </span>
          </InfoRow>
        )}
        <InfoRow label={t('detail.dir')} mono>
          {item.dir}
        </InfoRow>
        {item.files.length === 1 && (
          <InfoRow label={t('detail.file')} mono>
            {item.files[0]!.path}
          </InfoRow>
        )}
        <InfoRow label={t('detail.addedAt')}>{formatDateTime(item.addedAt)}</InfoRow>
        {item.completedAt && <InfoRow label={t('detail.completedAt')}>{formatDateTime(item.completedAt)}</InfoRow>}
        {item.mediaFormat && <InfoRow label={t('detail.media.format')}>{item.mediaFormat}</InfoRow>}
        {item.infoHash && (
          <InfoRow label={t('detail.infoHash')} mono>
            {item.infoHash}
          </InfoRow>
        )}
        {item.bittorrent?.mode && <InfoRow label={t('detail.torrentMode')}>{item.bittorrent.mode}</InfoRow>}
        {item.numSeeders > 0 && <InfoRow label={t('detail.seeders')}>{item.numSeeders}</InfoRow>}
      </div>

      {item.bittorrent && item.bittorrent.announceList.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
            {t('detail.tracker')}
          </p>
          <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-line bg-elevated/40 p-2.5">
            {item.bittorrent.announceList.flatMap((tier, tierIndex) =>
              tier.map((url) => (
                <p key={`${tierIndex}-${url}`} className="truncate font-mono text-[10.5px] text-muted" title={url}>
                  {url}
                </p>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FilesTab({ item }: { item: DownloadItem }): JSX.Element {
  const { t } = useTranslation()

  if (item.files.length === 0) {
    return (
      <EmptyState
        icon={<span className="text-[16px]">≡</span>}
        title={t('detail.files.empty.title')}
        body={t('detail.files.empty.body')}
      />
    )
  }

  return (
    <div className="space-y-2">
      {item.files.map((file) => {
        const fraction = file.length > 0 ? file.completedLength / file.length : 0
        return (
          <div key={`${file.index}-${file.path}`} className="rounded-lg border border-line bg-elevated/40 p-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-[12px] text-fg" title={file.path} data-selectable>
                {file.name || file.path}
              </span>
              <span className="text-tabular shrink-0 text-[11px] text-muted">{formatBytes(file.length)}</span>
            </div>
            <div className="mt-2">
              <ProgressBar fraction={fraction} status={item.status} />
            </div>
            {!file.selected && <p className="mt-1.5 text-[10.5px] text-faint">{t('detail.files.unselected')}</p>}
          </div>
        )
      })}
    </div>
  )
}

function PeersTab({ item }: { item: DownloadItem }): JSX.Element {
  const { t } = useTranslation()
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.downloads
      .getPeers(item.gid)
      .then((result) => {
        if (!cancelled) setPeers(result)
      })
      .catch(() => {
        if (!cancelled) setPeers([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [item.gid])

  if (item.kind !== 'bittorrent') {
    return (
      <EmptyState
        icon={<span className="text-[16px]">⊞</span>}
        title={t('detail.peers.torrentOnly.title')}
        body={t('detail.peers.torrentOnly.body')}
      />
    )
  }

  if (loading && peers.length === 0) {
    return <p className="py-6 text-center text-[12px] text-faint">{t('detail.peers.loading')}</p>
  }

  if (peers.length === 0) {
    return (
      <EmptyState
        icon={<span className="text-[16px]">⬡</span>}
        title={t('detail.peers.none.title')}
        body={t('detail.peers.none.body')}
      />
    )
  }

  return (
    <div className="space-y-1.5">
      {peers.map((peer) => (
        <div
          key={`${peer.peerId}-${peer.ip}:${peer.port}`}
          className="flex items-center justify-between gap-3 rounded-lg border border-line bg-elevated/40 px-2.5 py-2"
        >
          <div className="min-w-0">
            <p className="truncate font-mono text-[11px] text-fg">
              {peer.ip}:{peer.port}
            </p>
            <p className="truncate font-mono text-[10px] text-faint">{peer.peerId}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-tabular text-[11px] text-fg">↓ {formatSpeed(peer.downloadSpeed)}</p>
            <p className="text-tabular text-[10px] text-faint">↑ {formatSpeed(peer.uploadSpeed)}</p>
          </div>
          <Badge tone={peer.seeder ? 'ok' : 'muted'}>
            {peer.seeder ? t('detail.peers.seeder') : t('detail.peers.leecher')}
          </Badge>
        </div>
      ))}
    </div>
  )
}

/**
 * Piece view.
 *
 * aria2 reports a bitfield for segmented HTTP downloads as well as for
 * BitTorrent, so this is a per-segment view for either kind rather than a
 * torrent-only one. It polls only while the download is moving: the bitfield is
 * proportional to the piece count and a settled map never changes.
 */
function PiecesTab({ item }: { item: DownloadItem }): JSX.Element {
  const { t } = useTranslation()
  const [map, setMap] = useState<PieceMap | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        const next = await window.api.downloads.getPieces(item.gid)
        if (cancelled) return
        setMap(next)
        setError('')
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    if (item.status !== 'active') {
      return () => {
        cancelled = true
      }
    }

    const timer = window.setInterval(() => void load(), 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [item.gid, item.status])

  if (loading && !map) return <p className="py-6 text-center text-[12px] text-faint">{t('detail.pieces.loading')}</p>

  if (error) {
    return (
      <EmptyState
        icon={<span className="text-[16px]">!</span>}
        title={t('detail.pieces.error.title')}
        body={error}
      />
    )
  }

  if (!map) {
    return (
      <EmptyState
        icon={<span className="text-[16px]">▦</span>}
        title={t('detail.pieces.empty.title')}
        body={t('detail.pieces.empty.body')}
      />
    )
  }

  const groups = groupPieces(map.pieces, 512)
  const reached = map.numPieces > 0 ? (map.completedPieces / map.numPieces) * 100 : 0
  const perCell = groups[0]?.total ?? 1
  const tiles: [string, string][] = [
    [t('detail.pieces.count'), `${map.completedPieces} / ${map.numPieces}`],
    [t('detail.pieces.pieceLength'), formatBytes(map.pieceLength)],
    [t('detail.pieces.progress'), `${reached.toFixed(1)}%`]
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-line bg-elevated/40 px-2.5 py-2">
            <p className="text-[10.5px] text-faint">{label}</p>
            <p className="text-tabular mt-0.5 text-[12.5px] text-fg">{value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-line bg-elevated/30 p-2.5">
        <div className="grid gap-[2px]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(7px, 1fr))' }}>
          {groups.map((group, index) => (
            <span
              key={index}
              className={cn(
                'h-2.5 rounded-[2px]',
                group.complete === group.total ? 'bg-ok' : group.complete > 0 ? 'bg-brand' : 'bg-line'
              )}
              title={t('detail.pieces.cellTitle', {
                from: index * perCell + 1,
                to: index * perCell + group.total,
                done: group.complete,
                total: group.total
              })}
            />
          ))}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-faint">
        {t('detail.pieces.legend', { count: perCell })}
        {map.numPieces > groups.length &&
          ` ${t('detail.pieces.merged', { pieces: map.numPieces, cells: groups.length })}`}
      </p>
    </div>
  )
}

function ServersTab({ item }: { item: DownloadItem }): JSX.Element {
  const { t } = useTranslation()
  const [servers, setServers] = useState<ServerInfo[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.downloads
      .getServers(item.gid)
      .then((result) => {
        if (!cancelled) setServers(result)
      })
      .catch(() => {
        if (!cancelled) setServers([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [item.gid])

  const uris = item.files.flatMap((file) => file.uris)

  if (loading && servers.length === 0 && uris.length === 0) {
    return <p className="py-6 text-center text-[12px] text-faint">{t('detail.servers.loading')}</p>
  }

  return (
    <div className="space-y-3">
      {servers.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
            {t('detail.servers.active')}
          </p>
          <div className="space-y-1.5">
            {servers.map((server) => (
              <div key={server.index} className="rounded-lg border border-line bg-elevated/40 p-2.5">
                <p className="truncate font-mono text-[11px] text-fg" title={server.currentUri} data-selectable>
                  {server.currentUri}
                </p>
                <p className="text-tabular mt-1 text-[11px] text-muted">↓ {formatSpeed(server.downloadSpeed)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {uris.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
            {t('detail.servers.uris')}
            {uris.length > 1 && ` · ${t('detail.servers.mirrors', { count: uris.length })}`}
          </p>
          <div className="space-y-1">
            {uris.map((uri, index) => (
              <div
                key={`${index}-${uri.uri}`}
                className="flex items-center gap-2 rounded border border-line/70 bg-elevated/30 px-2 py-1.5"
              >
                <span
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', uri.status === 'used' ? 'bg-ok' : 'bg-faint')}
                  title={uri.status === 'used' ? t('detail.servers.used') : t('detail.servers.idle')}
                />
                <span className="truncate font-mono text-[10.5px] text-muted" title={uri.uri} data-selectable>
                  {uri.uri}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {servers.length === 0 && uris.length === 0 && (
        <EmptyState
          icon={<span className="text-[16px]">⊞</span>}
          title={t('detail.servers.empty')}
          body={t('detail.servers.empty.body')}
        />
      )}
    </div>
  )
}

function OptionsTab({ item }: { item: DownloadItem }): JSX.Element {
  const { t } = useTranslation()
  const changeOptions = useApp((state) => state.changeOptions)
  const [limit, setLimit] = useState(bytesToSizeInput(item.maxDownloadLimit))
  const [split, setSplit] = useState(String(item.split))
  const [raw, setRaw] = useState<Record<string, string>>({})

  useEffect(() => {
    setLimit(bytesToSizeInput(item.maxDownloadLimit))
    setSplit(String(item.split))
  }, [item.gid, item.maxDownloadLimit, item.split])

  useEffect(() => {
    let cancelled = false
    window.api.downloads
      .getOptions(item.gid)
      .then((result) => {
        if (!cancelled) setRaw(result)
      })
      .catch(() => {
        if (!cancelled) setRaw({})
      })
    return () => {
      cancelled = true
    }
  }, [item.gid])

  const settled = item.status === 'complete' || item.status === 'error'
  const parsedLimit = limit.trim() === '' ? 0 : (parseSize(limit) ?? 0)

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-line bg-elevated/40 p-2.5 text-[11px] leading-relaxed text-muted">
        {t('detail.options.note')}
        {settled && ` ${t('detail.options.noteSettled')}`}
      </p>

      <Field label={t('detail.option.maxDownloadLimit')} hint={t('detail.options.limitHint')}>
        <Input
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
          placeholder={t('common.unlimited')}
          disabled={settled}
        />
      </Field>

      <Field label={t('detail.option.split')} hint={t('detail.options.splitHint')}>
        <Input value={split} onChange={(event) => setSplit(event.target.value)} disabled={settled} />
      </Field>

      <Button
        variant="primary"
        size="sm"
        disabled={settled}
        onClick={() =>
          void changeOptions(item.gid, {
            maxDownloadLimit: parsedLimit,
            split: Number(split) || item.split
          })
        }
      >
        {t('detail.options.save')}
      </Button>

      {Object.keys(raw).length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
            {t('detail.options.engineList')}
          </p>
          <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-line bg-elevated/40 p-2.5">
            {Object.entries(raw)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => (
                <div key={key} className="flex items-start justify-between gap-3 text-[10.5px]">
                  <span className="font-mono text-faint">{key}</span>
                  <span className="truncate font-mono text-muted" title={value} data-selectable>
                    {value || t('detail.options.blank')}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function DetailDrawer(): JSX.Element | null {
  const { t } = useTranslation()
  const gid = useApp((state) => state.detailGid)
  const item = useApp((state) => state.items.find((entry) => entry.gid === state.detailGid))
  const openDetail = useApp((state) => state.openDetail)
  const pauseGids = useApp((state) => state.pauseGids)
  const resumeGids = useApp((state) => state.resumeGids)
  const retryGids = useApp((state) => state.retryGids)
  const removeGids = useApp((state) => state.removeGids)
  const openFile = useApp((state) => state.openFile)
  const showInFolder = useApp((state) => state.showInFolder)
  const copyLink = useApp((state) => state.copyLink)

  const [tab, setTab] = useState<Tab>('overview')

  const close = useCallback(() => openDetail(null), [openDetail])

  useEffect(() => {
    setTab('overview')
  }, [gid])

  if (!gid) return null

  if (!item) {
    return (
      <aside className={DRAWER_CLASS}>
        <header className="flex h-11 items-center justify-between border-b border-line px-3">
          <span className="text-[13px] font-medium text-fg">{t('detail.title')}</span>
          <IconButton label={t('common.close')} icon={<X size={15} />} onClick={close} />
        </header>
        <EmptyState
          icon={<span className="text-[16px]">?</span>}
          title={t('detail.missing.title')}
          body={t('detail.missing.body')}
        />
      </aside>
    )
  }

  const isActive = item.status === 'active'
  const isComplete = item.status === 'complete'
  const isError = item.status === 'error'
  const uri = item.files[0]?.uris?.[0]?.uri

  return (
    <>
      {/* Below the dock breakpoint the drawer floats over the list, so it needs a
          backdrop that also serves as the click-to-close target. */}
      <div
        className="absolute inset-0 z-30 bg-black/40 min-[1360px]:hidden"
        onClick={close}
        aria-hidden
      />
      <aside className={DRAWER_CLASS}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <span className="truncate text-[13px] font-medium text-fg" title={item.name}>
          {item.name}
        </span>
        <IconButton label={t('common.close')} icon={<X size={15} />} onClick={close} />
      </header>

      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        {isActive ? (
          <IconButton label={t('table.pause')} icon={<Pause size={15} />} onClick={() => void pauseGids([item.gid])} />
        ) : (
          <IconButton
            label={isError ? t('common.retry') : t('table.resume')}
            icon={isError ? <RotateCw size={15} /> : <Play size={15} />}
            onClick={() => void (isError ? retryGids([item.gid]) : resumeGids([item.gid]))}
          />
        )}
        {/* Open file used to reuse the Play triangle, which sits right beside the
            Start button and made the two look like the same action. It is an
            export-affordance rather than a queue control, so it borrows the
            ExternalLink icon the download row already uses for opening a file. */}
        <IconButton
          label={t('detail.openFile')}
          icon={<ExternalLink size={15} />}
          disabled={!isComplete}
          onClick={() => void openFile(item.gid)}
        />
        <IconButton
          label={t('detail.showInFolder')}
          icon={<FolderOpen size={15} />}
          onClick={() => void showInFolder(item.gid)}
        />
        <IconButton
          label={t('detail.copyLink')}
          icon={<Copy size={15} />}
          disabled={!uri}
          onClick={() => void copyLink(item.gid)}
        />
        <div className="flex-1" />
        <IconButton
          label={t('common.remove')}
          icon={<Trash2 size={15} />}
          onClick={() => void removeGids([item.gid], false)}
        />
      </div>

      <nav className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[11.5px] transition-colors',
              tab === entry.key ? 'bg-brand/15 text-brand' : 'text-muted hover:bg-line/40 hover:text-fg'
            )}
          >
            {t(entry.label)}
          </button>
        ))}
      </nav>

      {uri && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-elevated/30 px-3 py-1.5">
          <Link2 size={12} className="shrink-0 text-faint" />
          <span className="truncate font-mono text-[10.5px] text-faint" title={uri} data-selectable>
            {uri}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'overview' && <OverviewTab item={item} />}
        {tab === 'files' && <FilesTab item={item} />}
        {tab === 'pieces' && <PiecesTab item={item} />}
        {tab === 'peers' && <PeersTab item={item} />}
        {tab === 'servers' && <ServersTab item={item} />}
        {tab === 'options' && <OptionsTab item={item} />}
      </div>
      </aside>
    </>
  )
}
