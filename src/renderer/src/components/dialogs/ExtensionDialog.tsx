import { Check, Copy, FolderOpen, RefreshCw, Sparkles } from 'lucide-react'
import { useState } from 'react'

import { useApp } from '../../store/app-store'
import { Badge, Button, Field, Input, Modal, SectionTitle } from '../ui/primitives'

function Step({ index, title, children }: { index: number; title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand/20 text-[11px] font-semibold text-brand">
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium text-fg">{title}</p>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{children}</div>
      </div>
    </div>
  )
}

export function ExtensionDialog(): JSX.Element | null {
  const dialog = useApp((state) => state.dialog)
  const handoff = useApp((state) => state.handoff)
  const closeDialog = useApp((state) => state.closeDialog)
  const refreshHandoff = useApp((state) => state.refreshHandoff)
  const pushToast = useApp((state) => state.pushToast)
  const [copied, setCopied] = useState('')
  const [advanced, setAdvanced] = useState(false)

  const open = dialog === 'extension'
  if (!open) return null

  const copy = (value: string, label: string): void => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(label)
      pushToast({ title: `已複製${label}`, body: '', tone: 'info' })
      window.setTimeout(() => setCopied(''), 1500)
    })
  }

  return (
    <Modal
      open={open}
      title="瀏覽器整合"
      subtitle="安裝後不需要填任何設定，擴充套件會自己找到 AriaDM"
      onClose={closeDialog}
      width="max-w-2xl"
      footer={
        <>
          <Button
            variant="secondary"
            icon={<FolderOpen size={14} />}
            onClick={() => {
              void useApp.getState().runAction('開啟擴充套件資料夾', async () => {
                await window.api.integrations.openExtensionFolder()
              })
            }}
          >
            開啟擴充套件資料夾
          </Button>
          <Button variant="primary" onClick={closeDialog}>
            完成
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2 rounded-lg border border-line bg-elevated/30 p-3">
          <p className="text-[11.5px] leading-relaxed text-muted">
            擴充套件會攔截瀏覽器的下載（連同 Cookie、Referer 與 User-Agent），改交給 AriaDM；
            在支援的影音網站上，影片左上角會多出一顆小下載鈕，按一下即以最佳畫質下載，
            右鍵選單也提供「用 AriaDM 下載」。
          </p>
          <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-muted">
            <Sparkles size={12} className="mt-0.5 shrink-0 text-brand" />
            <span>
              安裝完成後，擴充套件會自動掃描本機的 AriaDM（含權杖），因此<span className="text-fg">不必複製任何網址或權杖</span>；
              只有手動改成其他連接埠時才需要進階設定。
            </span>
          </p>
        </div>

        {handoff && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={handoff.running ? 'ok' : 'danger'} dot>
              {handoff.running ? `AriaDM 已可被找到（:${handoff.port}）` : 'AriaDM 未提供連線，擴充套件無法配對'}
            </Badge>
            {handoff.running && handoff.discoveryPort > 0 && (
              <span className="text-[11px] text-faint">擴充套件會自動找到（連接埠 {handoff.discoveryPort}）</span>
            )}
            {handoff.running && handoff.discoveryPort === 0 && (
              <span className="text-[11px] text-faint">
                擴充套件會被擋住：{handoff.discoveryPorts.join('、')} 都被其他程式佔用
              </span>
            )}
            {!handoff.running && <span className="text-[11px] text-faint">請到「整合與工具」分頁啟用</span>}
          </div>
        )}

        <div className="space-y-4">
          <SectionTitle>Chrome / Edge 安裝步驟</SectionTitle>
          <Step index={1} title="開啟擴充套件管理頁">
            在網址列輸入 <code className="font-mono">chrome://extensions</code>（Edge 為{' '}
            <code className="font-mono">edge://extensions</code>）。
          </Step>
          <Step index={2} title="開啟開發人員模式">
            切換右上角的「開發人員模式」。
          </Step>
          <Step index={3} title="載入未封裝項目">
            點「載入未封裝項目」，選擇上面按鈕開啟的 <code className="font-mono">chrome</code> 子資料夾。
          </Step>
          <Step index={4} title="完成，無需設定">
            擴充套件會自行配對；之後在影音網站上把滑鼠移到影片上，就會看到下載鈕。
          </Step>
        </div>

        <div className="space-y-4">
          <SectionTitle>Firefox 安裝步驟</SectionTitle>
          <Step index={1} title="開啟除錯頁面">
            在網址列輸入 <code className="font-mono">about:debugging#/runtime/this-firefox</code>。
          </Step>
          <Step index={2} title="載入暫時性附加元件">
            點「載入暫時性附加元件」，選擇擴充套件資料夾中的{' '}
            <code className="font-mono">firefox/manifest.json</code>。
          </Step>
          <Step index={3} title="完成，無需設定">
            同樣會自動配對；若圖示顯示未連線，可在彈出視窗按「重新連線」。
          </Step>
        </div>

        <div className="border-t border-line pt-4">
          <button
            type="button"
            onClick={() => setAdvanced((value) => !value)}
            className="text-[12px] text-brand hover:underline"
          >
            {advanced ? '收起進階設定' : '顯示進階設定（手動連線）'}
          </button>

          {advanced && handoff && (
            <div className="mt-3 space-y-3 rounded-lg border border-line bg-elevated/30 p-3">
              <p className="text-[11.5px] leading-relaxed text-muted">
                只有在自動配對失敗（例如更改過連接埠、或系統阻擋了廣播）時才需要手動填寫。
              </p>
              <Field label="API 網址" hint="填入擴充套件的進階設定">
                <div className="flex gap-2">
                  <Input readOnly value={handoff.url} className="font-mono text-[11px]" data-selectable />
                  <Button
                    variant="secondary"
                    icon={copied === '網址' ? <Check size={14} /> : <Copy size={14} />}
                    onClick={() => copy(handoff.url, '網址')}
                  />
                </div>
              </Field>

              <Field label="權杖" hint="擴充套件進階設定中需填入相同值">
                <div className="flex gap-2">
                  <Input readOnly value={handoff.token} className="font-mono text-[11px]" data-selectable />
                  <Button
                    variant="secondary"
                    icon={copied === '權杖' ? <Check size={14} /> : <Copy size={14} />}
                    onClick={() => copy(handoff.token, '權杖')}
                  />
                  <Button
                    variant="ghost"
                    icon={<RefreshCw size={14} />}
                    onClick={() => {
                      void window.api.integrations.rotateHandoffToken().then(() => {
                        void refreshHandoff()
                        pushToast({
                          title: '已重新產生權杖',
                          body: '已配對的擴充套件會自動重新配對',
                          tone: 'warn'
                        })
                      })
                    }}
                  />
                </div>
              </Field>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
