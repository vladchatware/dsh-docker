import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import DockerRuntime, { hasLocalSocket } from '@vladchatware/dsh-docker'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import DockerSubprocessRuntime from '@vladchatware/dsh-subprocess-docker'

const available = hasLocalSocket()

describe.skipIf(!available)('dsh-subprocess-docker over a live container', () => {
  const contexts: Context[] = []

  async function boot(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(DockerRuntime, {
      image: 'debian:bookworm-slim', cwd: '/workspace', timeoutMs: 120_000, namePrefix: 'test-sp',
    })
    await ctx.plugin(DockerSubprocessRuntime)
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

  function collectSpec(argv: readonly string[], env?: Record<string, string>, stdin: 'ignore' | 'pipe' = 'ignore'): SubprocessSpawnSpec {
    return {
      argv,
      cwd: '/workspace',
      stdio: {
        stdin,
        stdout: { maxBytes: 8192, spill: { maxBytes: 64 * 1024 } },
        stderr: { maxBytes: 8192 },
      },
      graceMs: 2000,
      env,
    }
  }

  it('collects output and exit facts', async () => {
    const ctx = await boot()
    const handle = ctx.subprocess.spawn(collectSpec(['bash', '-c', 'echo one; echo two >&2; exit 3']))
    await expect(handle.done).resolves.toEqual({ exitCode: 3, signal: null })
    expect(handle.collected.stdout?.readFrom(0).text).toBe('one\n')
    expect(handle.collected.stderr?.readFrom(0).text).toBe('two\n')
  }, 120_000)

  it('exposes pipe mode and writes stdin', async () => {
    const ctx = await boot()
    const piped = ctx.subprocess.spawn({
      argv: ['bash', '-c', 'printf piped-ok'], cwd: '/workspace',
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 8192 } }, graceMs: 2000,
    })
    const chunks: string[] = []
    for await (const chunk of piped.stdout as AsyncIterable<Buffer>) chunks.push(chunk.toString())
    await piped.done
    expect(chunks.join('')).toBe('piped-ok')
    const fed = ctx.subprocess.spawn(collectSpec(['cat'], undefined, 'pipe'))
    fed.stdin?.write('hello-stdin\n')
    fed.stdin?.end()
    await expect(fed.done).resolves.toMatchObject({ exitCode: 0 })
    expect(fed.collected.stdout?.readFrom(0).text).toBe('hello-stdin\n')
  }, 120_000)

  it('terminates the whole tree with TERM then KILL', async () => {
    const ctx = await boot()
    const handle = ctx.subprocess.spawn(collectSpec(['bash', '-c', "trap '' TERM; sleep 60 & wait"]))
    await new Promise(resolve => setTimeout(resolve, 600))
    const startedAt = Date.now()
    handle.terminate()
    const outcome = await handle.done
    expect(outcome.exitCode).toBeNull()
    expect(outcome.signal).toBe('SIGKILL')
    expect(Date.now() - startedAt).toBeLessThan(6000)
    await expect(handle.waitForExit()).resolves.toBe(true)
  }, 120_000)

  it('starts termination from the abort signal', async () => {
    const ctx = await boot()
    const controller = new AbortController()
    const handle = ctx.subprocess.spawn({ ...collectSpec(['bash', '-c', 'sleep 60']), signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 400))
    controller.abort()
    await expect(handle.done).resolves.toMatchObject({ exitCode: null })
  }, 120_000)

  it('spills overflowing output to a host file', async () => {
    const ctx = await boot()
    const handle = ctx.subprocess.spawn(collectSpec(['bash', '-c', 'for i in $(seq 1 4000); do echo "line-$i"; done']))
    await handle.done
    const read = handle.collected.stdout?.readFrom(0)
    expect(read?.lossy).toBe(true)
    expect(read?.spillPath).toBeDefined()
    const spill = await readFile(read?.spillPath as string, 'utf8')
    expect(spill).toContain('line-1')
    expect(spill).toContain('line-4000')
  }, 120_000)

  it('allocates a terminal with text I/O', async () => {
    const ctx = await boot()
    const terminal = await ctx.subprocess.spawnTerminal({
      argv: ['bash', '-c', 'read x && echo got:$x'], cwd: '/workspace', rows: 24, cols: 80, graceMs: 2000,
    })
    const chunks: string[] = []
    const collector = (async () => {
      for await (const chunk of terminal.output) chunks.push(String(chunk))
    })()
    await new Promise(resolve => setTimeout(resolve, 500))
    await terminal.write('tty-hello\n')
    await terminal.done
    await collector
    expect(chunks.join('')).toContain('got:tty-hello')
    const foreground = await terminal.inspectForeground()
    expect(foreground?.processGroupId).toBeGreaterThan(0)
    await terminal.terminate()
  }, 120_000)

  it('resolves executables and scrubs ambient credentials', async () => {
    const ctx = await boot()
    await expect(ctx.subprocess.resolveExecutable('bash')).resolves.toBe('/usr/bin/bash')
    await expect(ctx.subprocess.resolveExecutable('/bin/echo')).resolves.toBe('/bin/echo')
    await expect(ctx.subprocess.resolveExecutable('definitely-not-a-real-cmd-xyz')).rejects.toThrow()
    const handle = ctx.subprocess.spawn(collectSpec(
      ['bash', '-c', 'printf "<%s><%s><%s>" "$DEEPSEEK_API_KEY" "$DSH_STALE" "$FOO"'],
      { FOO: 'explicit' },
    ))
    await handle.done
    expect(handle.collected.stdout?.readFrom(0).text).toBe('<><><explicit>')
  }, 120_000)
})
