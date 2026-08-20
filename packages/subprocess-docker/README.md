# @vladchatware/dsh-subprocess-docker

Docker implementation of the [subprocess seam](../../subprocess/subprocess/README.md)
(`ctx.subprocess`). Load `@vladchatware/dsh-docker` first, then this service
in place of `dsh-subprocess-local`; existing Bash, PTY, and LSP consumers then
execute in the shared container.

Substrate facts (verified live): each exec is its own process-group leader
(the owner's wrapper writes pid == pgid), so tree-scoped termination is one
in-guest group kill; `tty(true)` execs give programmatic PTY text I/O plus
resize. Output frames are Docker's multiplexed 8-byte-headered stream, which
the owner's parseFrames demultiplexes.

Known substrate limits:

- **No signal fact** — Docker reports a signal death as exit code 128+N; the
  provider maps 128+N to the signal and attributes SIGTERM/SIGKILL when it
  performed the kill itself.
- **Foreground-group inspection is best-effort** — dockerode exposes no
  foreground-group primitive; the terminal reports its session leader.
- **Collect/spill** keeps a bounded host tail and, when configured, a host
  spill file with offset reads (output.ts).
- **Ambient credentials are scrubbed** — host `DSH_*` and credential-shaped
  names are not inherited; every `spec.env` entry is an explicit opt-in.

## Model Experience

Indirectly, through the Bash executor behind `dsh-tool-bash`, which renders
remote output, exit facts, and spill paths.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **128+N exit coding is a convention** — unrequested signal deaths are
  reported only when no wrapper-published code wins; the provider cannot prove
  a signal it did not send.
- **Synchronous-PID consumers are unsupported** — pid resolves shortly after
  start (from the pid file), not synchronously at spawn.
- **Private state lives for the container lifetime** — process pid files
  remain under `.dsh-dkr` until the owner removes the container.
