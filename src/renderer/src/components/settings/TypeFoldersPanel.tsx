import {
  ArrowDown,
  ArrowUp,
  FolderOpen,
  FolderTree,
  Plus,
  RotateCcw
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  categoryDisplayName,
  categoryFolderName,
  categoryFolderPath,
  isBuiltinCategory
} from '@shared/categories'
import { t } from '@shared/i18n'
import type { CategoryRule } from '@shared/settings'

import { cn } from '../../lib/cn'
import { categoryIcon } from '../../lib/category-icons'
import { useApp } from '../../store/app-store'
import {
  Badge,
  Button,
  Field,
  IconButton,
  Input,
  Row,
  SectionTitle,
  Toggle
} from '../ui/primitives'

/** A category being edited, plus the two bits of state a form needs. */
interface Draft {
  rule: CategoryRule
  /** True once the name field has been typed in; otherwise a built-in stays localized. */
  nameTouched: boolean
  /** The destination card the user picked, which may not have a folder yet. */
  customDestination: boolean
}

/** How many extension chips fit on a row before the rest collapse into `+N`. */
const VISIBLE_EXTENSIONS = 4

export function TypeFoldersPanel(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const patch = useApp((state) => state.patchSettings)
  const pushToast = useApp((state) => state.pushToast)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [resetArmed, setResetArmed] = useState(false)
  const resetTimer = useRef<number | null>(null)
  const newEditor = useRef<HTMLDivElement | null>(null)

  // A reset is a confirm-again action rather than a modal: the list underneath
  // stays usable, and the button goes back to its normal label on its own.
  useEffect(() => {
    if (!resetArmed) return undefined
    resetTimer.current = window.setTimeout(() => setResetArmed(false), 5000)
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    }
  }, [resetArmed])

  if (!settings) return <></>

  const categories = settings.categories ?? []
  const sortOn = settings.sortDownloadsByType === true
  const anyCustom = categories.some((rule) => rule.dir.length > 0)

  const destinationOf = (rule: CategoryRule): string =>
    categoryFolderPath(categories, rule.id, settings.downloadDir, sortOn)

  const chooseFolder = async (initial: string): Promise<string> => {
    const chosen = await window.api.settings.chooseDirectory(initial || settings.downloadDir)
    return chosen ?? ''
  }

  const openFolder = (path: string): void => {
    if (path.length === 0) return
    void window.api.app.reveal(path).catch(() => {
      pushToast({ title: t('settings.folders.open'), body: t('settings.folders.openMissing'), tone: 'warn' })
    })
  }

  const startNew = (): void => {
    setDraft({
      rule: {
        id: `cat-${Date.now()}`,
        name: t('settings.categories.new'),
        extensions: [],
        dir: '',
        folderName: '',
        postAction: {}
      },
      nameTouched: true,
      customDestination: false
    })
    // The editor is appended below a list that can be taller than the visible
    // panel; wait for it to render, then bring it into view once. Scrolling from
    // an effect on `draft` would jump on every keystroke.
    window.setTimeout(() => newEditor.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0)
  }

  const startEdit = (rule: CategoryRule): void => {
    setDraft({ rule: { ...rule }, nameTouched: false, customDestination: rule.dir.length > 0 })
  }

  const move = async (id: string, delta: number): Promise<void> => {
    const index = categories.findIndex((entry) => entry.id === id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= categories.length) return
    const next = [...categories]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved!)
    await patch({ categories: next })
  }

  const resetAll = async (): Promise<void> => {
    if (!resetArmed) {
      setResetArmed(true)
      return
    }
    setResetArmed(false)
    await patch({ categories: categories.map((entry) => ({ ...entry, dir: '' })) })
    pushToast({ title: t('settings.folders.resetDone'), body: '', tone: 'success' })
  }

  const save = async (current: Draft): Promise<void> => {
    const original = categories.find((entry) => entry.id === current.rule.id)
    const name = current.nameTouched ? current.rule.name.trim() : (original?.name ?? current.rule.name)
    const dir = current.customDestination ? current.rule.dir.trim() : ''

    if (name.length === 0) {
      pushToast({ title: t('settings.folders.saveFailed'), body: t('settings.folders.nameRequired'), tone: 'error' })
      return
    }
    if (current.customDestination && dir.length === 0) {
      pushToast({ title: t('settings.folders.saveFailed'), body: t('settings.folders.absolutePath'), tone: 'error' })
      return
    }

    setSaving(true)
    try {
      const next = await window.api.settings.saveCategory({
        ...current.rule,
        name,
        dir,
        folderName: (current.rule.folderName ?? '').trim()
      })
      useApp.setState({ settings: next })
      setDraft(null)
      pushToast({ title: t('settings.folders.saved'), body: categoryDisplayName({ ...current.rule, name }), tone: 'success' })
    } catch (error) {
      pushToast({ title: t('settings.folders.saveFailed'), body: (error as Error).message, tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const editor = (current: Draft): JSX.Element => {
    const rule = current.rule
    // The default card must ignore the custom folder the draft currently holds:
    // it is the answer to "what would happen with this option instead?".
    const defaultPath = categoryFolderPath(
      [{ ...rule, dir: '' }],
      rule.id,
      settings.downloadDir,
      sortOn
    )
    const folderPreview = categoryFolderName({ ...rule, folderName: rule.folderName ?? '' })

    return (
      <div className="mt-3 space-y-3 border-t border-line pt-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t('common.name')}
            hint={isBuiltinCategory(rule.id) && !current.nameTouched ? t('settings.folders.nameHint') : undefined}
          >
            <Input
              value={current.nameTouched ? rule.name : categoryDisplayName(rule)}
              onChange={(event) =>
                setDraft({ ...current, nameTouched: true, rule: { ...rule, name: event.target.value } })
              }
            />
          </Field>
          <Field label={t('settings.folders.folderName')} hint={t('settings.folders.folderNameHint')}>
            <Input
              value={rule.folderName ?? ''}
              placeholder={folderPreview}
              disabled={current.customDestination}
              onChange={(event) =>
                setDraft({ ...current, rule: { ...rule, folderName: event.target.value } })
              }
            />
          </Field>
        </div>

        <Field label={t('settings.categories.extensions')} hint={t('settings.categories.extensionsHint')}>
          <Input
            value={rule.extensions.join(', ')}
            onChange={(event) =>
              setDraft({
                ...current,
                rule: {
                  ...rule,
                  extensions: event.target.value
                    .split(',')
                    .map((value) => value.trim().toLowerCase().replace(/^\./, ''))
                    .filter(Boolean)
                }
              })
            }
          />
        </Field>

        <div>
          <span className="text-[12px] font-medium text-muted">{t('settings.folders.destination')}</span>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              aria-pressed={!current.customDestination}
              onClick={() =>
                setDraft({ ...current, customDestination: false, rule: { ...rule, dir: '' } })
              }
              className={cn(
                'rounded-lg border px-3 py-2 text-left transition-colors',
                current.customDestination
                  ? 'border-line bg-elevated/30 text-muted hover:border-brand/40'
                  : 'border-brand/60 bg-brand/10 text-fg'
              )}
            >
              <span className="block text-[12px] font-medium">{t('settings.folders.destinationDefault')}</span>
              <span className="mt-0.5 block truncate font-mono text-[10.5px] text-faint" title={defaultPath}>
                {defaultPath}
              </span>
            </button>

            <button
              type="button"
              aria-pressed={current.customDestination}
              onClick={() => {
                setDraft({ ...current, customDestination: true })
                if (rule.dir.trim().length === 0) {
                  void chooseFolder(settings.downloadDir).then((chosen) => {
                    if (chosen) setDraft({ ...current, customDestination: true, rule: { ...rule, dir: chosen } })
                  })
                }
              }}
              className={cn(
                'rounded-lg border px-3 py-2 text-left transition-colors',
                current.customDestination
                  ? 'border-brand/60 bg-brand/10 text-fg'
                  : 'border-line bg-elevated/30 text-muted hover:border-brand/40'
              )}
            >
              <span className="block text-[12px] font-medium">{t('settings.folders.destinationCustom')}</span>
              <span className="mt-0.5 block truncate font-mono text-[10.5px] text-faint" title={rule.dir}>
                {rule.dir || '…'}
              </span>
            </button>
          </div>

          {current.customDestination && (
            <>
              <div className="mt-2 flex gap-2">
                <Input
                  value={rule.dir}
                  placeholder={t('settings.folders.absolutePath')}
                  onChange={(event) =>
                    setDraft({ ...current, rule: { ...rule, dir: event.target.value } })
                  }
                  className="font-mono text-[12px]"
                />
                <Button
                  variant="secondary"
                  icon={<FolderOpen size={14} />}
                  aria-label={t('settings.folders.change')}
                  onClick={() => {
                    void chooseFolder(rule.dir).then((chosen) => {
                      if (chosen) setDraft({ ...current, customDestination: true, rule: { ...rule, dir: chosen } })
                    })
                  }}
                />
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-faint">{t('settings.folders.customHint')}</p>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={saving} onClick={() => void save(current)}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    )
  }

  const row = (rule: CategoryRule, index: number): JSX.Element => {
    const custom = rule.dir.length > 0
    const destination = destinationOf(rule)
    const editing = draft?.rule.id === rule.id
    const extensions = rule.extensions.slice(0, VISIBLE_EXTENSIONS)
    const extra = rule.extensions.length - extensions.length

    return (
      <div key={rule.id} className="rounded-xl border border-line bg-elevated/30 p-3">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
            {categoryIcon(rule.id)}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[13px] font-medium text-fg">{categoryDisplayName(rule)}</p>
              <Badge tone={custom ? 'brand' : 'muted'}>{custom ? t('settings.folders.custom') : t('settings.folders.default')}</Badge>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-1">
              {extensions.length === 0 ? (
                <span className="text-[11px] text-faint">
                  {rule.id === 'other' ? t('settings.folders.otherHint') : t('settings.categories.noExtensions')}
                </span>
              ) : (
                <>
                  {extensions.map((extension) => (
                    <span key={extension} className="chip bg-line/50 font-mono text-[10.5px] text-muted">
                      {extension}
                    </span>
                  ))}
                  {extra > 0 && <span className="text-[10.5px] text-faint">+{extra}</span>}
                </>
              )}
            </div>

            <p
              className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-muted"
              title={destination}
            >
              <FolderTree size={11} className="shrink-0 text-faint" />
              <span className="truncate">{destination}</span>
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton
              label={t('settings.folders.moveUp')}
              icon={<ArrowUp size={13} />}
              disabled={index === 0}
              onClick={() => void move(rule.id, -1)}
            />
            <IconButton
              label={t('settings.folders.moveDown')}
              icon={<ArrowDown size={13} />}
              disabled={index === categories.length - 1}
              onClick={() => void move(rule.id, 1)}
            />
            <IconButton
              label={t('settings.folders.open')}
              icon={<FolderOpen size={13} />}
              onClick={() => openFolder(destination)}
            />
            <Button variant={editing ? 'ghost' : 'secondary'} size="sm" onClick={() => startEdit(rule)}>
              {t('common.edit')}
            </Button>
          </div>
        </div>

        {editing && draft && editor(draft)}
      </div>
    )
  }

  const newDraft = draft && !categories.some((entry) => entry.id === draft.rule.id) ? draft : null

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>{t('settings.downloadDirSection')}</SectionTitle>
        <Field label={t('settings.downloadDir')}>
          <div className="flex gap-2">
            <Input
              value={settings.downloadDir}
              onChange={(event) => void patch({ downloadDir: event.target.value })}
            />
            <Button
              variant="secondary"
              icon={<FolderOpen size={14} />}
              aria-label={t('settings.folders.change')}
              onClick={() => {
                void window.api.settings.chooseDirectory(settings.downloadDir).then((chosen) => {
                  if (chosen) void patch({ downloadDir: chosen })
                })
              }}
            />
          </div>
        </Field>

        <div className="mt-3 rounded-lg border border-line bg-elevated/30 px-3">
          <Row label={t('settings.sortByType')} hint={t('settings.sortByTypeHint')}>
            <Toggle
              checked={sortOn}
              onChange={(next) => void patch({ sortDownloadsByType: next })}
              label={t('settings.sortByType')}
            />
          </Row>
        </div>
      </section>

      <section>
        <SectionTitle
          action={
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                icon={<RotateCcw size={13} />}
                disabled={!anyCustom}
                onClick={() => void resetAll()}
              >
                {resetArmed ? t('settings.folders.resetAllConfirm') : t('settings.folders.resetAll')}
              </Button>
              <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={startNew}>
                {t('common.add')}
              </Button>
            </div>
          }
        >
          {t('settings.folders.types')}
        </SectionTitle>

        <p className="mb-3 rounded-lg border border-line bg-elevated/30 p-2.5 text-[11px] leading-relaxed text-muted">
          {t('settings.folders.typesHint')}
        </p>

        <div className="space-y-2">
          {categories.length === 0 && <p className="text-[12px] text-faint">{t('settings.folders.empty')}</p>}
          {categories.map((rule, index) => row(rule, index))}
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-faint">{t('settings.folders.orderHint')}</p>

        {newDraft && (
          <div ref={newEditor} className="mt-3 rounded-xl border border-brand/40 bg-brand/5 p-3">
            <p className="text-[13px] font-medium text-fg">{t('settings.categories.new')}</p>
            {editor(newDraft)}
          </div>
        )}
      </section>
    </div>
  )
}
