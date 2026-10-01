import {
  Activity,
  CheckCircle2,
  Eraser,
  Gauge,
  History,
  Moon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Sun
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { cn } from '../lib/cn'
import { useApp, type ViewKey } from '../store/app-store'

interface Command {
  id: string
  label: string
  hint?: string
  icon: ReactNode
  keywords: string
  run(): void | Promise<void>
}

/**
 * Keyboard-first command palette.
 *
 * Commands are plain data so the list stays reviewable and so a future plugin
 * surface could contribute to it without touching the UI.
 */
export function CommandPalette(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const settings = useApp((state) => state.settings)

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((value) => !value)
        setQuery('')
        setIndex(0)
      } else if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const commands = useMemo<Command[]>(() => {
    const store = useApp.getState()
    const views: { key: ViewKey; label: string }[] = [
      { key: 'all', label: '檢視：全部下載' },
      { key: 'active', label: '檢視：下載中' },
      { key: 'complete', label: '檢視：已完成' },
      { key: 'error', label: '檢視：錯誤' }
    ]

    return [
      {
        id: 'add',
        label: '新增下載',
        hint: 'Ctrl+N',
        icon: <Plus size={15} />,
        keywords: 'add url new download 新增 下載',
        run: () => store.openDialog('add')
      },
      {
        id: 'resume-all',
        label: '全部開始',
        icon: <Play size={15} />,
        keywords: 'resume start all 開始 繼續',
        run: () => store.resumeAll()
      },
      {
        id: 'pause-all',
        label: '全部暫停',
        icon: <Pause size={15} />,
        keywords: 'pause all 暫停',
        run: () => store.pauseAll()
      },
      {
        id: 'clear-completed',
        label: '清除已完成',
        icon: <Eraser size={15} />,
        keywords: 'clear completed purge 清除 已完成',
        run: () => store.clearCompleted()
      },
      {
        id: 'history',
        label: '開啟下載紀錄',
        icon: <History size={15} />,
        keywords: 'history log 紀錄 歷史',
        run: () => store.setView('history')
      },
      {
        id: 'settings',
        label: '開啟設定',
        icon: <SettingsIcon size={15} />,
        keywords: 'settings preferences 設定',
        run: () => store.openSettings()
      },
      {
        id: 'profiles',
        label: '速度設定檔',
        icon: <Gauge size={15} />,
        keywords: 'speed profile limit 限速 設定檔',
        run: () => store.openSettings('downloads')
      },
      {
        id: 'theme',
        label: settings?.theme === 'dark' ? '切換為淺色主題' : '切換為深色主題',
        icon: settings?.theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />,
        keywords: 'theme dark light 主題 深色 淺色',
        run: () => store.patchSettings({ theme: settings?.theme === 'dark' ? 'light' : 'dark' })
      },
      {
        id: 'restart-engine',
        label: '重新啟動 aria2 引擎',
        icon: <RefreshCw size={15} />,
        keywords: 'restart engine aria2 重啟 引擎',
        run: () => store.runAction('重啟引擎', () => window.api.engine.restart())
      },
      {
        id: 'open-log',
        label: '開啟 aria2 日誌',
        icon: <Activity size={15} />,
        keywords: 'log aria2 日誌',
        run: () => window.api.engine.openLog()
      },
      ...views.map((view) => ({
        id: `view-${view.key}`,
        label: view.label,
        icon: <CheckCircle2 size={15} />,
        keywords: `view ${view.key} 檢視`,
        run: () => store.setView(view.key)
      }))
    ]
  }, [settings?.theme])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return commands
    return commands.filter(
      (command) => command.label.toLowerCase().includes(needle) || command.keywords.includes(needle)
    )
  }, [commands, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  if (!open) return null

  const runAt = (position: number): void => {
    const command = filtered[position]
    if (!command) return
    setOpen(false)
    void command.run()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-24">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => setOpen(false)} aria-hidden />

      <div className="relative w-[560px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setIndex((value) => Math.min(value + 1, filtered.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setIndex((value) => Math.max(value - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              runAt(index)
            }
          }}
          placeholder="輸入指令…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-[13.5px] text-fg placeholder:text-faint focus:outline-none"
        />

        <div className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 && <p className="px-3 py-6 text-center text-[12px] text-faint">沒有符合的指令</p>}

          {filtered.map((command, position) => (
            <button
              key={command.id}
              type="button"
              onMouseEnter={() => setIndex(position)}
              onClick={() => runAt(position)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left',
                position === index ? 'bg-brand/15' : 'hover:bg-line/40'
              )}
            >
              <span className={cn('shrink-0', position === index ? 'text-brand' : 'text-faint')}>{command.icon}</span>
              <span className="flex-1 truncate text-[12.5px] text-fg">{command.label}</span>
              {command.hint && <span className="text-[10.5px] text-faint">{command.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
