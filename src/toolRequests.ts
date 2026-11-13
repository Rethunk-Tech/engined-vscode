/**
 * Request shapes for the four `engined_*` tools. The builders are pure: they
 * take the row `defaultModels.ts` (`resolveDefaultModel`) already chose.
 * `requestSpeech` is the one call that talks to the door, because a workspace
 * voice file has to be uploaded before the speech body can name it.
 */

import { BYTES_PER_KIB } from './constants.ts'
import type { EnginedModelRow } from './door.ts'
import { postForm, postJson } from './doorClient.ts'
import { resolveWorkspacePath } from './pathGuard.ts'
import { isLocalEgress } from './status.ts'

const IMAGE_SIDE_MIN = 64
const IMAGE_SIDE_MAX = 4096
const IMAGE_SIDE_STEP = 8

export class ToolRouteError extends Error {}

export interface ImageGenerationRequest {
  path: '/openai/v1/images/generations'
  body: { model: string; prompt: string; size?: string; response_format: 'b64_json' }
}

export interface ImageEditRequest {
  path: '/openai/v1/images/edits'
  form: { model: string; prompt: string; image: Blob; response_format: 'b64_json' }
}

const IMAGE_SIZE = /^([0-9]+)x([0-9]+)$/

/** WxH, each side 64–4096 and a multiple of 8 — the door's `/openai/v1/images` `size` rule. */
function assertImageSize(size: string | undefined): void {
  if (size === undefined) {
    return
  }
  const match = IMAGE_SIZE.exec(size)
  const sideOk = (n: number): boolean =>
    n >= IMAGE_SIDE_MIN && n <= IMAGE_SIDE_MAX && n % IMAGE_SIDE_STEP === 0
  if (match === null || !sideOk(Number(match[1])) || !sideOk(Number(match[2]))) {
    throw new ToolRouteError('size must be WxH with each side 64-4096 and a multiple of 8')
  }
}

/** No `source` -> generation; a `source` -> an edit of it. Both need the `comfy` image route (engined src/images.ts / src/imageEdits.ts). */
export function buildImageRequest(
  row: EnginedModelRow,
  input: { prompt: string; size?: string; source?: Blob },
): ImageGenerationRequest | ImageEditRequest {
  assertImageSize(input.size)
  if (input.source !== undefined) {
    return {
      path: '/openai/v1/images/edits',
      form: {
        model: row.routeId,
        prompt: input.prompt,
        image: input.source,
        response_format: 'b64_json',
      },
    }
  }
  return {
    path: '/openai/v1/images/generations',
    body: {
      model: row.routeId,
      prompt: input.prompt,
      size: input.size,
      response_format: 'b64_json',
    },
  }
}

export interface ReadImageRequest {
  model: string
  messages: [
    {
      role: 'user'
      content: [{ type: 'text'; text: string }, { type: 'image_url'; image_url: { url: string } }]
    },
  ]
}

/** A one-shot chat completion against the vision row, image as a data URI. */
export function buildReadImageRequest(
  row: EnginedModelRow,
  input: { mode: 'ocr' | 'describe'; question?: string; mimeType: string; base64: string },
): ReadImageRequest {
  const prompt =
    input.question ??
    (input.mode === 'ocr' ? 'Transcribe every visible character exactly.' : 'Describe this image.')
  return {
    model: row.routeId,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:${input.mimeType};base64,${input.base64}` },
          },
        ],
      },
    ],
  }
}

export interface TranscribeRequest {
  path: '/openai/v1/audio/transcriptions' | '/openai/v1/audio/translations'
  form: { model: string; file: Blob }
}

export const TRANSLATE_UNAVAILABLE =
  'Speech translation is not offered until a quality probe passes; transcribe the file and translate the text with a chat model.'

/** `undefined` means transcribe. A string is the tool-result refusal. */
export function refuseTranslate(
  translate: boolean | undefined,
  probe?: { quality?: boolean },
): string | undefined {
  if (translate !== true || probe?.quality === true) {
    return undefined
  }
  return TRANSLATE_UNAVAILABLE
}

export function buildTranscribeRequest(
  row: EnginedModelRow,
  input: { audio: Blob; translate?: boolean },
): TranscribeRequest {
  return {
    path:
      input.translate === true
        ? '/openai/v1/audio/translations'
        : '/openai/v1/audio/transcriptions',
    form: { model: row.routeId, file: input.audio },
  }
}

export interface SpeakRequest {
  path: '/openai/v1/audio/speech'
  body: { model: string; input: string; voice?: string }
}

export function buildSpeakRequest(
  row: EnginedModelRow,
  input: { text: string; voice?: string },
): SpeakRequest {
  return {
    path: '/openai/v1/audio/speech',
    body: { model: row.routeId, input: input.text, voice: input.voice },
  }
}

const VOICE_UPLOAD_PATH = '/engined/v1/audio/voices'

const MAX_VOICE_MIB = 20
export const MAX_VOICE_BYTES = MAX_VOICE_MIB * BYTES_PER_KIB * BYTES_PER_KIB

const MAX_TOOL_READ_MIB = 32
export const MAX_TOOL_READ_BYTES = MAX_TOOL_READ_MIB * BYTES_PER_KIB * BYTES_PER_KIB

/** Throws when a tool would read more than `MAX_TOOL_READ_BYTES`. `undefined` is not a file, so the caller’s read still surfaces the missing-path error. */
export function checkToolReadSize(size: number | undefined): void {
  if (size !== undefined && size > MAX_TOOL_READ_BYTES) {
    throw new ToolRouteError(`file is over the ${MAX_TOOL_READ_MIB} MiB limit`)
  }
}

const VOICE_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'webm']

interface WorkspaceFiles {
  roots: readonly string[]
  /** Size in bytes of a regular file, or `undefined` when there is none. Never reads the content. */
  fileSize: (absolutePath: string) => Promise<number | undefined>
  readFile: (absolutePath: string) => Promise<Uint8Array | undefined>
}

/** A `vc_` string is already a handle. One the door did not issue is its 400, not a file to upload. */
function isVoiceHandle(voice: string): boolean {
  return voice.startsWith('vc_')
}

/** `a/b.wav` is a path; `af_heart` is a name. A name must not be refused just because no folder is open. */
function isVoicePath(voice: string): boolean {
  return voice.startsWith('.') || voice.includes('/') || voice.includes('\\')
}

function voiceFileName(voice: string): string {
  const base = voice.slice(Math.max(voice.lastIndexOf('/'), voice.lastIndexOf('\\')) + 1)
  return base === '' ? 'voice.wav' : base
}

function uploadedHandle(uploaded: unknown): string {
  if (
    uploaded !== null &&
    typeof uploaded === 'object' &&
    'voice' in uploaded &&
    typeof uploaded.voice === 'string' &&
    uploaded.voice !== ''
  ) {
    return uploaded.voice
  }
  throw new ToolRouteError('engined returned no voice handle')
}

/**
 * Output and optional source paths for `engined_generateImage`, resolved
 * before any read or door call so an escaping output cannot still spend a render.
 */
export function generateImageWorkspacePaths(
  roots: readonly string[],
  input: { outputPath: string; sourcePath?: string },
): { output: string; source?: string } {
  const output = resolveWorkspacePath(roots, input.outputPath)
  const source =
    input.sourcePath === undefined ? undefined : resolveWorkspacePath(roots, input.sourcePath)
  return { output, source }
}

/**
 * The absolute workspace path `voice` would be read from and uploaded, or
 * `undefined` for a handle, or a bare name with no folder open. Throws
 * `PathEscapeError` for a path outside every root.
 */
export function voiceUploadPath(
  voice: string | undefined,
  roots: readonly string[],
): string | undefined {
  if (voice === undefined || isVoiceHandle(voice)) {
    return undefined
  }
  if (roots.length === 0 && !isVoicePath(voice)) {
    return undefined
  }
  return resolveWorkspacePath(roots, voice)
}

/** The speak confirmation's action, naming the workspace file the call uploads as its voice. */
export function speakAction(voiceFile: string | undefined): string {
  return voiceFile === undefined ? 'Speak text' : `Speak text, uploading voice file ${voiceFile}`
}

/**
 * Whether `absolute` is an existing file that may be uploaded as a voice. Throws
 * `ToolRouteError` for a file that is not audio or is over the cap; the size comes from
 * a stat, so a refused file is never read.
 */
export async function checkVoiceFile(
  absolute: string,
  fileSize: WorkspaceFiles['fileSize'],
): Promise<boolean> {
  const size = await fileSize(absolute)
  if (size === undefined) {
    return false
  }
  const extension = absolute.slice(absolute.lastIndexOf('.') + 1).toLowerCase()
  if (!(absolute.includes('.') && VOICE_EXTENSIONS.includes(extension))) {
    throw new ToolRouteError(
      `voice file must be audio (${VOICE_EXTENSIONS.join(', ')}); refusing ${voiceFileName(absolute)}`,
    )
  }
  if (size > MAX_VOICE_BYTES) {
    throw new ToolRouteError(`voice file is over the ${MAX_VOICE_MIB} MiB limit`)
  }
  return true
}

async function voiceForSpeech(
  voice: string | undefined,
  workspace: WorkspaceFiles,
  upload: (file: File) => Promise<unknown>,
): Promise<string | undefined> {
  const absolute = voiceUploadPath(voice, workspace.roots)
  if (voice === undefined || absolute === undefined) {
    return voice
  }
  if (!(await checkVoiceFile(absolute, workspace.fileSize))) {
    return voice
  }
  const bytes = await workspace.readFile(absolute)
  if (bytes === undefined) {
    return voice
  }
  return uploadedHandle(await upload(new File([new Uint8Array(bytes)], voiceFileName(voice))))
}

/** Speak `input.text`. A workspace voice file is cloned on `row.door` first; the speech POST then names the handle. */
export async function requestSpeech(
  row: EnginedModelRow,
  input: { text: string; voice?: string; outputPath?: string },
  workspace: WorkspaceFiles,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (input.outputPath !== undefined) {
    resolveWorkspacePath(workspace.roots, input.outputPath)
  }
  const voice = await voiceForSpeech(input.voice, workspace, (file) => {
    const form = new FormData()
    form.set('file', file)
    return postForm(row.door.url, VOICE_UPLOAD_PATH, form, signal)
  })
  const req = buildSpeakRequest(row, { text: input.text, voice })
  const audio = await postJson(row.door.url, req.path, req.body, signal)
  if (!(audio instanceof ArrayBuffer)) {
    throw new ToolRouteError('engined returned no audio')
  }
  return audio
}

/** The workspace file a tool will read or write, as `prepareInvocation` shows it. */
export interface ConfirmationTarget {
  /** Workspace-relative path. */
  path: string
  /** True when the tool writes to `path` and a file is already there. */
  overwrites?: boolean
}

/**
 * The confirmation message `prepareInvocation` shows: the route, the workspace path the
 * tool touches, whether it overwrites an existing file, and, when its `egress` is not
 * local, that content leaves the machine.
 */
export function confirmationMessage(
  row: EnginedModelRow,
  action: string,
  target?: ConfirmationTarget,
): string {
  const egressNote =
    row.egress !== undefined && row.egress !== 'none'
      ? ` This content leaves this machine (egress: ${row.egress}).`
      : ''
  const pathNote = target === undefined ? '' : ` Path: ${target.path}.`
  const overwriteNote = target?.overwrites === true ? ' This overwrites an existing file.' : ''
  return `${action} via ${row.id}.${pathNote}${overwriteNote}${egressNote}`
}

/** Tool-call confirmation follows the chat stream within seconds; an older lastChatCall is a previous caller. */
const SEARCH_CALLING_CHAT_MS = 5000

/** `undefined` when `chat` is older than the tool-invocation window, so the search warning shows. */
export function callingChatForSearch(
  chat: { route?: string; egress?: string; at?: number } | undefined,
  now = Date.now(),
): { route?: string; egress?: string; at?: number } | undefined {
  if (chat?.at !== undefined && now - chat.at > SEARCH_CALLING_CHAT_MS) {
    return undefined
  }
  return chat
}

/** Confirmation `engined_search` shows: the query, the calling chat route, and a warning when that route is not local. */
export function searchConfirmationMessage(
  query: string,
  chat: { route?: string; egress?: string; at?: number } | undefined,
): string {
  const active = callingChatForSearch(chat)
  const route = active?.route ?? 'the calling chat model'
  const local = isLocalEgress(active?.egress)
  const egressNote = local
    ? ''
    : ' Snippets will be returned to that model and may leave this machine.'
  return `Search the workspace for "${query}". Results go to ${route}.${egressNote}`
}
