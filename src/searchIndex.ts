/**
 * The workspace-scanning and on-disk-index half of `engined_search`: finds
 * candidate files, keeps a chunk+vector index in `context.storageUri`, and
 * answers a query by cosine top-k with an optional rerank pass. The only
 * `vscode`-importing file for this unit -- `search.ts` holds the pure
 * chunking/scoring/planning logic this file calls into.
 */

import { Buffer } from 'node:buffer'
import { runInBackground } from './background.ts'
import { BYTES_PER_KIB } from './constants.ts'
import { resolveDefaultModel } from './defaultModels.ts'
import type { EnginedModelRow } from './door.ts'
import { postEmbeddings, postRerank } from './doorClient.ts'
import type { TextChunk } from './search.ts'
import { chunkFile, mergeRerank, planIndexUpdate, searchableRows, topK } from './search.ts'
import type { HostUri, SearchHost } from './searchHost.ts'

const MAX_FILE_KIB = 256
const BINARY_SNIFF_BYTES = 512

/** Above this, a file is skipped rather than embedded -- the brief's own cap. */
const MAX_FILE_BYTES = MAX_FILE_KIB * BYTES_PER_KIB
/** How many cosine-nearest chunks get a rerank pass, before trimming to the caller's `maxResults`. */
const RERANK_CANDIDATES = 50
const SAVE_DEBOUNCE_MS = 2000
const REFRESH_DEBOUNCE_MS = 1000

interface IndexEntry extends TextChunk {
  vector: number[]
}

interface StoredIndex {
  /** The embedding route (`EnginedModelRow.id`) every vector here came from; a different route's query vectors are not comparable. */
  route?: string
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
  for (const byte of bytes.subarray(0, BINARY_SNIFF_BYTES)) {
    if (byte === 0) {
      return true
    }
  }
  return false
}

export class SearchIndex {
  readonly #storageUri: HostUri
  readonly #host: SearchHost
  readonly #rowsProvider: () => readonly EnginedModelRow[]
  readonly #log: (line: string) => void
  #index: StoredIndex = emptyIndex()
  #loaded = false
  #saveTimer: ReturnType<typeof setTimeout> | undefined
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #refreshing = false
  #refreshAgain = false

  constructor(
    storageUri: HostUri,
    rowsProvider: () => readonly EnginedModelRow[],
    log: (line: string) => void,
    host: SearchHost,
  ) {
    this.#host = host
    this.#storageUri = storageUri
    this.#rowsProvider = rowsProvider
    this.#log = log
  }

  get #indexUri(): HostUri {
    return this.#host.joinPath(this.#storageUri, 'search-index.json')
  }

  async #load(): Promise<void> {
    try {
      const bytes = await this.#host.readFile(this.#indexUri)
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
    this.#saveTimer = setTimeout(() => this.#background(this.#save()), SAVE_DEBOUNCE_MS)
  }

  #background(work: Promise<void>): void {
    runInBackground(work, (error) =>
      this.#log(`search: background task failed: ${describe(error)}`),
    )
  }

  async #save(): Promise<void> {
    try {
      await this.#host.createDirectory(this.#storageUri)
      await this.#host.writeFile(this.#indexUri, Buffer.from(JSON.stringify(this.#index)))
    } catch (error) {
      this.#log(`search: failed to save index: ${describe(error)}`)
    }
  }

  #embeddingRow(): EnginedModelRow | undefined {
    return resolveDefaultModel(
      searchableRows(this.#rowsProvider(), this.#host.allowRemote()),
      'embedding',
      this.#host.defaultModel('embedding'),
    ).row
  }

  /** The first row that reranks and, unless `engined.search.allowRemote` is set, keeps content local. */
  #rerankRow(): EnginedModelRow | undefined {
    return searchableRows(this.#rowsProvider(), this.#host.allowRemote()).find(
      (row) => row.state !== 'unavailable' && row.serves.includes('/openai/v1/rerank'),
    )
  }

  #excludeGlob(): string {
    const globs = Object.entries(Object.assign({}, ...this.#host.excludeSettings()))
      .filter(([, enabled]) => enabled)
      .map(([glob]) => glob)
    return globs.length > 0 ? `{${globs.join(',')}}` : '**/.git/**'
  }

  #embedTexts(
    row: EnginedModelRow,
    texts: string[],
    signal?: AbortSignal,
  ): Promise<(number[] | undefined)[]> {
    return postEmbeddings(row.door.url, row.routeId, texts, signal)
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
    if (this.#index.route !== row.id) {
      this.#index = { ...emptyIndex(), route: row.id }
    }
    const work = (report?: (message: string) => void) => this.#applyRefresh(row, report)
    if (showProgress) {
      await this.#host.withProgress('engined: indexing workspace for search', (report) =>
        work(report),
      )
    } else {
      await work()
    }
  }

  async #applyRefresh(row: EnginedModelRow, report?: (message: string) => void): Promise<void> {
    const exclude = this.#excludeGlob()
    const uris = await this.#host.findFiles(exclude)
    const current: { path: string; mtime: number }[] = []
    const infoByPath = new Map<string, { uri: HostUri; mtime: number }>()
    for (const uri of uris) {
      try {
        const stat = await this.#host.stat(uri)
        if (!stat.isFile || stat.size > MAX_FILE_BYTES) {
          continue
        }
        const path = this.#host.asRelativePath(uri)
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
    const maxChunks = this.#host.maxChunks()
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
      report?.(path)
      const added = await this.#embedFile(
        row,
        { path, uri: info.uri, mtime: info.mtime },
        maxChunks,
      )
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
    file: { path: string; uri: HostUri; mtime: number },
    maxChunks: number,
  ): Promise<boolean> {
    const { path, uri, mtime } = file
    let content: string
    try {
      const bytes = await this.#host.readFile(uri)
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

  /**
   * Incremental hook for a file-system event. Deletes apply at once; creates and
   * changes only arm one debounced refresh, so a burst (build output, a git
   * checkout) costs a single scan, and a path excluded by `files.exclude` /
   * `search.exclude` arms nothing. A no-op before the index has ever been built.
   */
  onFileChanged(uri: HostUri, kind: 'change' | 'create' | 'delete'): void {
    if (!this.#loaded) {
      return
    }
    if (kind === 'delete') {
      this.#removeFile(this.#host.asRelativePath(uri))
      this.#scheduleSave()
      return
    }
    this.#background(this.#armRefresh(uri))
  }

  async #armRefresh(uri: HostUri): Promise<void> {
    try {
      if (!(await this.#isIndexable(uri))) {
        return
      }
      if (this.#refreshTimer !== undefined) {
        clearTimeout(this.#refreshTimer)
      }
      this.#refreshTimer = setTimeout(() => {
        this.#refreshTimer = undefined
        this.#background(this.#refreshSerialized())
      }, REFRESH_DEBOUNCE_MS)
    } catch (error) {
      this.#log(`search: could not check ${uri.fsPath}: ${describe(error)}`)
    }
  }

  /** Whether the workspace's exclude globs let `uri` through. */
  async #isIndexable(uri: HostUri): Promise<boolean> {
    return await this.#host.isWorkspaceFile(uri, this.#excludeGlob())
  }

  /** At most one refresh in flight; events arriving meanwhile fold into one follow-up run. */
  async #refreshSerialized(): Promise<void> {
    if (this.#refreshing) {
      this.#refreshAgain = true
      return
    }
    this.#refreshing = true
    try {
      do {
        this.#refreshAgain = false
        await this.#refresh(false)
      } while (this.#refreshAgain)
    } catch (error) {
      this.#log(`search: background refresh failed: ${describe(error)}`)
    } finally {
      this.#refreshing = false
    }
  }

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchHit[]> {
    await this.ensureBuilt()
    const row = this.#embeddingRow()
    if (row === undefined || this.#index.entries.length === 0) {
      return []
    }
    const [queryVector] = await this.#embedTexts(row, [query], signal)
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
          { model: rerankRow.routeId, query, documents: ordered.map((e) => e.text) },
          signal,
        )
        ordered = mergeRerank(ordered, results, ordered.length)
      } catch (error) {
        if (signal?.aborted) {
          throw error
        }
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
