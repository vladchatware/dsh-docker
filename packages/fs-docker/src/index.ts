/**
 * Docker provider for the filesystem capability seam. Paths, contents, and
 * atomic staging files remain inside the shared container.
 * @module @vladchatware/dsh-fs-docker
 */

import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { pack as createTar, extract as createExtract } from 'tar-stream'
import { DockerContainer, DockerGoneError, quoteShellArg } from '@vladchatware/dsh-docker'

const BINARY_SAMPLE_BYTES = 8192
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

function decodeText(bytes: Uint8Array, displayPath: string): string {
  if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

function decodeCanonicalPath(encoded: string): string {
  if (encoded.length === 0 || !BASE64.test(encoded)) {
    throw new Error('fs-docker: canonical path transport returned invalid base64')
  }
  const framed = Buffer.from(encoded, 'base64')
  if (framed.toString('base64') !== encoded
    || framed.length < 2
    || framed.at(-1) !== 0
    || framed.subarray(0, -1).includes(0)) {
    throw new Error('fs-docker: canonical path transport returned invalid NUL framing')
  }
  let path: string
  try {
    path = new TextDecoder('utf-8', { fatal: true }).decode(framed.subarray(0, -1))
  } catch (error: unknown) {
    throw new Error('fs-docker: canonical path is not valid UTF-8', { cause: error })
  }
  if (!posix.isAbsolute(path)) throw new Error('fs-docker: canonical path is not absolute')
  return path
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof DockerGoneError)) return false
  return /no such (file|container|object)|not found|enoent|does not exist|404/i.test(error.message)
}

function isPermission(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /permission denied|operation not permitted/i.test(error.message)
}

function mapError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')) {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  if (isNotFound(error)) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (isPermission(error)) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${String(error)}`, 'FS_IO_ERROR', { cause: error })
}

function entryType(kind: 'file' | 'directory' | 'other'): FsInfo['type'] {
  return kind
}

/** Metadata facts from one `stat` invocation inside the container. */
interface GuestStat {
  kind: 'file' | 'directory' | 'other'
  size?: number
  mode: number
  modifiedMs: number
}

function entryVersion(path: string, entry: GuestStat): ReturnType<typeof FsVersion> {
  const facts = JSON.stringify([path, entry.kind, entry.size, entry.mode, entry.modifiedMs])
  return FsVersion(`dkr:${createHash('sha256').update(facts).digest('hex')}`)
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let matches = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

/**
 * Docker filesystem backend sharing the container owned by `ctx.docker`.
 * File transfers use the Docker archive API (tar in/out of the container).
 */
export class DockerFileSystem extends FileSystem {
  static inject = ['docker']

  private readonly locks = new Map<string, Promise<unknown>>()

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.docker.cwd, path)
    try {
      const targetKey = await this.canonicalPath(displayPath, opts?.signal)
      assertNotAborted(opts?.signal, 'resolve')
      return { targetKey: FsTargetKey(targetKey), displayPath }
    } catch (error: unknown) {
      throw mapError(error, 'resolve', displayPath, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) throw new Error(`fs-docker: expected an absolute process path: ${JSON.stringify(path)}`)
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const entry = await this.probe(String(target.targetKey), target.displayPath, signal)
    if (entry === undefined) return undefined
    return {
      version: entryVersion(String(target.targetKey), entry),
      type: entryType(entry.kind),
      ...(entry.kind === 'file' ? { size: entry.size } : {}),
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.docker.cwd, path)
    try {
      const line = await this.ctx.docker.guest(
        `LC_ALL=C stat -c '%F|%s|%Y' -- ${quoteShellArg(displayPath)} 2>/dev/null || echo MISSING`,
      )
      assertNotAborted(signal, 'lstat')
      if (line === 'MISSING') return undefined
      const [kind, sizeText, mtimeText] = line.split('|')
      const type = kind === 'symbolic link'
        ? 'symlink' as const
        : kind === 'regular file' || kind === 'regular empty file'
          ? 'file' as const
          : kind === 'directory'
            ? 'directory' as const
            : 'other' as const
      const facts = JSON.stringify([displayPath, kind, sizeText, mtimeText])
      return {
        version: FsVersion(`dkr:${createHash('sha256').update(facts).digest('hex')}`),
        type,
        ...(type === 'file' ? { size: Number(sizeText) } : {}),
      }
    } catch (error: unknown) {
      throw mapError(error, 'lstat', displayPath, signal)
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    await this.requireRegular(target, signal)
    const bytes = await this.readArchive(String(target.targetKey), signal)
    return decodeText(bytes, target.displayPath)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const info = await this.requireRegular(target, signal)
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    const bytes = await this.readArchive(String(target.targetKey), signal)
    if (bytes.length > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    return bytes
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    await this.requireRegular(target, signal)
    const displayPath = target.displayPath
    const targetKey = String(target.targetKey)
    const owner = this.ctx.docker
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let sampledBytes = 0
        let completed = false
        try {
          const container = await owner.getContainer()
          const chunks = await readArchiveInto(container, targetKey, signal)
          for (const chunk of chunks) {
            assertNotAborted(signal, 'read')
            if (sampledBytes < BINARY_SAMPLE_BYTES) {
              const sample = chunk.subarray(0, BINARY_SAMPLE_BYTES - sampledBytes)
              if (sample.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
              sampledBytes += sample.length
            }
            let text: string
            try {
              text = decoder.decode(chunk, { stream: true })
            } catch (error: unknown) {
              throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
            }
            if (text.length > 0) yield text
          }
          try {
            decoder.decode()
          } catch (error: unknown) {
            throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
          }
          completed = true
        } catch (error: unknown) {
          throw mapError(error, 'read', displayPath, signal)
        } finally {
          // No remote stream to cancel: archive reads are fully buffered.
          void completed
        }
      },
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    try {
      const listing = await this.ctx.docker.guest(
        `LC_ALL=C ls -A -- ${quoteShellArg(String(target.targetKey))} 2>/dev/null || true`,
      )
      assertNotAborted(signal, 'list')
      const entries: FsDirEntry[] = []
      for (const name of listing.split('\n')) {
        if (name.length === 0) continue
        const childPath = posix.join(String(target.targetKey), name)
        const displayPath = posix.join(target.displayPath, name)
        const guest = await this.probe(childPath, displayPath, signal)
        const resolvedKind = guest === undefined ? 'other' : guest.kind
        entries.push({
          name,
          type: entryType(resolvedKind),
          target: { targetKey: FsTargetKey(childPath), displayPath },
          ...(guest !== undefined ? { version: entryVersion(childPath, guest) } : {}),
          ...(guest?.kind === 'file' ? { size: guest.size } : {}),
        })
      }
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    } catch (error: unknown) {
      throw mapError(error, 'list', target.displayPath, signal)
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing !== undefined && existing.kind !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const before = existing === undefined ? null : await this.readForDiff(target, signal)
      const version = await this.writeAtomic(target, content, existing, expected?.kind === 'createIfAbsent', signal)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (existing.kind !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && entryVersion(String(target.targetKey), existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(target, signal)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(raw))
      const version = await this.writeAtomic(target, storage, existing, false, signal)
      return { version, before, after }
    })
  }

  private withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }

  private async canonicalPath(
    path: string,
    signal?: AbortSignal,
  ): Promise<string> {
    assertNotAborted(signal, 'resolve')
    try {
      const result = await this.ctx.docker.guest(`realpath -mz -- ${quoteShellArg(path)} | base64 -w0`)
      return decodeCanonicalPath(result)
    } catch (error: unknown) {
      throw mapError(error, 'resolve', path, signal)
    }
  }

  private async probe(path: string, displayPath: string, signal?: AbortSignal): Promise<GuestStat | undefined> {
    assertNotAborted(signal, 'stat')
    try {
      const line = await this.ctx.docker.guest(
        `LC_ALL=C stat -c '%F|%s|%a|%Y' -- ${quoteShellArg(path)} 2>/dev/null || echo MISSING`,
      )
      assertNotAborted(signal, 'stat')
      if (line === 'MISSING') return undefined
      const parts = line.split('|')
      const kindText = parts[0] as string
      const sizeText = parts[1] as string
      const modeText = parts[2] as string
      const mtimeText = parts[3] as string
      const kind = kindText === 'regular file' || kindText === 'regular empty file'
        ? 'file' as const
        : kindText === 'directory'
          ? 'directory' as const
          : 'other' as const
      return {
        kind,
        ...(kind === 'file' ? { size: Number(sizeText) } : {}),
        mode: Number.parseInt(modeText, 8),
        modifiedMs: Number(mtimeText) * 1000,
      }
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw mapError(error, 'stat', displayPath, signal)
    }
  }

  private async readArchive(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const container = await this.ctx.docker.getContainer()
    const chunks = await readArchiveInto(container, path, signal)
    const whole = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
    return new Uint8Array(whole)
  }

  private async requireRegular(target: FsTarget, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    return info
  }

  private checkWriteIntent(existing: GuestStat | undefined, expected: FsWriteIntent | undefined, target: FsTarget): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || entryVersion(String(target.targetKey), existing) !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  private async readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const bytes = await this.readArchive(String(target.targetKey), signal)
      return normalizeLineEndings(decodeText(bytes, target.displayPath))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  private async readForEdit(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const bytes = await this.readArchive(String(target.targetKey), signal)
    return decodeText(bytes, target.displayPath)
  }

  private async writeAtomic(
    target: FsTarget,
    content: string,
    existing: GuestStat | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof FsVersion>> {
    assertNotAborted(signal, 'write')
    const container = await this.ctx.docker.getContainer()
    const targetPath = String(target.targetKey)
    const stagingDirectory = posix.join(posix.dirname(targetPath), `.dsh-${randomUUID()}.tmp`)
    const temporary = posix.join(stagingDirectory, 'content')
    let stagingDirectoryCreated = false
    try {
      await this.ctx.docker.guest(`mkdir -p ${quoteShellArg(stagingDirectory)}`)
      stagingDirectoryCreated = true
      await this.ctx.docker.guest(`chmod 700 ${quoteShellArg(stagingDirectory)}`)
      assertNotAborted(signal, 'write')
      await this.putFile(container, temporary, content)
      assertNotAborted(signal, 'write')
      const mode = existing === undefined ? 0o600 : existing.mode & 0o777
      await this.ctx.docker.guest(`chmod ${mode.toString(8)} ${quoteShellArg(temporary)}`)
      assertNotAborted(signal, 'write')
      if (createIfAbsent) {
        const publication = await this.ctx.docker.guest(
          `if ln -T -- ${quoteShellArg(temporary)} ${quoteShellArg(targetPath)}; then printf created; elif test -e ${quoteShellArg(targetPath)} || test -L ${quoteShellArg(targetPath)}; then printf exists; else exit 1; fi`,
        )
        if (publication === 'exists') {
          throw new FsError(
            `cannot overwrite existing "${target.displayPath}" without reading it first`,
            'FS_NOT_OBSERVED',
          )
        }
        if (publication !== 'created') {
          throw new Error('guarded create returned an invalid publication result')
        }
      } else {
        await this.ctx.docker.guest(`mv -- ${quoteShellArg(temporary)} ${quoteShellArg(targetPath)}`)
      }
      await this.ctx.docker.guest(`rmdir ${quoteShellArg(stagingDirectory)} 2>/dev/null; true`)
      const committed = await this.probe(targetPath, target.displayPath, signal)
      if (committed === undefined) {
        throw new Error(`write committed but target vanished: ${targetPath}`)
      }
      return entryVersion(targetPath, committed)
    } catch (error: unknown) {
      if (stagingDirectoryCreated) {
        await this.ctx.docker.guest(`rm -rf ${quoteShellArg(stagingDirectory)} 2>/dev/null; true`).catch(() => {})
      }
      throw mapError(error, 'write', target.displayPath, signal)
    }
  }

  private async putFile(container: DockerContainer, path: string, content: string): Promise<void> {
    const pack = createTar()
    pack.entry({ name: 'content', mode: 0o600 }, content)
    pack.finalize()
    await container.putArchive(pack, { path: posix.dirname(path) })
  }
}

export default DockerFileSystem

/** Read a whole file from the container via the archive API into byte chunks. */
async function readArchiveInto(
  container: DockerContainer,
  path: string,
  signal?: AbortSignal,
): Promise<Buffer[]> {
  assertNotAborted(signal, 'read')
  const archive = await container.getArchive({ path })
  let fileChunks: Buffer[] | undefined
  const extract = createExtract()
  extract.on('entry', (_header, stream, next) => {
    const collected: Buffer[] = []
    stream.on('data', (chunk: Buffer) => collected.push(chunk))
    stream.on('end', () => {
      if (fileChunks === undefined) fileChunks = collected
      next()
    })
  })
  extract.on('error', () => {})
  for await (const chunk of archive as unknown as AsyncIterable<Uint8Array>) {
    assertNotAborted(signal, 'read')
    extract.write(Buffer.from(chunk))
  }
  extract.end()
  await new Promise<void>(resolve => extract.on('finish', resolve))
  if (fileChunks === undefined) throw new DockerGoneError(`no such file: ${path}`)
  return fileChunks
}
