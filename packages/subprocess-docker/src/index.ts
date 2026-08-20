/**
 * Docker provider for the subprocess capability seam: managed process trees
 * and terminal sessions inside the shared container. Each exec is wrapped so
 * its process becomes its own process-group leader whose pid (its group id) is
 * recorded to a private file, so tree-scoped termination is one in-container
 * group kill.
 * @module @vladchatware/dsh-subprocess-docker
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  DockerRuntime,
  DockerRuntimeError,
  quoteShellArg,
} from '@vladchatware/dsh-docker'
import type { DockerFrame, DockerExecSession } from '@vladchatware/dsh-docker'
import { CollectReader } from './output.ts'

const MAX_TIMER_DELAY_MS = 2_147_483_647

function assertGraceMs(graceMs: number): void {
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess-docker: graceMs must be a positive finite number <= ${MAX_TIMER_DELAY_MS}`)
  }
}

/** Merge the spec env over the shared scrub, honoring undefined tombstones. */
function mergedEnv(env: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> {
  const base = scrubbedParentEnv()
  if (env === undefined) return base
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (env[key] === undefined) result[key] = value
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

/** One managed process tree in the container. */
class DockerProcessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>

  private pidValue = -1
  private pgid = -1
  private terminated = false
  private killedWith: 'SIGTERM' | 'SIGKILL' | null = null
  private readonly stdoutCollector: CollectReader | undefined
  private readonly stderrCollector: CollectReader | undefined
  private readonly stdoutPipe: Readable | undefined
  private readonly stderrPipe: Readable | undefined
  private readonly stdinBuffer: Buffer[] = []
  private stdinSink: NodeJS.WritableStream | undefined
  private stdinClosed = false
  private readonly abortListener: (() => void) | undefined

  constructor(
    private readonly runtime: DockerSubprocessRuntime,
    private readonly spec: SubprocessSpawnSpec,
  ) {
    assertGraceMs(spec.graceMs)
    const stdout = this.makeReader(this.spec.stdio.stdout)
    const stderr = this.makeReader(this.spec.stdio.stderr)
    this.stdout = stdout.stream
    this.stderr = stderr.stream
    this.stdoutCollector = stdout.collector
    this.stderrCollector = stderr.collector
    this.stdoutPipe = stdout.stream
    this.stderrPipe = stderr.stream
    this.collected = {
      ...(this.stdoutCollector !== undefined ? { stdout: this.stdoutCollector } : {}),
      ...(this.stderrCollector !== undefined ? { stderr: this.stderrCollector } : {}),
    }
    this.stdin = spec.stdio.stdin === 'pipe'
      ? new Writable({
        write: (chunk, _encoding, callback) => {
          this.stdinBuffer.push(Buffer.from(chunk as string | Uint8Array))
          void this.drainStdin()
          callback()
        },
        final: (callback) => {
          this.stdinClosed = true
          void this.drainStdin()
          callback()
        },
      })
      : undefined
    this.done = this.start()
    if (spec.signal !== undefined) {
      this.abortListener = () => { this.terminate() }
      if (spec.signal.aborted) this.terminate()
      else spec.signal.addEventListener('abort', this.abortListener, { once: true })
    }
  }

  get pid(): number {
    return this.pidValue
  }

  terminate(): void {
    if (this.terminated || this.pgid < 0) return
    this.terminated = true
    void this.escalate()
  }

  waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal !== undefined && signal.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const listener = () => { finish(false) }
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', listener)
        resolve(value)
      }
      signal?.addEventListener('abort', listener, { once: true })
      void this.done.then(() => { finish(true) }, () => { finish(true) })
    })
  }

  private makeReader(mode: SubprocessOutputMode): {
    stream: Readable | undefined
    collector: CollectReader | undefined
  } {
    if (mode === 'pipe') {
      return { stream: new Readable({ read() {} }), collector: undefined }
    }
    if (mode === 'inherit') {
      return { stream: undefined, collector: undefined }
    }
    const collect = mode
    const spillPath = collect.spill !== undefined
      ? join(tmpdir(), `dsh-dkr-${randomUUID()}.spill`)
      : undefined
    return {
      stream: undefined,
      collector: new CollectReader(collect.maxBytes, collect.spill?.maxBytes, spillPath),
    }
  }

  private async start(): Promise<SubprocessOutcome> {
    try {
      const session = await this.runtime.owner.execStream({
        argv: this.spec.argv,
        cwd: this.spec.cwd,
        env: mergedEnv(this.spec.env),
        stdin: this.spec.stdio.stdin,
      })
      this.stdinSink = session.stdin
      // Resolve the group leader pid immediately, independent of any output:
      // a silent process emits no frames, so pid resolution must not depend on
      // the first frame arriving.
      const pid = await readGuestPid(this.runtime, session.pidFile)
      if (pid !== null) {
        this.pgid = pid
        this.pidValue = pid
      }
      await this.drainStdin()
      const outcome = await this.runEvents(session)
      this.finishReaders()
      return outcome
    } catch (error: unknown) {
      this.finishReaders()
      throw error
    }
  }

  private async runEvents(session: DockerExecSession): Promise<SubprocessOutcome> {
    for await (const frame of session.frames) {
      this.emit(frame)
    }
    const inspect = await session.inspect()
    if (inspect.running) {
      // A stream closed while the process still runs (e.g. transport cut);
      // the caller's terminate ladder owns escalation.
      return { exitCode: null, signal: this.killedWith }
    }
    return classifyExit(inspect.exitCode, this.killedWith)
  }

  private emit(frame: DockerFrame): void {
    const bytes = frame.data
    if (frame.stream === 1) {
      if (this.stdoutPipe !== undefined) this.stdoutPipe.push(Buffer.from(bytes))
      else if (this.stdoutCollector !== undefined) this.stdoutCollector.push(bytes)
      else process.stdout.write(Buffer.from(bytes))
    } else {
      if (this.stderrPipe !== undefined) this.stderrPipe.push(Buffer.from(bytes))
      else if (this.stderrCollector !== undefined) this.stderrCollector.push(bytes)
      else process.stderr.write(Buffer.from(bytes))
    }
  }

  private finishReaders(): void {
    this.stdoutPipe?.push(null)
    this.stderrPipe?.push(null)
    this.stdoutCollector?.finish()
    this.stderrCollector?.finish()
  }

  private async drainStdin(): Promise<void> {
    const sink = this.stdinSink
    if (sink === undefined) return
    while (this.stdinBuffer.length > 0) {
      const chunk = this.stdinBuffer.shift() as Buffer
      await writeSink(sink, chunk)
    }
    if (this.stdinClosed) sink.end()
  }

  private async escalate(): Promise<void> {
    const pgid = this.pgid
    if (pgid <= 0) return
    try {
      this.killedWith = 'SIGTERM'
      await this.runtime.owner.guest(`kill -TERM -- -${pgid} 2>/dev/null; true`)
      await new Promise(resolve => setTimeout(resolve, this.spec.graceMs))
      this.killedWith = 'SIGKILL'
      await this.runtime.owner.guest(`kill -KILL -- -${pgid} 2>/dev/null; true`)
    } catch {
      // The container may be gone; quiescence is proven by done settling.
    }
  }
}

/** One terminal session in the container. */
class DockerTerminalHandle implements SubprocessTerminalHandle {
  readonly output: Readable
  readonly done: Promise<SubprocessOutcome>

  private pidValue = -1
  private pgid = -1
  private terminated = false
  private killedWith: 'SIGTERM' | 'SIGKILL' | null = null
  private sink: NodeJS.WritableStream | undefined

  constructor(
    private readonly runtime: DockerSubprocessRuntime,
    private readonly spec: SubprocessTerminalSpawnSpec,
    private readonly outputSink: Readable,
  ) {
    assertGraceMs(spec.graceMs)
    this.output = outputSink
    this.done = this.start()
  }

  get pid(): number {
    return this.pidValue
  }

  async write(data: string): Promise<void> {
    if (this.sink === undefined) throw new Error('subprocess-docker: terminal stdin is unavailable')
    await writeSink(this.sink, Buffer.from(data, 'utf8'))
  }

  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    if (this.pgid <= 0) return Promise.resolve(undefined)
    // Docker exposes no foreground-group inspection; report the terminal
    // session leader. Best-effort, documented substrate limit.
    return Promise.resolve({ processGroupId: this.pgid, inputWaiting: false })
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    const pgid = this.pgid
    if (pgid <= 0) throw new Error('subprocess-docker: terminal has not started')
    if (signal === 'SIGTERM') this.killedWith = 'SIGTERM'
    else if (signal === 'SIGKILL') this.killedWith = 'SIGKILL'
    await this.runtime.owner.guest(`kill -${signalName(signal)} -- -${pgid} 2>/dev/null; true`)
    return pgid
  }

  async terminate(): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    const pgid = this.pgid
    if (pgid <= 0) return
    try {
      this.killedWith = 'SIGTERM'
      await this.runtime.owner.guest(`kill -TERM -- -${pgid} 2>/dev/null; true`)
      await new Promise(resolve => setTimeout(resolve, this.spec.graceMs))
      this.killedWith = 'SIGKILL'
      await this.runtime.owner.guest(`kill -KILL -- -${pgid} 2>/dev/null; true`)
    } catch {
      // Quiescence is proven by done settling.
    }
    try {
      await this.done
    } catch {
      // A transport failure still settles in-flight handle calls.
    }
  }

  private async start(): Promise<SubprocessOutcome> {
    try {
      const session = await this.runtime.owner.execStream({
        argv: this.spec.argv,
        cwd: this.spec.cwd,
        env: this.spec.env,
        stdin: 'pipe',
        tty: true,
        rows: this.spec.rows,
        cols: this.spec.cols,
      })
      this.sink = session.stdin
      // Resolve the group leader pid immediately, independent of any output:
      // a silent terminal session emits no frames until the user types.
      const pid = await readGuestPid(this.runtime, session.pidFile)
      if (pid !== null) {
        this.pgid = pid
        this.pidValue = pid
      }
      for await (const frame of session.frames) {
        this.outputSink.push(Buffer.from(frame.data))
      }
      this.outputSink.push(null)
      const inspect = await session.inspect()
      if (inspect.running) return { exitCode: null, signal: this.killedWith }
      return classifyExit(inspect.exitCode, this.killedWith)
    } catch (error: unknown) {
      this.outputSink.destroy(error as Error)
      throw error
    }
  }

}

/** Docker implementation of the subprocess seam. */
export class DockerSubprocessRuntime extends SubprocessRuntime {
  static inject = ['docker']

  /** @internal Shared owner handle for adapter use. */
  readonly owner: DockerRuntime

  private readonly handles = new Set<{ terminate(): void | Promise<void>; done: Promise<unknown> }>()

  constructor(ctx: Context) {
    super(ctx)
    this.owner = ctx.docker
    ctx.effect(() => async () => {
      const live = [...this.handles]
      for (const handle of live) void handle.terminate()
      await Promise.allSettled(live.map(handle => handle.done))
    }, 'docker subprocess teardown')
  }

  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    _signal?: AbortSignal,
  ): Promise<string> {
    if (command.includes('/')) {
      if (command.startsWith('/')) {
        const result = await this.owner.guest(`test -x ${quoteShellArg(command)} && printf ok || printf missing`)
        if (result !== 'ok') throw new DockerRuntimeError(`subprocess-docker: executable not found: ${command}`)
        return command
      }
      throw new DockerRuntimeError('subprocess-docker: relative command paths with separators are not supported')
    }
    const envEntries = Object.entries(mergedEnv(env))
      .map(([key, value]) => `${key}=${quoteShellArg(value)}`)
      .join(' ')
    const path = await this.owner.guest(`${envEntries} command -v ${quoteShellArg(command)}`)
    if (path.length === 0) throw new DockerRuntimeError(`subprocess-docker: executable not found: ${command}`)
    return path
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = new DockerProcessHandle(this, spec)
    this.handles.add(handle)
    void handle.done.finally(() => this.handles.delete(handle))
    return handle
  }

  override spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const output = new Readable({ read() {} })
    const handle = new DockerTerminalHandle(this, spec, output)
    this.handles.add(handle)
    void handle.done.finally(() => this.handles.delete(handle))
    return Promise.resolve(handle)
  }
}

export default DockerSubprocessRuntime

const SIGNAMES: Record<number, NodeJS.Signals | undefined> = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 6: 'SIGABRT', 9: 'SIGKILL',
  13: 'SIGPIPE', 15: 'SIGTERM', 18: 'SIGCONT', 19: 'SIGSTOP', 20: 'SIGTSTP',
}

/**
 * Classify a Docker exec exit code into subprocess exit facts. Docker reports
 * an exit code of 128+N for a process killed by signal N, and 0-255 for a
 * normal exit; the substrate exposes no separate signal fact.
 * @param code - the exec's exit code (null when the process is still running).
 * @param killedWith - the signal this provider used to terminate the tree, if any.
 * @returns exit facts: a normal code maps to exitCode, a 128+N code maps to signal.
 */
function classifyExit(code: number | null, killedWith: 'SIGTERM' | 'SIGKILL' | null): SubprocessOutcome {
  if (code === null || code < 128) return { exitCode: code, signal: null }
  const signal = SIGNAMES[code - 128]
  return { exitCode: null, signal: signal ?? killedWith ?? 'SIGKILL' }
}

function signalName(signal: SubprocessTerminalSignal): string {
  return signal.replace(/^SIG/, '')
}

function writeSink(sink: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.write(chunk, (error?: Error | null) => {
      if (error !== null && error !== undefined) reject(error)
      else resolve()
    })
  })
}

/** Read the group-leader pid a wrapper wrote to its pid file, if any. */
async function readGuestPid(runtime: DockerSubprocessRuntime, pidFile: string): Promise<number | null> {
  try {
    const line = await runtime.owner.guest(`cat ${quoteShellArg(pidFile)} 2>/dev/null`)
    const value = Number.parseInt(line, 10)
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}
