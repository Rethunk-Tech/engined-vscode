/**
 * The workspace-scanning and on-disk-index half of `engined_search`: finds
 * candidate files, keeps a chunk+vector index in `context.storageUri`, and
 * answers a query by cosine top-k with an optional rerank pass. The only
 * `vscode`-importing file for this unit -- `search.ts` holds the pure
 * chunking/scoring/planning logic this file calls into.
 */

import { Buffer } from 'node:buffer'
import * as vscode from 'vscode'
import { getDefaultModel, getSearchAllowRemote, getSearchMaxChunks } from './config.ts'
import { resolveDefaultModel } from './defaultModels.ts'
import type { EnginedModelRow } from './door.ts'
import { postEmbeddings, postRerank } from './doorClient.ts'
import type { TextChunk } from './search.ts'
import { chunkFile, mergeRerank, planIndexUpdate, searchableRows, topK } from './search.ts'

/** Above this, a file is skipped rather than embedded -- the brief's own cap. */
const MAX_FILE_BYTES = 256 * 1024
/** How many cosine-nearest chunks get a rerank pass, before trimming to the caller's `maxResults`. */
const RERANK_CANDIDATES = 50
const SAVE_DEBOUNCE_MS = 2000

interface IndexEntry extends TextChunk {
  vector: number[]
}

interface StoredIndex {
  files: Record<string, number>
  entries: IndexEntry[]
}

export interface SearchHit {
  path: string
  /** 1-indexed, inclusive -- what an editor jump-to-line expects. */
  startLine: number
  endLine: number
  text: string
}

function emptyIndex(): StoredIndex {
  return { files: {}, entries: [] }
}

/** The first 512 bytes containing a NUL byte is treated as binary, the same heuristic `git` uses. */
function looksBinary(bytes: Uint8Array): boolean {
  for (const byte of bytes.subarray(0, 512)) {
    if (byte === 0) {
      return true
    }
  }
  return false
}

export class SearchIndex {
  #storageUri: vscode.Uri
  #rowsProvider: () => readonly EnginedModelRow[]
  #log: (line: string) => void
  #index: StoredIndex = emptyIndex()
  #loaded = false
  #saveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    storageUri: vscode.Uri,
    rowsProvider: () => readonly EnginedModelRow[],
    log: (line: string) => void,
  ) {
    this.#storageUri = storageUri
    this.#rowsProvider = rowsProvider
    this.#log = log
  }

  get #indexUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.#storageUri, 'search-index.json')
  }

  async #load(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.#indexUri)
      this.#index = JSON.parse(Buffer.from(bytes).toString('utf8')) as StoredIndex
    } catch {
      this.#index = emptyIndex()
    }
    this.#loaded = true
  }

  #scheduleSave(): void {
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer)
    }
    this.#saveTimer = setTimeout(() => void this.#save(), SAVE_DEBOUNCE_MS)
  }

  async #save(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.#storageUri)
      await vscode.workspace.fs.writeFile(this.#indexUri, Buffer.from(JSON.stringify(this.#index)))
    } catch (error) {
      this.#log(`search: failed to save index: ${describe(error)}`)
    }
  }

  #embeddingRow(): EnginedModelRow | undefined {
    return resolveDefaultModel(
      searchableRows(this.#rowsProvider(), getSearchAllowRemote()),
      'embedding',
      getDefaultModel('embedding'),
    ).row
  }

  /** The first row that reranks and, unless `engined.search.allowRemote` is set, keeps content local. */
  #rerankRow(): EnginedModelRow | undefined {
    return searchableRows(this.#rowsProvider(), getSearchAllowRemote()).find(
      (row) => row.state !== 'unavailable' && row.serves.includes('/openai/v1/rerank'),
    )
  }

  async #excludeGlob(): Promise<string> {
    const files = vscode.workspace
      .getConfiguration('files')
      .get<Record<string, boolean>>('exclude', {})
    const search = vscode.workspace
      .getConfiguration('search')
      .get<Record<string, boolean>>('exclude', {})
    const globs = Object.entries({ ...files, ...search })
      .filter(([, enabled]) => enabled)
      .map(([glob]) => glob)
    return globs.length > 0 ? `{${globs.join(',')}}` : '**/.git/**'
  }

  async #embedTexts(row: EnginedModelRow, texts: string[]): Promise<(number[] | undefined)[]> {
    return postEmbeddings(row.door.url, row.routeId, texts)
  }

  /** Loads the on-disk index (once) and catches it up to the workspace's current files. Cheap to call before every search: a no-op refresh touches no files. */
  async ensureBuilt(): Promise<void> {
    if (!this.#loaded) {
      await this.#load()
    }
    await this.#refresh(true)
  }

  async #refresh(showProgress: boolean): Promise<void> {
    const row = this.#embeddingRow()
    if (row === undefined) {
      this.#log('search: no installed engined route serves /openai/v1/embeddings')
      return
    }
    const work = (progress?: vscode.Progress<{ message?: string }>) =>
      this.#applyRefresh(row, progress)
    if (showProgress) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'engined: indexing workspace for search',
          cancellable: false,
        },
        (progress) => work(progress),
      )
    } else {
      await work()
    }
  }

  async #applyRefresh(
    row: EnginedModelRow,
    progress?: vscode.Progress<{ message?: string }>,
  ): Promise<void> {
    const exclude = await this.#excludeGlob()
    const uris = await vscode.workspace.findFiles('**/*', exclude)
    const current: { path: string; mtime: number }[] = []
    const infoByPath = new Map<string, { uri: vscode.Uri; mtime: number }>()
    for (const uri of uris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri)
        if (stat.type !== vscode.FileType.File || stat.size > MAX_FILE_BYTES) {
          continue
        }
        const path = vscode.workspace.asRelativePath(uri, false)
        current.push({ path, mtime: stat.mtime })
        infoByPath.set(path, { uri, mtime: stat.mtime })
      } catch {
        // Gone between the listing and the stat.
      }
    }
    const indexed = Object.entries(this.#index.files).map(([path, mtime]) => ({ path, mtime }))
    const plan = planIndexUpdate(current, indexed)
    for (const path of plan.toRemove) {
      this.#removeFile(path)
    }
    const maxChunks = getSearchMaxChunks()
    let hitCap = false
    for (const path of plan.toEmbed) {
      if (this.#index.entries.length >= maxChunks) {
        hitCap = true
        break
      }
      const info = infoByPath.get(path)
      if (info === undefined) {
        continue
      }
      progress?.report({ message: path })
      const added = await this.#embedFile(row, path, info.uri, info.mtime, maxChunks)
      if (!added) {
        hitCap = true
      }
    }
    if (hitCap) {
      this.#log(
        `search: index capped at ${maxChunks} chunks (engined.search.maxChunks) -- some files were not indexed`,
      )
    }
    this.#scheduleSave()
  }

  #removeFile(path: string): void {
    this.#index.entries = this.#index.entries.filter((e) => e.path !== path)
    delete this.#index.files[path]
  }

  /** Embeds every chunk of `path` that fits under `maxChunks`. Returns `false` when the cap cut the file short. */
  async #embedFile(
    row: EnginedModelRow,
    path: string,
    uri: vscode.Uri,
    mtime: number,
    maxChunks: number,
  ): Promise<boolean> {
    let content: string
    try {
      const bytes = await vscode.workspace.fs.readFile(uri)
      if (looksBinary(bytes)) {
        return true
      }
      content = Buffer.from(bytes).toString('utf8')
    } catch (error) {
      this.#log(`search: skipping ${path}: ${describe(error)}`)
      return true
    }
    const chunks = chunkFile(path, content)
    const room = Math.max(0, maxChunks - this.#index.entries.length)
    const toEmbed = chunks.slice(0, room)
    if (toEmbed.length === 0) {
      return false
    }
    const vectors = await this.#embedTexts(
      row,
      toEmbed.map((c) => c.text),
    )
    this.#removeFile(path)
    for (let i = 0; i < toEmbed.length; i += 1) {
      const chunk = toEmbed[i]
      const vector = vectors[i]
      if (chunk !== undefined && vector !== undefined) {
        this.#index.entries.push({ ...chunk, vector })
      }
    }
    this.#index.files[path] = mtime
    return toEmbed.length === chunks.length
  }

  /** Incremental hook for a save/create/delete file-system event; safe to call before the index has ever been built (it is then a no-op). */
  async onFileChanged(uri: vscode.Uri, kind: 'change' | 'create' | 'delete'): Promise<void> {
    if (!this.#loaded) {
      return
    }
    if (kind === 'delete') {
      this.#removeFile(vscode.workspace.asRelativePath(uri, false))
      this.#scheduleSave()
      return
    }
    await this.#refresh(false)
  }

  async search(query: string, maxResults: number): Promise<SearchHit[]> {
    await this.ensureBuilt()
    const row = this.#embeddingRow()
    if (row === undefined || this.#index.entries.length === 0) {
      return []
    }
    const [queryVector] = await this.#embedTexts(row, [query])
    if (queryVector === undefined) {
      return []
    }
    const ranked = topK(
      queryVector,
      this.#index.entries.map((e) => ({ vector: e.vector, item: e })),
      RERANK_CANDIDATES,
    )
    let ordered = ranked.map((r) => r.item)
    const rerankRow = this.#rerankRow()
    if (rerankRow !== undefined && ordered.length > 0) {
      try {
        const results = await postRerank(
          rerankRow.door.url,
          rerankRow.routeId,
          query,
          ordered.map((e) => e.text),
        )
        ordered = mergeRerank(ordered, results, ordered.length)
      } catch (error) {
        this.#log(`search: rerank failed, using cosine order instead: ${describe(error)}`)
      }
    }
    return ordered.slice(0, maxResults).map((e) => ({
      path: e.path,
      startLine: e.startLine + 1,
      endLine: e.endLine + 1,
      text: e.text,
    }))
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
