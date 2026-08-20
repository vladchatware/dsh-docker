/**
 * Shared ownership of one Docker container. Capability adapters await the same
 * container handle, so filesystem and process operations inhabit one Linux
 * execution world, with an optional persistent named volume at cwd.
 * @module @deepseek-ai/dsh-docker
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import Docker from 'dockerode'
import type Dockerode from 'dockerode'
import { parseFrames } from './stream.ts'
import type { DockerFrame } from './stream.ts'

export { parseFrames } from './stream.ts'
export type { DockerFrame } from './stream.ts'
export { Docker }
/** dockerode's `Container` class type, re-exported for adapter signatures. */
export type DockerContainer = Dockerode.Container

/** Error raised when a container operation fails at the Docker Engine boundary. */
export class DockerRuntimeError extends Error {}

/**
 * Error raised when the engine reports the container or exec is gone; the
 * owner or an adapter decides whether the missing object is fatal or benign.
 */
export class DockerGoneError extends DockerRuntimeError {}

/** Configuration for the shared Docker container owner. */
export interface Config {
  /** OCI image name; default 'debian:bookworm-slim'. */
  image?: string
  /** Shared remote working directory, created before adapters receive the container. */
  cwd?: string
  /** Idle container lifetime in milliseconds; on expiry the container is killed and removed, then lazily recreated on the next use. */
  timeoutMs?: number
  /** Named volume mounted at cwd; empty generates a per-container volume. */
  volume?: string
  /** Container name prefix; a short uuid suffix keeps names unique. */
  namePrefix?: string
  /** Create the container lazily on first getContainer() instead of at construction. */
  lazy?: boolean
  /** Docker network mode: 'bridge' (default), 'none', 'host', or a network name. */
  networkMode?: string
  /** Extra environment entries for the container itself. */
  env?: Record<string, string>
}

interface ResolvedConfig {
  image: string
  cwd: string
  timeoutMs: number
  volume: string
  name: string
  lazy: boolean
  networkMode: string
  env: Record<string, string>
}

interface SchemaResolvedConfig extends Config {
  image: string
  cwd: string
  timeoutMs: number
  namePrefix: string
  networkMode: string
  env: Record<string, string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    docker: DockerRuntime
  }
}

/** Quote one opaque argument for in-container bash helper commands. */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll('\'', "'\"'\"'")}'`
}

/** Probe whether the local Docker engine is reachable. */
export async function isInstalled(): Promise<boolean> {
  try {
    const docker = new Docker()
    await docker.ping()
    return true
  } catch {
    return false
  }
}

/** Synchronous heuristic: is a local Docker socket present? */
export function hasLocalSocket(): boolean {
  const socket = process.env.DOCKER_HOST ?? '/var/run/docker.sock'
  if (!socket.startsWith('unix://')) return true
  return existsSync(socket.slice(7))
}

/** One started exec session: stdin sink, parsed frame source, and inspect facts. */
export interface DockerExecSession {
  /** Container-side pid file path holding the exec'd process's pid (its group id). */
  readonly pidFile: string
  /** stdin sink for the exec'd process; undefined when started without stdin. */
  readonly stdin: NodeJS.WritableStream | undefined
  /** Parsed stdout/stderr frames; ends when the exec stream closes. */
  readonly frames: AsyncIterable<DockerFrame>
  /** Current exec facts; Running false and a numeric ExitCode after the process closes. */
  inspect(): Promise<{ running: boolean; exitCode: number | null; pid: number | null }>
}

/** Options for {@link DockerRuntime.execStream}. */
export interface DockerExecStreamOptions {
  /** argv to run; argv[0] is the program. */
  argv: readonly string[]
  /** Working directory for the exec'd process. */
  cwd?: string
  /** Explicit environment merged onto the container's own environment. */
  env?: Readonly<Record<string, string>> | undefined
  /** stdin disposition: ignore (default), expose a sink, or write-and-close bytes. */
  stdin?: 'ignore' | 'pipe' | { readonly data: string }
  /** Allocate a PTY for the exec'd process. */
  tty?: boolean
  /** Initial terminal dimensions when tty is set. */
  rows?: number
  /** Initial terminal dimensions when tty is set. */
  cols?: number
}

/**
 * Owns one lazily consumable Docker container. An idle timer kills and removes
 * the container on expiry and re-arms, so the next {@link getContainer} lazily
 * creates a fresh one; only session-end disposal is permanent. Container
 * creation begins at plugin construction (unless lazy); adapters await
 * {@link getContainer} before their first operation.
 */
export class DockerRuntime extends Service {
  static Config: z<Config> = z.object({
    image: z.string().default('debian:bookworm-slim'),
    cwd: z.string().default('/workspace'),
    timeoutMs: z.number().default(2_592_000_000),
    volume: z.string().default(''),
    namePrefix: z.string().default(''),
    lazy: z.boolean().default(false),
    networkMode: z.string().default('bridge'),
    env: z.dict(z.string()).default({}),
  })

  /** Validated remote working directory shared by provider adapters. */
  readonly cwd: string
  /** Remote directory reserved for adapter-owned process and terminal state. */
  readonly runtimeRoot: string

  private readonly config: ResolvedConfig
  private readonly docker: Docker
  private container: Docker.Container | null = null
  private ready: Promise<Docker.Container> | null
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'docker')
    // Schemastery fills these fields before construction; the type does not encode that step.
    const resolved = config as SchemaResolvedConfig
    const suffix = randomUUID().slice(0, 8)
    const name = `dsh-dkr-${resolved.namePrefix.length > 0 ? `${resolved.namePrefix}-` : ''}${suffix}`
    this.config = {
      image: resolved.image,
      cwd: resolved.cwd,
      timeoutMs: resolved.timeoutMs,
      volume: (resolved.volume ?? '').length > 0 ? resolved.volume as string : `${name}-vol`,
      name,
      lazy: resolved.lazy ?? false,
      networkMode: resolved.networkMode,
      env: resolved.env,
    }
    this.validate()
    this.cwd = this.config.cwd
    this.runtimeRoot = posix.join(this.cwd, '.dsh-dkr')
    this.docker = new Docker()
    this.ready = this.config.lazy ? null : this.open()
    if (this.ready !== null) {
      // A deployment may load the owner before any adapter uses it. Keep a
      // failed eager boot observed; getContainer() still returns the error.
      void this.ready.catch(() => {})
    }
    this.armIdleTimer()

    ctx.effect(() => async () => {
      this.disposed = true
      this.clearIdleTimer()
      await this.teardown()
    }, 'docker container teardown')
  }

  /**
   * Return the shared live Docker container, lazily creating a fresh one after
   * an idle expiry cycle. Expiry tears down the previous container and re-arms,
   * rather than permanently disposing the service.
   * @returns the container after the configured cwd and runtime root exist.
   * @throws when Docker rejects creation or the service is hard-disposed.
   */
  async getContainer(): Promise<Docker.Container> {
    if (this.isDisposing()) throw new DockerRuntimeError('docker container service is disposing')
    const container = await this.awaitReady()
    // Awaiting readiness yields to disposal.
    if (this.isDisposing()) throw new DockerRuntimeError('docker container service is disposing')
    return container
  }

  /** Start container creation lazily and pause until it is ready. */
  private awaitReady(): Promise<Docker.Container> {
    if (this.ready === null) {
      this.ready = this.open()
      this.armIdleTimer()
    }
    return this.ready
  }

  /** Cancel any pending idle timer. */
  private clearIdleTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Re-arm the idle cycle: teardown the current container on expiry, then
   *  drop readiness so the next use opens a fresh container, and bound it too. */
  private armIdleTimer(): void {
    this.clearIdleTimer()
    this.timer = setTimeout(() => {
      void (async () => {
        await this.teardown()
        this.ready = null
        this.armIdleTimer()
      })()
    }, this.config.timeoutMs)
  }

  /** Whether the service has begun disposal. */
  private isDisposing(): boolean {
    return this.disposed
  }

  /** The container's unique name (for diagnostics). */
  get containerName(): string {
    return this.config.name
  }

  /**
   * Run one bash command in the container and return its trimmed stdout.
   * @param command - the bash command line to run.
   * @returns the command's stdout, with trailing newline stripped.
   * @throws DockerRuntimeError when the command exits nonzero (stderr is included).
   */
  async guest(command: string): Promise<string> {
    const { exitCode, stdout, stderr } = await this.execCollected({ argv: ['bash', '-c', command] })
    if (exitCode !== 0) {
      const detail = stderr.trim().length > 0 ? `: ${stderr.trim()}` : ''
      throw new DockerRuntimeError(`docker guest command exited ${exitCode}${detail}`)
    }
    return stdout.trim()
  }

  /**
   * Run one exec and collect its full output, bounding nothing.
   * @param options - argv, cwd, env, and stdin disposition.
   * @returns the exit code and the full stdout/stderr text after the process closes.
   */
  async execCollected(options: DockerExecStreamOptions): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const session = await this.execStream(options)
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    for await (const frame of session.frames) {
      if (frame.stream === 1) stdoutChunks.push(frame.data)
      else stderrChunks.push(frame.data)
    }
    const inspect = await session.inspect()
    return {
      exitCode: inspect.running ? null : inspect.exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    }
  }

  /**
   * Start one exec in the container. The command is wrapped so its process
   * becomes its own process-group leader and writes its pid (its group id) to
   * a private file; adapters use that pid for tree-scoped termination.
   * @param options - argv, cwd, env, stdin, and PTY options.
   * @returns the exec session with stdin sink, parsed frames, and inspect facts.
   */
  async execStream(options: DockerExecStreamOptions): Promise<DockerExecSession> {
    const container = await this.getContainer()
    const execId = randomUUID().slice(0, 16)
    const pidFile = posix.join(this.runtimeRoot, `${execId}.pid`)
    const argv = options.argv
    const wrapper = [
      'bash', '-c',
      'echo $$ > "$1"; shift; exec "$@"',
      'dsh-docker-exec', pidFile, ...argv,
    ]
    const stdin: 'ignore' | 'pipe' | { readonly data: string } = options.stdin ?? 'ignore'
    const exec = await container.exec({
      Cmd: wrapper,
      WorkingDir: options.cwd ?? this.cwd,
      Env: this.envEntries(options.env),
      AttachStdin: stdin !== 'ignore',
      AttachStdout: true,
      AttachStderr: true,
      Tty: options.tty === true,
    })
    const stream = await exec.start({
      hijack: true,
      stdin: stdin !== 'ignore',
    })
    if (options.rows !== undefined && options.cols !== undefined) {
      await exec.resize({ h: options.rows, w: options.cols })
    }
    const frames = parseFrames(stream)
    const stdinSink = stdin === 'pipe' ? stream : undefined
    if (stdin !== 'ignore' && stdin !== 'pipe') {
      stream.write(Buffer.from(stdin.data, 'utf8'))
      stream.end()
    }
    return {
      pidFile,
      stdin: stdinSink,
      frames,
      inspect: async () => {
        const info = await exec.inspect()
        return {
          running: info.Running,
          exitCode: typeof info.ExitCode === 'number' ? info.ExitCode : null,
          pid: info.Pid,
        }
      },
    }
  }

  private envEntries(overrides: Readonly<Record<string, string>> | undefined): string[] {
    const env: Record<string, string> = { ...this.config.env }
    if (overrides !== undefined) {
      for (const [key, value] of Object.entries(overrides)) {
        env[key] = value
      }
    }
    return Object.entries(env).map(([key, value]) => `${key}=${value}`)
  }

  private validate(): void {
    if (this.config.image.length === 0) {
      throw new Error('dsh-docker: image must not be empty')
    }
    if (!posix.isAbsolute(this.config.cwd)) {
      throw new Error(`dsh-docker: cwd must be an absolute Linux path: ${this.config.cwd}`)
    }
    if (!Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs <= 0) {
      throw new Error('dsh-docker: timeoutMs must be a positive finite number')
    }
    if (this.config.name.length > 60) {
      throw new Error('dsh-docker: container name is too long')
    }
  }

  private async open(): Promise<Docker.Container> {
    const container = await this.docker.createContainer({
      name: this.config.name,
      Image: this.config.image,
      Cmd: ['sleep', 'infinity'],
      WorkingDir: this.config.cwd,
      Tty: false,
      HostConfig: {
        Binds: [`${this.config.volume}:${this.config.cwd}`],
        NetworkMode: this.config.networkMode,
      },
      Env: this.envEntries(undefined),
    })
    try {
      await container.start()
      const mkdir = await container.exec({
        Cmd: ['bash', '-c', `mkdir -p ${quoteShellArg(this.cwd)} ${quoteShellArg(this.runtimeRoot)}`],
        AttachStdout: true, AttachStderr: true, Tty: false,
      })
      const mkStream = await mkdir.start({ hijack: false, stdin: false })
      await drain(parseFrames(mkStream))
      const chmod = await container.exec({
        Cmd: ['bash', '-c', `chmod 700 ${quoteShellArg(this.runtimeRoot)}`],
        AttachStdout: true, AttachStderr: true, Tty: false,
      })
      const chStream = await chmod.start({ hijack: false, stdin: false })
      await drain(parseFrames(chStream))
      this.container = container
      return container
    } catch (error: unknown) {
      try {
        await container.remove({ force: true })
      } catch {
        // Single rollback attempt; the container timeout bounds any leak.
      }
      throw error
    }
  }

  private async teardown(): Promise<void> {
    const container = this.container
    this.container = null
    if (container === null) return
    try {
      await container.kill().catch(() => {})
      await container.remove({ force: true }).catch(() => {})
    } catch {
      // The container is already gone; nothing else to clean up.
    }
  }
}

export default DockerRuntime

/** Consume every frame of an exec stream to completion (e.g. for boot prep). */
async function drain(frames: AsyncIterable<DockerFrame>): Promise<void> {
  for await (const _frame of frames) {
    // The exec's output is irrelevant to boot preparation; only completion matters.
  }
}
