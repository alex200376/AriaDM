import type { DownloadItem } from '@shared/download'
import type { PostAction } from '@shared/settings'

/**
 * Post-download actions.
 *
 * Platform side effects are injected rather than imported so this module stays
 * testable outside Electron and cannot accidentally reach the shell.
 */
export interface PostActionDeps {
  /** Returns an empty string on success, or a human readable error. */
  openPath(target: string): Promise<string>
  showItemInFolder(target: string): void
  notify(payload: { title: string; body: string }): void
  /** Runs a command. Must not use a shell. */
  execCommand(file: string, args: string[]): void
  log(line: string): void
}

export interface PostActionOutcome {
  ran: string[]
  error: string
}

/**
 * Split a user supplied command line into an argv array.
 *
 * Supports double and single quotes so a path containing spaces can be passed.
 * This is deliberately a tokenizer rather than anything shell-aware: the result
 * is handed to execFile, so quotes, pipes, `&&` and redirection are inert text
 * rather than something the operating system will act on.
 */
export function splitCommandLine(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasContent = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!

    if (quote) {
      if (char === quote) {
        quote = null
        hasContent = true
        continue
      }
      if (char === '\\' && index + 1 < input.length) {
        // Inside double quotes, honour backslash escapes; inside single quotes
        // treat the backslash literally, matching common shell behaviour.
        const next = input[index + 1]!
        if (quote === '"' && (next === '"' || next === '\\')) {
          current += next
          index += 1
          continue
        }
      }
      current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      hasContent = true
      continue
    }

    if (char === ' ' || char === '\t') {
      if (current.length > 0 || hasContent) {
        tokens.push(current)
        current = ''
        hasContent = false
      }
      continue
    }

    current += char
  }

  if (current.length > 0 || hasContent) tokens.push(current)
  return tokens
}

/**
 * The path a completion should act on. For a multi-file torrent the meaningful
 * target is the containing directory rather than one arbitrary piece.
 */
export function primaryTarget(item: Pick<DownloadItem, 'files' | 'dir' | 'kind'>): string {
  const first = item.files.find((file) => file.path.length > 0)
  if (!first) return item.dir
  if (item.files.length > 1) return item.dir
  return first.path
}

export function expandCommandTemplate(
  tokens: string[],
  context: { file: string; dir: string; name: string }
): string[] {
  return tokens.map((token) =>
    token
      .replace(/%f/g, context.file)
      .replace(/%d/g, context.dir)
      .replace(/%n/g, context.name)
  )
}

export async function runPostAction(
  deps: PostActionDeps,
  action: PostAction,
  item: DownloadItem
): Promise<PostActionOutcome> {
  const ran: string[] = []
  const target = primaryTarget(item)

  if (action.openFile && target) {
    try {
      const error = await deps.openPath(target)
      if (error) return { ran, error: `無法開啟檔案：${error}` }
      ran.push('openFile')
    } catch (error) {
      return { ran, error: `無法開啟檔案：${(error as Error).message}` }
    }
  }

  if (action.showInFolder && target) {
    try {
      deps.showItemInFolder(target)
      ran.push('showInFolder')
    } catch (error) {
      return { ran, error: `無法開啟資料夾：${(error as Error).message}` }
    }
  }

  if (action.command.trim().length > 0) {
    const tokens = splitCommandLine(action.command)
    const [file, ...args] = tokens
    if (!file) {
      return { ran, error: '自訂指令為空。' }
    }
    const expanded = expandCommandTemplate(args, { file: target, dir: item.dir, name: item.name })
    try {
      // execFile semantics: no shell, so the command string cannot inject.
      deps.execCommand(file, expanded)
      ran.push('command')
    } catch (error) {
      return { ran, error: `自訂指令失敗：${(error as Error).message}` }
    }
  }

  if (action.notify) {
    try {
      deps.notify({ title: '下載完成', body: item.name })
      ran.push('notify')
    } catch (error) {
      deps.log(`notification failed: ${(error as Error).message}`)
    }
  }

  return { ran, error: '' }
}

/** Text describing what a configured action will do, for the settings UI. */
export function describePostAction(action: PostAction): string {
  const parts: string[] = []
  if (action.openFile) parts.push('開啟檔案')
  if (action.showInFolder) parts.push('開啟資料夾')
  if (action.notify) parts.push('系統通知')
  if (action.command.trim()) parts.push(`執行指令（${action.command.trim()}）`)
  return parts.length > 0 ? parts.join('、') : '不執行任何動作'
}
