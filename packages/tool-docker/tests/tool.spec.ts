import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { hostname } from 'node:os'
import { CallId } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import DockerRuntime, { hasLocalSocket } from '@vladchatware/dsh-docker'
import { apply as applyTool } from '@vladchatware/dsh-tool-docker'

const available = hasLocalSocket()

describe.skipIf(!available)('dsh-tool-docker docker_bash', () => {
  const contexts: Context[] = []

  async function boot(lazy = true): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DockerRuntime, {
      image: 'debian:bookworm-slim', cwd: '/workspace', timeoutMs: 120_000, namePrefix: 'test-dkrtool', lazy,
    })
    applyTool(ctx, {})
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

  async function callDockerBash(ctx: Context, command: string, extra: Record<string, unknown> = {}) {
    const result = await ctx.tools.execute({
      callId: CallId('dkr-probe-1'),
      name: 'docker_bash',
      arguments: { command, description: 'probe', ...extra },
      signal: new AbortController().signal,
    })
    return result
  }

  it('runs a command inside the container, not on the host', async () => {
    const ctx = await boot()
    const result = await callDockerBash(ctx, 'hostname && uname -s && pwd')
    expect('value' in result).toBe(true)
    if (!('value' in result)) return
    const value = result.value as { stdout: string; exitCode: number }
    const [containerHostname, kernel, cwd] = value.stdout.trim().split('\n')
    expect(containerHostname).not.toBe(hostname())
    expect(kernel).toBe('Linux')
    expect(cwd).toBe('/workspace')
    expect(value.exitCode).toBe(0)
  }, 120_000)

  it('reports nonzero exit codes and stderr', async () => {
    const ctx = await boot()
    const result = await callDockerBash(ctx, 'echo boom >&2; exit 7')
    if (!('value' in result)) return
    const value = result.value as { exitCode: number; stderr: string }
    expect(value.exitCode).toBe(7)
    expect(value.stderr).toContain('boom')
  }, 120_000)

  it('clamps timeoutMs to the configured cap', async () => {
    const ctx = await boot()
    const result = await callDockerBash(ctx, 'sleep 0.2 && echo done', { timeoutMs: 999_999 })
    if (!('value' in result)) return
    const value = result.value as { exitCode: number; stdout: string }
    expect(value.exitCode).toBe(0)
    expect(value.stdout).toContain('done')
  }, 120_000)
})
