import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DockerRuntime, { hasLocalSocket } from '@vladchatware/dsh-docker'
import { FsError } from '@deepseek-ai/dsh-fs'
import DockerFileSystem from '@vladchatware/dsh-fs-docker'

const available = hasLocalSocket()

describe.skipIf(!available)('dsh-fs-docker over a live container', () => {
  const contexts: Context[] = []

  async function boot(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(DockerRuntime, {
      image: 'debian:bookworm-slim', cwd: '/workspace', timeoutMs: 120_000, namePrefix: 'test-fs',
    })
    await ctx.plugin(DockerFileSystem)
    contexts.push(ctx)
    return ctx
  }

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()
      if (ctx === undefined) continue
      try { await ctx.fiber.dispose() } catch { /* best-effort teardown */ }
    }
  })

  async function expectFsError(promise: Promise<unknown>, code: string): Promise<void> {
    try {
      await promise
      expect.unreachable(`expected FS_${code} error`)
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(FsError)
      expect((error as FsError).code).toBe(code)
    }
  }

  it('resolves paths, exposes process paths and containment', async () => {
    const ctx = await boot()
    const f = ctx.fs
    const target = await f.resolve('smoke.txt', { cwd: '/workspace' })
    expect(target.displayPath).toBe('/workspace/smoke.txt')
    expect(f.processPath(target)).toBe(String(target.targetKey))
    expect(f.fileUrl(target)).toBe('file:///workspace/smoke.txt')
    const ws = await f.resolve('/workspace')
    expect(f.contains(ws, target)).toBe(true)
    expect(f.contains(target, ws)).toBe(false)
  }, 120_000)

  it('writes atomically with guarded intents', async () => {
    const ctx = await boot()
    const f = ctx.fs
    const target = await f.resolve('/workspace/guard.txt')
    const created = await f.writeText(target, 'hello\nworld\n')
    expect(created.operation).toBe('create')
    expect(created.before).toBeNull()
    expect(created.after).toBe('hello\nworld\n')

    await expectFsError(f.writeText(target, 'x', { kind: 'createIfAbsent' }), 'FS_NOT_OBSERVED')
    const updated = await f.writeText(target, 'hello again\n', { kind: 'replaceIfVersion', version: created.version })
    expect(updated.operation).toBe('update')
    expect(updated.before).toBe('hello\nworld\n')
    expect(updated.after).toBe('hello again\n')
    expect(await f.readText(target)).toBe('hello again\n')
    await expectFsError(
      f.writeText(target, 'stale\n', { kind: 'replaceIfVersion', version: created.version }),
      'FS_STALE_VERSION',
    )
  }, 120_000)

  it('rejects binary and oversized content', async () => {
    const ctx = await boot()
    const f = ctx.fs
    const bin = await f.resolve('/workspace/binary.bin')
    await f.writeText(bin, '\u0000\u0001\u0002')
    await expectFsError(f.readText(bin), 'FS_NOT_TEXT')
    await expectFsError(f.readBytes(bin, undefined, 1), 'FS_TOO_LARGE')
  }, 120_000)

  it('lists directories with stable order and metadata', async () => {
    const ctx = await boot()
    const f = ctx.fs
    const dir = await f.resolve('/workspace')
    await f.writeText(await f.resolve('/workspace/a.txt'), 'a')
    await f.writeText(await f.resolve('/workspace/b.txt'), 'b')
    const entries = await f.listDir(dir)
    const names = entries.map(e => e.name)
    expect(names).toContain('a.txt')
    expect(names).toContain('b.txt')
    expect(names.indexOf('a.txt') < names.indexOf('b.txt')).toBe(true)
  }, 120_000)

  it('edits with literal replacement and version guards', async () => {
    const ctx = await boot()
    const f = ctx.fs
    const target = await f.resolve('/workspace/edit.txt')
    await f.writeText(target, 'one\ntwo\nthree\n')
    const edited = await f.editText(target, { oldString: 'two', newString: '2', replaceAll: false })
    expect(edited.before).toBe('one\ntwo\nthree\n')
    expect(edited.after).toBe('one\n2\nthree\n')
    expect(await f.readText(target)).toBe('one\n2\nthree\n')
  }, 120_000)

  it('lstat reports symlinks', async () => {
    const ctx = await boot()
    const f = ctx.fs
    await ctx.docker.guest('printf x > /workspace/link-target.txt; ln -sf /workspace/link-target.txt /workspace/link.txt')
    const info = await f.lstat('/workspace/link.txt', { cwd: '/' })
    expect(info?.type).toBe('symlink')
  }, 120_000)
})
