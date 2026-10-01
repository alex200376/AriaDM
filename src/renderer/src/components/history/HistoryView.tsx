import { FolderOpen, History as HistoryIcon, RotateCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo } from 'react'

import type { HistoryRow } from '@shared/download'
import { formatBytes, formatDateTime, formatRelative } from '@shared/format'

import { errorSummary, kindGlyph, sourceLabel, statusLabel, statusTone } from '../../lib/labels'
import { useApp } from '../../store/app-store'
import { Badge, Button, EmptyState, IconButton, Input } from '../ui/primitives'

const GRID = 'minmax(220px, 1fr) 92px 88px 132px 132px 120px'

function matches(row: HistoryRow, needle: string): boolean {
  if (!needle) return true
  if (row.name.toLowerCase().includes(needle)) return true
  if (row.dir.toLowerCase().includes(needle)) return true
  return row.uris.some((uri) => uri.toLowerCase().includes(needle))
}

export function HistoryView(): JSX.Element {
  const rows = useApp((state) => state.historyRows)
  const total = useApp((state) => state.historyTotal)
  const search = useApp((state) => state.search)
  const liveGids = useApp((state) => state.items)
  const setSearch = useApp((state) => state.setSearch)
  const queryHistory = useApp((state) => state.queryHistory)
  const deleteHistory = useApp((state) => state.deleteHistory)
  const clearHistory = useApp((state) => state.clearHistory)
  const retryGids = useApp((state) => state.retryGids)
  const showInFolder = useApp((state) => state.showInFolder)

  // Re-query when the search term changes, debounced so typing stays smooth.
  useEffect(() => {
    const timer = window.setTimeout(() => void queryHistory(), 220)
    return () => window.clearTimeout(timer)
  }, [search, queryHistory])

  const filtered = useMemo(() => rows.filter((row) => matches(row, search.trim().toLowerCase())), [rows, search])

  // A history entry outlives its aria2 result, so the file actions only make
  // sense while the item is still known to the engine.
  const live = useMemo(() => new Set(liveGids.map((item) => item.gid)), [liveGids])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface/40 px-3 py-2">
        <div className="w-72">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜尋紀錄…"
            className="h-8 text-[12px]"
          />
        </div>
        <span className="text-[11px] text-faint">共 {total} 筆紀錄</span>
        <div className="flex-1" />
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 size={13} />}
          onClick={() => void clearHistory()}
          disabled={rows.length === 0}
        >
          清空紀錄
        </Button>
      </div>

      <div
        className="grid shrink-0 items-center gap-3 border-b border-line bg-surface/60 px-3 py-2 text-[11px] font-medium text-faint"
        style={{ gridTemplateColumns: GRID }}
      >
        <span>檔案名稱</span>
        <span className="text-right">大小</span>
        <span>狀態</span>
        <span>加入時間</span>
        <span>完成時間</span>
        <span className="text-right">操作</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <EmptyState
            icon={<HistoryIcon size={22} />}
            title={rows.length === 0 ? '還沒有下載紀錄' : '沒有符合的紀錄'}
            body={
              rows.length === 0
                ? '完成的與失敗的下載都會保存在這裡，即使 aria2 已經清掉它們的結果。'
                : '試著調整搜尋關鍵字。'
            }
          />
        ) : (
          filtered.map((row) => (
            <div
              key={row.gid}
              className="row-hover grid items-center gap-3 border-b border-line/60 px-3 py-2.5 text-[12.5px] hover:bg-line/30"
              style={{ gridTemplateColumns: GRID }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-line/70 text-[11px] text-muted">
                    {kindGlyph(row.kind)}
                  </span>
                  <span className="truncate font-medium text-fg" title={row.name}>
                    {row.name}
                  </span>
                </div>
                <div className="mt-0.5 truncate pl-7 text-[11px] text-faint" title={row.uris[0] ?? row.dir}>
                  {row.uris[0] ?? row.dir}
                </div>
              </div>

              <div className="text-tabular text-right text-muted">{formatBytes(row.totalLength)}</div>

              <div>
                <Badge tone={statusTone(row.status)} dot>
                  {statusLabel(row.status)}
                </Badge>
                {row.status === 'error' && row.errorCode !== 0 && (
                  <div className="mt-1 text-[10.5px] text-danger/90">
                    {errorSummary(row.errorCode, row.errorMessage)}
                  </div>
                )}
              </div>

              <div className="text-[11px] text-muted" title={formatDateTime(row.addedAt)}>
                {formatRelative(row.addedAt)}
                <div className="text-[10.5px] text-faint">{sourceLabel(row.source)}</div>
              </div>

              <div className="text-[11px] text-muted" title={row.completedAt ? formatDateTime(row.completedAt) : ''}>
                {row.completedAt ? formatRelative(row.completedAt) : '—'}
                {row.mediaFormat && <div className="truncate text-[10.5px] text-faint">{row.mediaFormat}</div>}
              </div>

              <div className="flex items-center justify-end gap-0.5">
                {row.status === 'error' && row.uris.length > 0 && (
                  <IconButton label="重試" icon={<RotateCw size={14} />} onClick={() => void retryGids([row.gid])} />
                )}
                <IconButton
                  label="開啟資料夾"
                  icon={<FolderOpen size={14} />}
                  disabled={!live.has(row.gid)}
                  onClick={() => void showInFolder(row.gid)}
                />
                <IconButton label="刪除紀錄" icon={<Trash2 size={14} />} onClick={() => void deleteHistory([row.gid])} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
