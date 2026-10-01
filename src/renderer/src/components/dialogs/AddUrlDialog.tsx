import { FileUp, FolderOpen, Link2, Loader2, Settings2, Sparkles, Wrench } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { formatBytes } from '@shared/format'
import { classifyMediaError, type MediaErrorAction, type MediaErrorInfo } from '@shared/media-errors'
import { defaultFormatId } from '@shared/media-formats'
import { matchMediaSite } from '@shared/media-sites'
import type { AddDownloadInput, MediaFormatInfo } from '@shared/settings'
import { CONNECTION_PRESETS, type ConnectionsPreset } from '@shared/settings'
import { fileNameFromUri, parseUriList } from '@shared/uri'

import { useApp } from '../../store/app-store'
import { cn } from '../../lib/cn'
import { Badge, Button, Field, Input, Modal, Row, SelectField, TextArea, Toggle } from '../ui/primitives'

/**
 * Base64-encode bytes without blowing the call stack.
 *
 * A torrent file is small, but `String.fromCharCode(...bytes)` on a large array
 * would overflow, so the chunks are joined incrementally.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

/**
 * Radix rejects an empty string as an item value, so the "automatic" category
 * round-trips through this sentinel and is mapped back to `''` on change.
 */
const AUTO_CATEGORY = '__auto__'

/** How long the pasted URL must sit still before a format probe is launched. */
const PROBE_DEBOUNCE_MS = 450

/** One row of the quality picker, built from a probed format. */
function formatOptionLabel(format: MediaFormatInfo): string {
  const size = format.filesize ? ` · ${formatBytes(format.filesize)}` : ''
  return `${format.label}${size}`
}

export function AddUrlDialog(): JSX.Element | null {
  const dialog = useApp((state) => state.dialog)
  const seed = useApp((state) => state.dialogSeed)
  const settings = useApp((state) => state.settings)
  const toolkits = useApp((state) => state.toolkits)
  const closeDialog = useApp((state) => state.closeDialog)
  const addDownload = useApp((state) => state.addDownload)
  const pushToast = useApp((state) => state.pushToast)
  const runAction = useApp((state) => state.runAction)
  const refreshToolkits = useApp((state) => state.refreshToolkits)
  const patchSettings = useApp((state) => state.patchSettings)

  const [text, setText] = useState('')
  const [torrent, setTorrent] = useState<{ name: string; base64: string } | null>(null)
  const [metalink, setMetalink] = useState<{ name: string; base64: string } | null>(null)
  const [out, setOut] = useState('')
  const [dir, setDir] = useState('')
  const [category, setCategory] = useState('')
  const [preset, setPreset] = useState<ConnectionsPreset>('standard')
  const [paused, setPaused] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [referer, setReferer] = useState('')
  const [userAgent, setUserAgent] = useState('')
  const [cookies, setCookies] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [proxy, setProxy] = useState('')
  const [headers, setHeaders] = useState('')
  const [maxLimit, setMaxLimit] = useState('')
  const [dropActive, setDropActive] = useState(false)
  const [classification, setClassification] = useState<{ mirrors: string[][]; singles: string[] }>({
    mirrors: [],
    singles: []
  })

  // --- media (yt-dlp) state -------------------------------------------------
  const [formats, setFormats] = useState<MediaFormatInfo[] | null>(null)
  const [formatId, setFormatId] = useState('')
  const [probing, setProbing] = useState(false)
  const [mediaError, setMediaError] = useState<MediaErrorInfo | null>(null)
  const [audioOnly, setAudioOnly] = useState(false)
  const [playlist, setPlaylist] = useState(false)
  /** The user asked for a plain aria2 download even though the site is known. */
  const [forceAria2, setForceAria2] = useState(false)
  const [installing, setInstalling] = useState<string>('')
  /** Bumped to re-run the probe after an action (a fix, or 重新偵測). */
  const [probeNonce, setProbeNonce] = useState(0)
  /** Installing yt-dlp is automatic, but only tried once per URL. */
  const autoInstallTried = useRef(false)

  const open = dialog === 'add'

  useEffect(() => {
    if (!open) return
    setText(seed)
    setTorrent(null)
    setMetalink(null)
    setOut('')
    setDir(settings?.downloadDir ?? '')
    setCategory('')
    setPreset(settings?.connectionsPreset === 'custom' ? 'standard' : (settings?.connectionsPreset ?? 'standard'))
    setPaused(false)
    setAdvanced(false)
    setFormats(null)
    setFormatId('')
    setMediaError(null)
    setAudioOnly(false)
    setPlaylist(false)
    setForceAria2(false)
    setInstalling('')
    autoInstallTried.current = false
  }, [open, seed, settings?.downloadDir, settings?.connectionsPreset])

  const uris = useMemo(() => parseUriList(text), [text])
  const mediaSite = uris.length === 1 ? matchMediaSite(uris[0]!) : null
  const hasYtDlp = toolkits?.ytdlp.present ?? false
  const hasFfmpeg = toolkits?.ffmpeg.present ?? false

  /**
   * Fetch a helper tool.
   *
   * Neither yt-dlp nor ffmpeg ships with the app, and a missing yt-dlp is the
   * most common reason a media link appears to do nothing — so this is called
   * automatically on detection rather than only from a button.
   */
  const installToolkit = useCallback(
    async (kind: 'ytdlp' | 'ffmpeg'): Promise<boolean> => {
      setInstalling(kind)
      try {
        await window.api.integrations.downloadToolkit(kind)
        await refreshToolkits()
        pushToast({
          title: kind === 'ytdlp' ? 'yt-dlp 已就緒' : 'ffmpeg 已就緒',
          body: '影音下載現在可以使用了',
          tone: 'success'
        })
        return true
      } catch (error) {
        pushToast({ title: '安裝失敗', body: classifyMediaError((error as Error).message).message, tone: 'error' })
        return false
      } finally {
        setInstalling('')
      }
    },
    [pushToast, refreshToolkits]
  )

  // Autosetup: a recognised media page with no engine gets one, with no detour
  // through the settings. Attempted once per URL so a failure (no network) does
  // not spin.
  useEffect(() => {
    if (!open || mediaSite === null || hasYtDlp || forceAria2 || autoInstallTried.current) return
    autoInstallTried.current = true
    void installToolkit('ytdlp')
  }, [open, mediaSite, hasYtDlp, forceAria2, installToolkit])
  const mediaUrl = uris[0] ?? ''
  // Auto-detection is only offered for a single known media page and a working
  // yt-dlp. Anything else stays on the aria2 path, which cannot surprise anyone.
  const mediaMode = mediaSite !== null && !forceAria2 && !torrent && !metalink
  const useYtDlp = mediaMode && hasYtDlp

  // Ask the main process to classify, so the mirror/single decision matches
  // exactly what the backend will do when the download is created.
  useEffect(() => {
    if (!open || uris.length === 0) {
      setClassification({ mirrors: [], singles: [] })
      return
    }
    let cancelled = false
    void window.api.downloads
      .parseUriList(text)
      .then((result) => {
        if (!cancelled) setClassification(result)
      })
      .catch(() => {
        if (!cancelled) setClassification({ mirrors: [], singles: uris })
      })
    return () => {
      cancelled = true
    }
  }, [open, text, uris])

  // Probe formats as soon as a recognised page settles, so the quality picker is
  // already populated by the time the user looks at it. The probe is debounced
  // while typing and every in-flight result is dropped once the URL changes.
  useEffect(() => {
    if (!open || !useYtDlp || mediaUrl === '') {
      setFormats(null)
      setFormatId('')
      setMediaError(null)
      setProbing(false)
      return
    }

    let cancelled = false
    setProbing(true)
    setMediaError(null)
    setFormats(null)
    setFormatId('')

    const timer = window.setTimeout(() => {
      void window.api.integrations
        .getMediaFormats(mediaUrl)
        .then((result) => {
          if (cancelled) return
          setFormats(result)
          // The best entry is only usable with ffmpeg; without it the picker
          // opens on the best single-file format instead of on a download that
          // is going to fail.
          setFormatId(defaultFormatId(result, hasFfmpeg))
          if (result.length === 0) {
            setMediaError({ kind: 'unknown', message: '這個連結找不到可下載的格式。', action: 'retry', actionLabel: '重新偵測' })
          }
        })
        .catch((error: Error) => {
          if (cancelled) return
          setMediaError(classifyMediaError(error.message, { ytdlpVersion: toolkits?.ytdlp.version ?? '' }))
        })
        .finally(() => {
          if (!cancelled) setProbing(false)
        })
    }, PROBE_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, useYtDlp, mediaUrl, probeNonce, hasFfmpeg, toolkits?.ytdlp.version])

  if (!open) return null

  const isTorrent = torrent !== null || uris.some((uri) => uri.startsWith('magnet:'))
  const downloadCount = classification.mirrors.length + classification.singles.length
  const mirrorCount = classification.mirrors.length
  const canSubmit =
    torrent !== null || metalink !== null ? true : useYtDlp ? formatId !== '' : uris.length > 0

  const chosenFormat = formats?.find((format) => format.formatId === formatId) ?? null
  // A merged stream and an mp3 conversion both need ffmpeg; a plain progressive
  // format does not, which is exactly the trade-off the hint explains.
  const needsFfmpeg = chosenFormat?.needsFfmpeg ?? false

  const handleDrop = async (event: React.DragEvent): Promise<void> => {
    event.preventDefault()
    setDropActive(false)
    const files = Array.from(event.dataTransfer.files)

    const torrentFile = files.find((file) => file.name.toLowerCase().endsWith('.torrent'))
    if (torrentFile) {
      const bytes = new Uint8Array(await torrentFile.arrayBuffer())
      setTorrent({ name: torrentFile.name, base64: bytesToBase64(bytes) })
      return
    }

    const metalinkFile = files.find((file) => file.name.toLowerCase().endsWith('.metalink'))
    if (metalinkFile) {
      const bytes = new Uint8Array(await metalinkFile.arrayBuffer())
      setMetalink({ name: metalinkFile.name, base64: bytesToBase64(bytes) })
      return
    }

    // Anything else is treated as text; a dragged link is a common gesture.
    const dropped = event.dataTransfer.getData('text')
    if (dropped) setText((previous) => (previous ? `${previous}\n${dropped}` : dropped))
  }

  /**
   * Do the thing that fixes the reported failure, then probe again.
   *
   * Every action here answers a specific yt-dlp error (see shared/media-errors),
   * which is the difference between a message that explains itself and one that
   * just reports a failure.
   */
  const fixMediaError = (action: MediaErrorAction): void => {
    switch (action) {
      case 'enable-cookies':
        void patchSettings({ mediaCookiesFromBrowser: 'auto' }).then(() => setProbeNonce((value) => value + 1))
        break
      case 'install-ffmpeg':
        void installToolkit('ffmpeg').then((ok) => {
          if (ok) setProbeNonce((value) => value + 1)
        })
        break
      case 'update-ytdlp':
        void installToolkit('ytdlp').then((ok) => {
          if (ok) setProbeNonce((value) => value + 1)
        })
        break
      default:
        setProbeNonce((value) => value + 1)
    }
  }

  const submitMedia = async (): Promise<void> => {
    if (!settings || !formatId) return
    const ok = await runAction('加入影音下載', async () => {
      const result = await window.api.integrations.addMedia({
        url: mediaUrl,
        formatId,
        dir,
        audioOnly,
        playlist,
        maxConcurrent: settings.maxConcurrentDownloads
      })
      pushToast({
        title: '已交給 yt-dlp 下載',
        body: `${result.gids.length} 個項目`,
        tone: 'success'
      })
    })
    if (ok) closeDialog()
  }

  const submit = async (): Promise<void> => {
    if (!settings) return

    if (useYtDlp) {
      await submitMedia()
      return
    }

    const presetValues = preset === 'custom' ? null : CONNECTION_PRESETS[preset]
    const split = presetValues?.split ?? settings.split
    const maxConnectionPerServer = presetValues?.maxConnectionPerServer ?? settings.maxConnectionPerServer
    const minSplitSize = presetValues?.minSplitSize ?? settings.minSplitSize

    const base: Omit<AddDownloadInput, 'uris'> = {
      out,
      dir,
      split,
      maxConnectionPerServer,
      minSplitSize,
      maxDownloadLimit: maxLimit.trim() === '' ? 0 : Number(maxLimit) * 1024 * 1024,
      referer,
      userAgent,
      cookieHeader: cookies,
      headers: headers
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      username,
      password,
      proxy,
      paused,
      seedRatio: settings.seedRatio,
      seedTime: settings.seedTime,
      selectFileIndices: [],
      category,
      tags: [],
      source: 'manual',
      torrentBase64: null,
      metalinkBase64: null,
      allowDuplicate: false,
      engine: 'auto'
    }

    if (torrent) {
      await addDownload({
        ...base,
        uris: [],
        torrentBase64: torrent.base64,
        out: out || torrent.name.replace(/\.torrent$/i, '')
      })
    } else if (metalink) {
      await addDownload({ ...base, uris: [], metalinkBase64: metalink.base64 })
    } else {
      // Each mirror group becomes one download with several sources; each unique
      // filename becomes its own download.
      for (const group of classification.mirrors) {
        await addDownload({ ...base, uris: group, out: downloadCount === 1 ? out : '' })
      }
      for (const uri of classification.singles) {
        await addDownload({ ...base, uris: [uri], out: downloadCount === 1 ? out : '', category })
      }
    }

    closeDialog()
  }

  const footerNote = torrent
    ? `種子檔：${torrent.name}`
    : metalink
      ? `Metalink：${metalink.name}`
      : useYtDlp
        ? probing
          ? '正在偵測可用格式…'
          : formatId
            ? '將由 yt-dlp 下載並轉存'
            : '偵測不到可用格式'
        : uris.length > 0
          ? `將建立 ${downloadCount} 個下載${mirrorCount > 0 ? `（其中 ${mirrorCount} 組為多鏡像）` : ''}`
          : '尚未輸入連結'

  return (
    <Modal
      open={open}
      title="新增下載"
      subtitle="貼上任何連結即可，影音網站的內容會自動交給 yt-dlp"
      onClose={closeDialog}
      width="max-w-3xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-faint">{footerNote}</span>
          <Button variant="ghost" onClick={closeDialog}>
            取消
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {useYtDlp ? '下載影片' : '開始下載'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDropActive(true)
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(event) => void handleDrop(event)}
          className={cn(
            'rounded-xl border-2 border-dashed p-3 transition-colors',
            dropActive ? 'border-brand bg-brand/10' : 'border-line bg-elevated/30'
          )}
        >
          <div className="mb-2 flex items-center gap-2 text-[11.5px] text-muted">
            <Link2 size={13} />
            <span>每一行一個連結</span>
            <div className="flex-1" />
            <span className="flex items-center gap-1 text-faint">
              <FileUp size={12} />
              可拖入 .torrent / .metalink
            </span>
          </div>
          <TextArea
            rows={5}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={'https://example.com/file.zip\nhttps://www.youtube.com/watch?v=...\nmagnet:?xt=urn:btih:...'}
            autoFocus
          />
        </div>

        {torrent && (
          <div className="flex items-center justify-between rounded-lg border border-ok/30 bg-ok/10 px-3 py-2">
            <span className="text-[12px] text-fg">已載入種子檔：{torrent.name}</span>
            <Button variant="ghost" size="sm" onClick={() => setTorrent(null)}>
              移除
            </Button>
          </div>
        )}

        {metalink && (
          <div className="flex items-center justify-between rounded-lg border border-info/30 bg-info/10 px-3 py-2">
            <span className="text-[12px] text-fg">已載入 Metalink：{metalink.name}</span>
            <Button variant="ghost" size="sm" onClick={() => setMetalink(null)}>
              移除
            </Button>
          </div>
        )}

        {mediaSite !== null && !torrent && !metalink && (
          <div className="rounded-xl border border-brand/30 bg-brand/10 px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles size={14} className="text-brand" />
              <span className="text-[12.5px] font-medium text-fg">偵測到影音網站</span>
              <Badge tone="brand">{mediaSite}</Badge>
              {forceAria2 ? (
                <Badge tone="muted">一般下載</Badge>
              ) : (
                <Badge tone={hasYtDlp ? 'brand' : 'warn'}>yt-dlp</Badge>
              )}
              <div className="flex-1" />
              {probing && (
                <span className="flex items-center gap-1.5 text-[11px] text-muted">
                  <Loader2 size={12} className="animate-spin" />
                  正在偵測格式…
                </span>
              )}
              <button
                type="button"
                onClick={() => setForceAria2((value) => !value)}
                className="text-[11px] text-brand hover:underline"
              >
                {forceAria2 ? '改用影音下載' : '改用一般下載'}
              </button>
            </div>

            {!hasYtDlp && !forceAria2 && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-warn/25 bg-warn/10 px-3 py-2">
                <span className="text-[11.5px] leading-relaxed text-warn">
                  {installing === 'ytdlp'
                    ? '正在安裝影音引擎（yt-dlp）…安裝完成後會自動偵測格式。'
                    : '尚未安裝 yt-dlp，這個連結目前只能改用一般下載；影音網站的實際檔案是短效的串流網址，通常會失敗。'}
                </span>
                {installing === 'ytdlp' ? (
                  <Loader2 size={14} className="animate-spin text-warn" />
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Sparkles size={13} />}
                    onClick={() => void installToolkit('ytdlp')}
                  >
                    立即安裝
                  </Button>
                )}
              </div>
            )}

            {mediaError && !probing && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
                <span className="text-[11.5px] leading-relaxed text-danger">{mediaError.message}</span>
                {(mediaError.kind === 'bot-check' || mediaError.kind === 'auth' || mediaError.kind === 'cookies-missing') && (
                  <span className="text-[11px] leading-relaxed text-muted">
                    也可以在「設定 → 整合與工具 → 影音下載」指定要用哪個瀏覽器的 Cookie。
                  </span>
                )}
                {mediaError.action && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={installing !== ''}
                    icon={
                      installing !== '' ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Wrench size={13} />
                      )
                    }
                    onClick={() => fixMediaError(mediaError.action!)}
                  >
                    {mediaError.actionLabel ?? '重試'}
                  </Button>
                )}
              </div>
            )}

            {useYtDlp && formats && formats.length > 0 && (
              <>
                <div className="mt-2.5 grid grid-cols-2 gap-3">
                  <SelectField
                    label="下載格式"
                    hint="預設為最佳畫質；標示「需 ffmpeg」的格式需要合併音訊與視訊"
                    value={formatId}
                    options={formats.map((format) => ({
                      value: format.formatId,
                      label: formatOptionLabel(format)
                    }))}
                    onValueChange={setFormatId}
                  />
                  <Field label="儲存位置">
                    <div className="flex gap-2">
                      <Input value={dir} onChange={(event) => setDir(event.target.value)} />
                      <Button
                        variant="secondary"
                        icon={<FolderOpen size={14} />}
                        onClick={() => {
                          void window.api.settings.chooseDirectory(dir).then((chosen) => {
                            if (chosen) setDir(chosen)
                          })
                        }}
                      />
                    </div>
                  </Field>
                </div>

                <div className="mt-1 grid grid-cols-2 gap-x-6 border-t border-brand/20 pt-1">
                  <Row label="純音訊" hint="只保留音軌">
                    <Toggle
                      checked={audioOnly}
                      onChange={(next) => {
                        setAudioOnly(next)
                        if (next) {
                          const audio = formats.find((format) => format.resolution === 'audio')
                          if (audio) setFormatId(audio.formatId)
                        } else if (chosenFormat?.resolution === 'audio' && formats[0]) {
                          setFormatId(formats[0].formatId)
                        }
                      }}
                      label="純音訊"
                    />
                  </Row>
                  <Row label="下載整個播放清單" hint="展開清單中的所有項目">
                    <Toggle checked={playlist} onChange={setPlaylist} label="播放清單" />
                  </Row>
                </div>

                {needsFfmpeg && !hasFfmpeg && (
                  <p className="rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-[11.5px] leading-relaxed text-warn">
                    尚未安裝 ffmpeg，無法合併此格式的音訊與視訊。請改選含音軌的格式，或到「設定」安裝 ffmpeg。
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {useYtDlp ? null : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Field
                label="另存檔名"
                hint={isTorrent ? '種子下載由中繼資料決定檔名' : '留空則沿用伺服器提供的檔名'}
              >
                <Input
                  value={out}
                  onChange={(event) => setOut(event.target.value)}
                  placeholder={uris[0] ? fileNameFromUri(uris[0]) : '自動'}
                  disabled={isTorrent}
                />
              </Field>

              <Field label="儲存位置">
                <div className="flex gap-2">
                  <Input value={dir} onChange={(event) => setDir(event.target.value)} />
                  <Button
                    variant="secondary"
                    icon={<FolderOpen size={14} />}
                    onClick={() => {
                      void window.api.settings.chooseDirectory(dir).then((chosen) => {
                        if (chosen) setDir(chosen)
                      })
                    }}
                  />
                </div>
              </Field>

              <SelectField
                label="分類"
                value={category || AUTO_CATEGORY}
                options={[
                  { value: AUTO_CATEGORY, label: '自動判斷' },
                  ...(settings?.categories ?? []).map((entry) => ({ value: entry.id, label: entry.name }))
                ]}
                onValueChange={(value) => setCategory(value === AUTO_CATEGORY ? '' : value)}
              />

              <SelectField
                label="連線數預設"
                value={preset}
                options={[
                  { value: 'standard', label: '標準（8 連線）' },
                  { value: 'steady', label: '穩健（4 連線）' },
                  { value: 'turbo', label: '極速（16 連線）' },
                  { value: 'single', label: '單線（1 連線）' }
                ]}
                onValueChange={(value) => setPreset(value as ConnectionsPreset)}
              />
            </div>

            <div className="rounded-lg border border-line bg-elevated/30 px-3 py-1">
              <Row label="加入佇列後手動開始" hint="不立即開始下載，排在佇列最後">
                <Toggle checked={paused} onChange={setPaused} label="加入佇列" />
              </Row>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setAdvanced((value) => !value)}
                className="flex items-center gap-1.5 text-[12px] text-brand hover:underline"
              >
                <Settings2 size={13} />
                {advanced ? '收起進階選項' : '展開進階選項'}
              </button>

              {advanced && (
                <div className="mt-3 space-y-4 rounded-lg border border-line bg-elevated/30 p-3">
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Referer" hint="部分網站會檢查來源頁面">
                      <Input value={referer} onChange={(event) => setReferer(event.target.value)} placeholder="自動" />
                    </Field>
                    <Field label="User-Agent" hint="留空則使用設定中的預設值">
                      <Input value={userAgent} onChange={(event) => setUserAgent(event.target.value)} placeholder="預設" />
                    </Field>
                    <Field label="Cookie" hint="完整的 Cookie 標頭內容">
                      <Input
                        value={cookies}
                        onChange={(event) => setCookies(event.target.value)}
                        placeholder="key=value; key2=value2"
                      />
                    </Field>
                    <Field label="單檔限速 (MB/s)" hint="留空代表不限速">
                      <Input value={maxLimit} onChange={(event) => setMaxLimit(event.target.value)} placeholder="不限速" />
                    </Field>
                    <Field label="HTTP 使用者名稱">
                      <Input value={username} onChange={(event) => setUsername(event.target.value)} />
                    </Field>
                    <Field label="HTTP 密碼">
                      <Input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    </Field>
                    <Field label="代理伺服器" hint="例如 http://127.0.0.1:8080">
                      <Input value={proxy} onChange={(event) => setProxy(event.target.value)} />
                    </Field>
                    <Field label="自訂標頭" hint="每行一個，格式為 Name: value">
                      <TextArea
                        rows={3}
                        value={headers}
                        onChange={(event) => setHeaders(event.target.value)}
                        placeholder="X-Custom: value"
                      />
                    </Field>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {uris.length > 1 && mirrorCount > 0 && (
          <p className="rounded-lg border border-info/25 bg-info/10 px-3 py-2 text-[11.5px] leading-relaxed text-info">
            偵測到相同檔名的連結，已自動視為同一個檔案的多個鏡像來源；aria2 會自動選擇較快的伺服器。
          </p>
        )}
      </div>
    </Modal>
  )
}
