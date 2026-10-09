/** The `vscode.LanguageModelChatProvider`: converts VS Code messages to the plain shapes, streams the door's reply back, and records each call for the status bar. */

import * as vscode from 'vscode'
import { buildCopilotUsage, readChatStream } from './chatStream.ts'
import { getReasoningEffort, getReasoningEffortByModel, getSplitOptions } from './config.ts'
import { describeError } from './describeError.ts'
import type { EnginedModelInfo } from './door.ts'
import { servesTokenize } from './door.ts'
import { postChatCompletion, postTokenize } from './doorClient.ts'
import type { FingerprintInput } from './promptFingerprint.ts'
import { describeFingerprint, fingerprint } from './promptFingerprint.ts'
import type { PlainMessage, PlainMessagePart } from './requestBuilder.ts'
import {
  buildChatRequestBody,
  estimateMessageTokenCount,
  plainMessageContent,
} from './requestBuilder.ts'
import { costUsdHeader, routeFromHeaders } from './routeHeaders.ts'
import type { Session } from './session.ts'
import type { CallRecord } from './status.ts'
import { renderStatusBar, startLoadingTimer, stopLoadingTimer } from './statusBar.ts'
import { resolveTokenCount } from './tokenCount.ts'

// --- vscode <-> plain message conversion --------------------------------

function toPlainPart(part: unknown): PlainMessagePart | undefined {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { type: 'text', text: part.value }
  }
  if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
    return {
      type: 'image',
      mimeType: part.mimeType,
      base64: Buffer.from(part.data).toString('base64'),
    }
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return { type: 'toolCall', id: part.callId, name: part.name, arguments: part.input }
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    const text = part.content
      .map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : ''))
      .join('')
    return { type: 'toolResult', toolCallId: part.callId, text }
  }
  return undefined
}

function toPlainMessage(message: vscode.LanguageModelChatRequestMessage): PlainMessage {
  const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user'
  const parts: PlainMessagePart[] = []
  for (const part of message.content) {
    const plain = toPlainPart(part)
    if (plain !== undefined) {
      parts.push(plain)
    }
  }
  return { role, parts }
}

export class EnginedChatProvider implements vscode.LanguageModelChatProvider<EnginedModelInfo> {
  readonly #s: Session
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>

  constructor(s: Session) {
    this.#s = s
    this.onDidChangeLanguageModelChatInformation = s.modelsChanged.event
  }

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<EnginedModelInfo[]> {
    return [...this.#s.poller.models]
  }

  async provideLanguageModelChatResponse(
    ...args: Parameters<
      vscode.LanguageModelChatProvider<EnginedModelInfo>['provideLanguageModelChatResponse']
    >
  ): Promise<void> {
    const s = this.#s
    const [model, messages, options, progress, token] = args
    const plainMessages = messages.map(toPlainMessage)
    const hadTools = (options.tools?.length ?? 0) > 0
    const body = buildChatRequestBody(model, plainMessages, {
      tools: options.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      toolChoiceRequired: options.toolMode === vscode.LanguageModelChatToolMode.Required,
      reasoningEffort: getReasoningEffort(),
      reasoningEffortByModel: getReasoningEffortByModel(),
      split: getSplitOptions(),
    })
    if (hadTools) {
      const print: FingerprintInput = {
        messages: body.messages.map((m) => JSON.stringify(m)),
        tools: JSON.stringify(body.tools ?? []),
      }
      const previous = s.lastChatPrint
      s.log(
        describeFingerprint(
          fingerprint(print, previous),
          previous && fingerprint(previous).toolsHash,
        ),
      )
      s.lastChatPrint = print
    }
    const controller = new AbortController()
    token.onCancellationRequested(() => controller.abort())
    const startedAt = Date.now()
    const promptTokenEstimate = plainMessages.reduce(
      (sum, m) => sum + estimateMessageTokenCount(m),
      0,
    )
    const flight = { modelId: model.id, startedAt, promptTokenEstimate }
    s.inFlightChat = flight
    startLoadingTimer(s)
    renderStatusBar(s)
    if (servesTokenize(model.row)) {
      const content = plainMessages.map(plainMessageContent).join('')
      s.background(
        resolveTokenCount(
          s.tokenCountCache,
          () => postTokenize(model.row.door.url, model.row.routeId, content, controller.signal),
          { model: model.id, content, served: true },
        ).then((tokens) => {
          if (s.inFlightChat === flight) {
            flight.promptTokenEstimate = tokens
            renderStatusBar(s)
          }
        }),
      )
    }
    let stream: ReadableStream<Uint8Array>
    let headers: Headers
    try {
      const res = await postChatCompletion(model.row.door.url, body, controller.signal)
      ;({ body: stream, headers } = res)
    } catch (error) {
      s.log(`chat completion failed for ${model.id}: ${describeError(error)}`)
      stopLoadingTimer(s)
      renderStatusBar(s)
      throw asError(error)
    }
    let usage:
      | {
          promptTokens?: number
          completionTokens?: number
          costUsd?: number
          cachedTokens?: number
        }
      | undefined
    let toolCalls: Awaited<ReturnType<typeof readChatStream>>
    try {
      toolCalls = await readChatStream(stream, {
        text: (delta) => {
          if (s.inFlightChat?.firstTokenAt === undefined && s.inFlightChat !== undefined) {
            s.inFlightChat.firstTokenAt = Date.now()
          }
          progress.report(new vscode.LanguageModelTextPart(delta))
        },
        usage: (u) => {
          usage = u
        },
      })
    } finally {
      stopLoadingTimer(s)
    }
    const copilotUsage = usage === undefined ? undefined : buildCopilotUsage(usage)
    if (copilotUsage !== undefined) {
      progress.report(
        new vscode.LanguageModelDataPart(
          new TextEncoder().encode(JSON.stringify(copilotUsage)),
          'usage',
        ),
      )
    }
    const resolved = routeFromHeaders(headers, { id: model.id, egress: model.row.egress })
    const record: CallRecord = {
      route: resolved.route,
      egress: resolved.egress,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      wallMs: Date.now() - startedAt,
      costUsd: usage?.costUsd ?? costUsdHeader(headers),
      promptTokenMax: model.maxInputTokens,
    }
    if (hadTools) {
      s.lastChatCall = record
    } else {
      s.lastBackgroundCall = record
    }
    renderStatusBar(s)
    for (const call of toolCalls) {
      progress.report(
        new vscode.LanguageModelToolCallPart(call.id, call.name, call.arguments ?? {}),
      )
    }
  }

  provideTokenCount(
    model: EnginedModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    const s = this.#s
    const content = typeof text === 'string' ? text : plainMessageContent(toPlainMessage(text))
    const controller = new AbortController()
    token.onCancellationRequested(() => controller.abort())
    return resolveTokenCount(
      s.tokenCountCache,
      (_m, c) => postTokenize(model.row.door.url, model.row.routeId, c, controller.signal),
      { model: model.id, content, served: servesTokenize(model.row) },
    )
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
