# dsh-docker

Standalone monorepo for the DeepSeek Harness Docker capability — one shared
container owner plus the adapters that expose it to filesystem, bash-tool, and
subprocess consumers.

## Packages

| Package | What it is |
|---|---|
| `packages/docker` — `@vladchatware/dsh-docker` | Shared lifecycle owner of one Docker container. Registers `ctx.docker`; no model-visible context of its own. |
| `packages/fs-docker` — `@vladchatware/dsh-fs-docker` | Filesystem capability (`dsh-fs`) implemented against the container. |
| `packages/tool-docker` — `@vladchatware/dsh-tool-docker` | The `docker_bash` tool capability (`dsh-tools`) implemented against the container. |
| `packages/subprocess-docker` — `@vladchatware/dsh-subprocess-docker` | Subprocess capability (`dsh-subprocess`) implemented against the container. |

## Re-arming idle timeout

The container owner no longer latches `disposing` permanently after the idle
`timeoutMs` expires. The idle timer tears down the current container and
re-arms, so the next `getContainer()` lazily creates a fresh container instead
of failing for the rest of the session. Only session-end hard disposal is
permanent. The default `timeoutMs` is 30 days (2_592_000_000 ms).

## Build and test

```sh
npm install
npm run typecheck
npm run build
npm test               # requires a reachable local Docker engine
```

The lifecycle test (`packages/docker/tests/lifecycle.spec.ts`) proves a
post-timeout `getContainer()` re-arms a fresh container instead of throwing.

## Known flaky tests

Two container-backed tests are timing-sensitive under parallel execution and
pass in isolation:
- `packages/fs-docker/tests/filesystem.spec.ts` > `writes atomically with
  guarded intents` — the file version is `sha256([path, kind, size, mtime-%Y])`
  with mtime in seconds, so two same-size writes landing in the same wall-clock
  second produce an identical version and the stale-version guard does not fire.
- `packages/subprocess-docker/tests/subprocess.spec.ts` > `starts termination
  from the abort signal` — a race between the abort signal and the exec start.

Both are unrelated to the re-arm idle-timeout change and are tracked as
follow-up fixes.
