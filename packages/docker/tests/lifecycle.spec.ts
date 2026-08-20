import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DockerRuntime, { hasLocalSocket } from '@vladchatware/dsh-docker'

const available = hasLocalSocket()

describe.skipIf(!available)('dsh-docker owner lifecycle', () => {
  const contexts: Context[] = []

  async function boot(config: Record<string, unknown> = {}): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(DockerRuntime, {
      image: 'debian:bookworm-slim',
      cwd: '/workspace',
      timeoutMs: 120_000,
      namePrefix: 'test-life',
      ...config,
    })
    contexts.push(ctx)
    return ctx
  }

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()
      if (ctx === undefined) continue
      try {
        await ctx.fiber.dispose()
      } catch {
        // Disposal is best-effort in teardown; the container timeout bounds leaks.
      }
    }
  })

  it('boots, prepares cwd and runtime root, and removes the container on disposal', async () => {
    const ctx = await boot()
    const container = await ctx.docker.getContainer()
    expect(ctx.docker.containerName.startsWith('dsh-dkr-test-life-')).toBe(true)
    const cwd = await ctx.docker.guest('test -d /workspace && echo dir || echo missing')
    expect(cwd).toBe('dir')
    const runtimeRoot = await ctx.docker.guest('test -d /workspace/.dsh-dkr && echo dir || echo missing')
    expect(runtimeRoot).toBe('dir')
    const mode = await ctx.docker.guest('stat -c %a /workspace/.dsh-dkr')
    expect(mode).toBe('700')
    const inspect = await container.inspect()
    expect(inspect.State.Running).toBe(true)
    await ctx.fiber.dispose()
    const after = await container.inspect().catch(() => null)
    expect(after).toBeNull()
  }, 120_000)

  it('mounts a named volume at cwd that persists after disposal', async () => {
    const volume = `dsh-dkr-vol-${randomUUID().slice(0, 8)}`
    const ctx = await boot({ volume })
    await ctx.docker.guest('printf persisted > /workspace/persist.txt')
    await ctx.fiber.dispose()
    const second = await boot({ volume, namePrefix: 'test-persist' })
    const read = await second.docker.guest('cat /workspace/persist.txt').catch(() => 'missing')
    expect(read).toBe('persisted')
  }, 120_000)

  it('re-arms after an idle timeout and lazily creates a fresh container instead of disposing', async () => {
    const ctx = await boot({ timeoutMs: 1_000, lazy: true })
    const first = await ctx.docker.getContainer()
    expect(await ctx.docker.guest('echo first')).toBe('first')
    // The idle timer kills and removes the first container, then re-arms.
    await new Promise((resolve) => setTimeout(resolve, 1_600))
    const gone = await first.inspect().catch(() => null)
    expect(gone).toBeNull()
    // The service is alive: the next use opens a fresh container, not an error.
    const second = await ctx.docker.getContainer()
    expect(second.id).not.toBe(first.id)
    expect(await ctx.docker.guest('echo second')).toBe('second')
  }, 30_000)
})
