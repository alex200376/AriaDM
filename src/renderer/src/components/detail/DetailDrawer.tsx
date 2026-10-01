import { Copy, FolderOpen, Link2, Pause, Play, RotateCw, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'

import type { DownloadItem, PeerInfo, PieceMap, ServerInfo } from '@shared/download'
import { etaOf, groupPieces, progressOf } from '@shared/download'
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

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: '概覽' },
  { key: 'files', label: '檔案' },
  { key: 'pieces', label: '分片' },
  { key: 'peers', label: '節點' },
  { key: 'servers', label: '伺服器' },
  { key: 'options', label: '選項' }
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
              重試下載
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
          <span className="text-tabular">{item.metadataPending ? '取得中繼資料中…' : formatPercent(fraction)}</span>
          <span className="text-tabular">
            {item.totalLength > 0
              ? formatBytesPair(item.completedLength, item.totalLength)
              : formatBytes(item.completedLength)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-line bg-elevated/60 p-2.5">
          <p className="text-[10.5px] text-faint">下載速度</p>
          <p className="text-tabular mt-0.5 text-[15px] font-semibold text-fg">{formatSpeed(item.downloadSpeed)}</p>
        </div>
        <div className="rounded-lg border border-line bg-elevated/60 p-2.5">
          <p className="text-[10.5px] text-faint">剩餘時間</p>
          <p className="text-tabular mt-0.5 text-[15px] font-semibold text-fg">
            {item.status === 'active' ? formatEta(eta) : '—'}
          </p>
        </div>
        <div className="rounded-lg border border-line bg-elevated/60 p-2.5">
          <p className="text-[10.5px] text-faint">連線數</p>
          <p className="text-tabular mt-0.5 text-[15px] font-semibold text-fg">{item.connections}</p>
        </div>
        <div className="rounded-lg border border-line bg-elevated/60 p-2.5">
          <p className="text-[10.5px] text-faint">上傳速度</p>
          <p className="text-tabular mt-0.5 text-[15px] font-semibold text-fg">
            {item.uploadSpeed > 0 ? formatSpeed(item.uploadSpeed) : '—'}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-elevated/40 px-3 py-1.5">
        <InfoRow label="狀態">
          <Badge tone={statusTone(item.status)} dot>
            {statusLabel(item.status)}
          </Badge>
        </InfoRow>
        <InfoRow label="類型">{kindLabel(item.kind)}</InfoRow>
        <InfoRow label="引擎">{item.engine === 'ytdlp' ? 'yt-dlp' : 'aria2'}</InfoRow>
        <InfoRow label="分類">{item.category}</InfoRow>
        <InfoRow label="來源">{sourceLabel(item.source)}</InfoRow>
        <InfoRow label="儲存位置" mono>
          {item.dir}
        </InfoRow>
        {item.files.length === 1 && (
          <InfoRow label="檔案" mono>
            {item.files[0]!.path}
          </InfoRow>
        )}
        <InfoRow label="加入時間">{formatDateTime(item.addedAt)}</InfoRow>
        {item.completedAt && <InfoRow label="完成時間">{formatDateTime(item.completedAt)}</InfoRow>}
        {item.mediaFormat && <InfoRow label="格式">{item.mediaFormat}</InfoRow>}
        {item.infoHash && (
          <InfoRow label="Info hash" mono>
            {item.infoHash}
          </InfoRow>
        )}
        {item.bittorrent?.mode && <InfoRow label="種子模式">{item.bittorrent.mode}</InfoRow>}
        {item.numSeeders > 0 && <InfoRow label="種子數">{item.numSeeders}</InfoRow>}
      </div>

      {item.bittorrent && item.bittorrent.announceList.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Tracker</p>
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
  if (item.files.length === 0) {
    return (
      <EmptyState
        icon={<span className="text-[16px]">≡</span>}
        title="尚無檔案資訊"
        body="種子或 Metalink 下載在取得中繼資料後才會列出檔案。"
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
            {!file.selected && <p className="mt-1.5 text-[10.5px] text-faint">未選取下載</p>}
          </div>
        )
      })}
    </div>
  )
}

function PeersTab({ item }: { item: DownloadItem }): JSX.Element {
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
        title="只有 BitTorrent 下載有節點"
        body="HTTP 下載是以多條連線向伺服器分段抓取，沒有對等節點。"
      />
    )
  }

  if (loading && peers.length === 0) {
    return <p className="py-6 text-center text-[12px] text-faint">讀取節點中…</p>
  }

  if (peers.length === 0) {
    return (
      <EmptyState
        icon={<span className="text-[16px]">⬡</span>}
        title="目前沒有連線的節點"
        body="可能仍在尋找種子，或下載已完成而停止連線。"
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
          <Badge tone={peer.seeder ? 'ok' : 'muted'}>{peer.seeder ? '種子' : '下載者'}</Badge>
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

  if (loading && !map) return <p className="py-6 text-center text-[12px] text-faint">讀取分片資訊中…</p>

  if (error) {
    return <EmptyState icon={<span className="text-[16px]">!</span>} title="無法讀取分片" body={error} />
  }

  if (!map) {
    return (
      <EmptyState
        icon={<span className="text-[16px]">▦</span>}
        title="目前沒有分片資訊"
        body="aria2 要等下載開始後才會產生分段位圖。若項目已完成或已被移除，這裡就不再有資料。"
      />
    )
  }

  const groups = groupPieces(map.pieces, 512)
  const reached = map.numPieces > 0 ? (map.completedPieces / map.numPieces) * 100 : 0
  const perCell = groups[0]?.total ?? 1

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {(
          [
            ['分片', `${map.completedPieces} / ${map.numPieces}`],
            ['每片大小', formatBytes(map.pieceLength)],
            ['分片進度', `${reached.toFixed(1)}%`]
          ] as const
        ).map(([label, value]) => (
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
              title={`第 ${index * perCell + 1}–${index * perCell + group.total} 片：${group.complete}/${group.total} 完成`}
            />
          ))}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-faint">
        綠色為已完成分片，紫色為部分完成。每一格代表 {perCell} 個分片
        {map.numPieces > groups.length && `，${map.numPieces} 個分片已合併顯示為 ${groups.length} 格`}。
      </p>
    </div>
  )
}

function ServersTab({ item }: { item: DownloadItem }): JSX.Element {
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
    return <p className="py-6 text-center text-[12px] text-faint">讀取伺服器資訊中…</p>
  }

  return (
    <div className="space-y-3">
      {servers.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">使用中的連線</p>
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
            來源清單{uris.length > 1 && `（${uris.length} 個鏡像）`}
          </p>
          <div className="space-y-1">
            {uris.map((uri, index) => (
              <div
                key={`${index}-${uri.uri}`}
                className="flex items-center gap-2 rounded border border-line/70 bg-elevated/30 px-2 py-1.5"
              >
                <span
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', uri.status === 'used' ? 'bg-ok' : 'bg-faint')}
                  title={uri.status === 'used' ? '已使用' : '待用'}
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
          title="沒有伺服器資訊"
          body="引擎尚未回報這個下載的連線來源。"
        />
      )}
    </div>
  )
}

function OptionsTab({ item }: { item: DownloadItem }): JSX.Element {
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
        aria2 只允許修改尚未開始的下載；進行中的項目會先自動暫停、套用後再繼續。
        {settled && ' 已結束的下載無法再修改選項。'}
      </p>

      <Field label="單檔限速" hint="留空或 0 代表不限速，例如 2M、500K">
        <Input value={limit} onChange={(event) => setLimit(event.target.value)} placeholder="不限速" disabled={settled} />
      </Field>

      <Field label="連線數 (split)" hint="每個下載同時使用的連線數量">
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
        套用變更
      </Button>

      {Object.keys(raw).length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">aria2 目前選項</p>
          <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-line bg-elevated/40 p-2.5">
            {Object.entries(raw)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => (
                <div key={key} className="flex items-start justify-between gap-3 text-[10.5px]">
                  <span className="font-mono text-faint">{key}</span>
                  <span className="truncate font-mono text-muted" title={value} data-selectable>
                    {value || '(空)'}
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
          <span className="text-[13px] font-medium text-fg">下載詳情</span>
          <IconButton label="關閉" icon={<X size={15} />} onClick={close} />
        </header>
        <EmptyState
          icon={<span className="text-[16px]">?</span>}
          title="項目已不存在"
          body="這個下載已被移除，或已從清單中清除。"
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
        <IconButton label="關閉" icon={<X size={15} />} onClick={close} />
      </header>

      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        {isActive ? (
          <IconButton label="暫停" icon={<Pause size={15} />} onClick={() => void pauseGids([item.gid])} />
        ) : (
          <IconButton
            label={isError ? '重試' : '開始'}
            icon={isError ? <RotateCw size={15} /> : <Play size={15} />}
            onClick={() => void (isError ? retryGids([item.gid]) : resumeGids([item.gid]))}
          />
        )}
        <IconButton
          label="開啟檔案"
          icon={<Play size={15} />}
          disabled={!isComplete}
          onClick={() => void openFile(item.gid)}
        />
        <IconButton label="開啟資料夾" icon={<FolderOpen size={15} />} onClick={() => void showInFolder(item.gid)} />
        <IconButton
          label="複製來源連結"
          icon={<Copy size={15} />}
          disabled={!uri}
          onClick={() => void copyLink(item.gid)}
        />
        <div className="flex-1" />
        <IconButton label="移除" icon={<Trash2 size={15} />} onClick={() => void removeGids([item.gid], false)} />
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
            {entry.label}
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
