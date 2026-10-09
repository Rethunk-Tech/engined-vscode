/** The inline-completion (ghost text) provider and the open-document tracking its neighbour context draws on. */

import * as vscode from 'vscode'
import {
  buildCompletionsRequestBody,
  COMPLETIONS_PATH,
  extractCompletionText,
  extractCompletionUsage,
  sliceContext,
} from './completions.ts'
import { getCompletionsEnabled, getDefaultModel, getNeighbourContextEnabled } from './config.ts'
import { logUnusableIfChanged, resolveDefaultModel } from './defaultModels.ts'
import { describeError } from './describeError.ts'
import { postJsonWithHeaders } from './doorClient.ts'
import type { NeighbourCandidate } from './neighbourContext.ts'
import { selectSnippets, trackRecent } from './neighbourContext.ts'
import { costUsdHeader, routeFromHeaders } from './routeHeaders.ts'
import type { Session } from './session.ts'
import { isLocalEgress } from './status.ts'
import { renderStatusBar } from './statusBar.ts'

const RECENT_DOCUMENTS_CAP = 10

// --- inline completions (ghost text) ---------------------------------------

const COMPLETIONS_DEBOUNCE_MS = 250

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export class EnginedInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  readonly #s: Session

  constructor(s: Session) {
    this.#s = s
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const s = this.#s
    if (!getCompletionsEnabled()) {
      return undefined
    }
    if (vscode.window.activeTextEditor?.selection.isEmpty === false) {
      return undefined
    }
    const completionModel = resolveDefaultModel(
      s.poller.rows,
      'completion',
      getDefaultModel('completion'),
    )
    logUnusableIfChanged(
      s.loggedUnusableReasons,
      s.log,
      'completion',
      completionModel.unusableReason,
    )
    const model = completionModel.row
    if (model === undefined) {
      return undefined
    }
    const controller = new AbortController()
    token.onCancellationRequested(() => controller.abort())
    await delay(COMPLETIONS_DEBOUNCE_MS, controller.signal)
    if (token.isCancellationRequested) {
      return undefined
    }
    const { prefix, suffix } = sliceContext(document.getText(), document.offsetAt(position))
    const extra =
      getNeighbourContextEnabled() && isLocalEgress(model.egress)
        ? selectSnippets(
            gatherNeighbourCandidates(s, document),
            vscode.workspace.asRelativePath(document.uri, false),
            excludeGlobs(),
          )
        : undefined
    const body = buildCompletionsRequestBody(model.routeId, prefix, suffix, extra)
    const startedAt = Date.now()
    let reply: unknown
    let headers: Headers
    try {
      const res = await postJsonWithHeaders(
        model.door.url,
        COMPLETIONS_PATH,
        body,
        controller.signal,
      )
      ;({ data: reply, headers } = res)
    } catch (error) {
      if (!token.isCancellationRequested) {
        s.log(`completion failed for ${model.id}: ${describeError(error)}`)
      }
      return undefined
    }
    const resolved = routeFromHeaders(headers, { id: model.id, egress: model.egress })
    const usage = extractCompletionUsage(reply)
    s.lastCompletionCall = {
      route: resolved.route,
      egress: resolved.egress,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      wallMs: Date.now() - startedAt,
      costUsd: costUsdHeader(headers),
    }
    renderStatusBar(s)
    const text = extractCompletionText(reply)
    return text === undefined ? undefined : [new vscode.InlineCompletionItem(text)]
  }
}

// --- neighbouring-file context for completions -----------------------------

/** `files.exclude`/`search.exclude` keys whose value is `true` -- the same globs VS Code itself hides. */
function excludeGlobs(): string[] {
  const files = vscode.workspace
    .getConfiguration('files')
    .get<Record<string, boolean>>('exclude', {})
  const search = vscode.workspace
    .getConfiguration('search')
    .get<Record<string, boolean>>('exclude', {})
  return Object.entries({ ...files, ...search })
    .filter(([, enabled]) => enabled)
    .map(([glob]) => glob)
}

/** Visible editors first (with a live cursor), then recently active documents this session, current document excluded by the caller (`selectSnippets`). */
function gatherNeighbourCandidates(s: Session, current: vscode.TextDocument): NeighbourCandidate[] {
  const candidates: NeighbourCandidate[] = []
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document === current) {
      continue
    }
    candidates.push({
      filename: vscode.workspace.asRelativePath(editor.document.uri, false),
      scheme: editor.document.uri.scheme,
      text: editor.document.getText(),
      cursorOffset: editor.document.offsetAt(editor.selection.active),
    })
  }
  for (const doc of s.recentDocuments) {
    if (doc === current || doc.isClosed) {
      continue
    }
    candidates.push({
      filename: vscode.workspace.asRelativePath(doc.uri, false),
      scheme: doc.uri.scheme,
      text: doc.getText(),
    })
  }
  return candidates
}

export function trackActiveEditor(s: Session, editor: vscode.TextEditor | undefined): void {
  if (editor === undefined) {
    return
  }
  trackRecent(s.recentDocuments, editor.document, RECENT_DOCUMENTS_CAP)
}
