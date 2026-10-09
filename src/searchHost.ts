/**
 * The few `vscode` APIs `SearchIndex` uses, behind an interface so its refresh,
 * debounce and single-flight logic can run under `bun test`. `vscodeSearchHost`
 * is the production implementation; it is the only file here that touches the
 * real module for this unit.
 */

import * as vscode from 'vscode'
import { getDefaultModel, getSearchAllowRemote, getSearchMaxChunks } from './config.ts'
import type { ModelRole } from './defaultModels.ts'
import { postEmbeddings, postRerank } from './doorClient.ts'

export interface HostUri {
  readonly fsPath: string
}

export interface HostStat {
  isFile: boolean
  size: number
  mtime: number
}

export interface SearchHost {
  joinPath(base: HostUri, name: string): HostUri
  readFile(uri: HostUri): Promise<Uint8Array>
  writeFile(uri: HostUri, data: Uint8Array): Promise<void>
  createDirectory(uri: HostUri): Promise<void>
  stat(uri: HostUri): Promise<HostStat>
  /** Every workspace file not matched by `exclude`. */
  findFiles(exclude: string): Promise<HostUri[]>
  /** Whether `uri` is a workspace file that `exclude` lets through; false outside any workspace folder. */
  isWorkspaceFile(uri: HostUri, exclude: string): Promise<boolean>
  asRelativePath(uri: HostUri): string
  /** The `files.exclude` then `search.exclude` settings. */
  excludeSettings(): Record<string, boolean>[]
  /** Runs `task` under a progress notification; `report` names the file in flight. */
  withProgress(
    title: string,
    task: (report: (message: string) => void) => Promise<void>,
  ): Promise<void>
  /** The door's embeddings route; one vector (or undefined) per text. */
  embed(
    baseUrl: string,
    model: string,
    texts: string[],
    signal?: AbortSignal,
  ): ReturnType<typeof postEmbeddings>
  /** The door's rerank route. */
  rerank(
    baseUrl: string,
    request: Parameters<typeof postRerank>[1],
    signal?: AbortSignal,
  ): ReturnType<typeof postRerank>
  defaultModel(role: ModelRole): string
  allowRemote(): boolean
  maxChunks(): number
}

const asUri = (uri: HostUri): vscode.Uri => uri as vscode.Uri

export const vscodeSearchHost: SearchHost = {
  joinPath: (base, name) => vscode.Uri.joinPath(asUri(base), name),
  readFile: (uri) => Promise.resolve(vscode.workspace.fs.readFile(asUri(uri))),
  writeFile: (uri, data) => Promise.resolve(vscode.workspace.fs.writeFile(asUri(uri), data)),
  createDirectory: (uri) => Promise.resolve(vscode.workspace.fs.createDirectory(asUri(uri))),
  async stat(uri) {
    const stat = await vscode.workspace.fs.stat(asUri(uri))
    return { isFile: stat.type === vscode.FileType.File, size: stat.size, mtime: stat.mtime }
  },
  async findFiles(exclude) {
    return await vscode.workspace.findFiles('**/*', exclude)
  },
  async isWorkspaceFile(uri, exclude) {
    const folder = vscode.workspace.getWorkspaceFolder(asUri(uri))
    if (folder === undefined) {
      return false
    }
    const relative = vscode.workspace
      .asRelativePath(asUri(uri), false)
      .replace(/[\\[\]{}()*?!]/g, '[$&]')
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, relative),
      exclude,
      1,
    )
    return found.length > 0
  },
  asRelativePath: (uri) => vscode.workspace.asRelativePath(asUri(uri), false),
  excludeSettings: () => [
    vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude', {}),
    vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude', {}),
  ],
  async withProgress(title, task) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      (progress) => task((message) => progress.report({ message })),
    )
  },
  embed: postEmbeddings,
  rerank: postRerank,
  defaultModel: getDefaultModel,
  allowRemote: getSearchAllowRemote,
  maxChunks: getSearchMaxChunks,
}
