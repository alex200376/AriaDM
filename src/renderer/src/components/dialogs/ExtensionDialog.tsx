import { Check, Copy, FolderOpen, RefreshCw, Sparkles } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../lib/i18n'
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
  const t = useT()

  const open = dialog === 'extension'
  if (!open) return null

  const copy = (value: string, label: string): void => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(label)
      pushToast({ title: t('extension.copied', { name: label }), body: '', tone: 'info' })
      window.setTimeout(() => setCopied(''), 1500)
    })
  }

  return (
    <Modal
      open={open}
      title={t('extension.title')}
      subtitle={t('extension.subtitle')}
      onClose={closeDialog}
      width="max-w-2xl"
      footer={
        <>
          <Button
            variant="secondary"
            icon={<FolderOpen size={14} />}
            onClick={() => {
              void useApp
                .getState()
                .runAction(t('extension.openFolder'), async () => {
                  await window.api.integrations.openExtensionFolder()
                })
            }}
          >
            {t('extension.openFolder')}
          </Button>
          <Button variant="primary" onClick={closeDialog}>
            {t('extension.done')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2 rounded-lg border border-line bg-elevated/30 p-3">
          <p className="text-[11.5px] leading-relaxed text-muted">{t('extension.intro')}</p>
          <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-muted">
            <Sparkles size={12} className="mt-0.5 shrink-0 text-brand" />
            <span>{t('extension.noSetup')}</span>
          </p>
        </div>

        {handoff && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={handoff.running ? 'ok' : 'danger'} dot>
              {handoff.running
                ? t('extension.ready', { port: handoff.port })
                : t('extension.notRunning')}
            </Badge>
            {handoff.running && handoff.discoveryPort > 0 && (
              <span className="text-[11px] text-faint">
                {t('extension.discoveryPort', { port: handoff.discoveryPort })}
              </span>
            )}
            {handoff.running && handoff.discoveryPort === 0 && (
              <span className="text-[11px] text-faint">
                {t('extension.discoveryBlocked', { ports: handoff.discoveryPorts.join(', ') })}
              </span>
            )}
            {!handoff.running && (
              <span className="text-[11px] text-faint">{t('extension.enableHint')}</span>
            )}
          </div>
        )}

        <div className="space-y-4">
          <SectionTitle>{t('extension.chromeSteps')}</SectionTitle>
          <Step index={1} title={t('extension.stepOpen')}>
            {t('extension.stepOpenBody')}
          </Step>
          <Step index={2} title={t('extension.stepDevMode')}>
            {t('extension.stepDevModeBody')}
          </Step>
          <Step index={3} title={t('extension.stepLoad')}>
            {t('extension.stepLoadBody')}
          </Step>
          <Step index={4} title={t('extension.stepDone')}>
            {t('extension.stepDoneBody')}
          </Step>
        </div>

        <div className="space-y-4">
          <SectionTitle>{t('extension.firefoxSteps')}</SectionTitle>
          <Step index={1} title={t('extension.ffStepDebug')}>
            {t('extension.ffStepDebugBody')}
          </Step>
          <Step index={2} title={t('extension.ffStepLoad')}>
            {t('extension.ffStepLoadBody')}
          </Step>
          <Step index={3} title={t('extension.stepDone')}>
            {t('extension.ffStepDoneBody')}
          </Step>
        </div>

        <div className="border-t border-line pt-4">
          <button
            type="button"
            onClick={() => setAdvanced((value) => !value)}
            className="text-[12px] text-brand hover:underline"
          >
            {advanced ? t('extension.advancedHide') : t('extension.advancedShow')}
          </button>

          {advanced && handoff && (
            <div className="mt-3 space-y-3 rounded-lg border border-line bg-elevated/30 p-3">
              <p className="text-[11.5px] leading-relaxed text-muted">{t('extension.advancedHint')}</p>
              <Field label={t('extension.apiUrl')} hint={t('extension.apiUrlHint')}>
                <div className="flex gap-2">
                  <Input readOnly value={handoff.url} className="font-mono text-[11px]" data-selectable />
                  <Button
                    variant="secondary"
                    icon={copied === t('extension.url') ? <Check size={14} /> : <Copy size={14} />}
                    onClick={() => copy(handoff.url, t('extension.url'))}
                  />
                </div>
              </Field>

              <Field label={t('extension.token')} hint={t('extension.tokenHint')}>
                <div className="flex gap-2">
                  <Input readOnly value={handoff.token} className="font-mono text-[11px]" data-selectable />
                  <Button
                    variant="secondary"
                    icon={copied === t('extension.token') ? <Check size={14} /> : <Copy size={14} />}
                    onClick={() => copy(handoff.token, t('extension.token'))}
                  />
                  <Button
                    variant="ghost"
                    icon={<RefreshCw size={14} />}
                    onClick={() => {
                      void window.api.integrations.rotateHandoffToken().then(() => {
                        void refreshHandoff()
                        pushToast({
                          title: t('extension.rotate'),
                          body: t('extension.rotateBody'),
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
