# @vladchatware/dsh-tool-docker

Model-facing `docker_bash` tool: run untrusted code inside the isolated Docker
container owned by `@vladchatware/dsh-docker`, **alongside** the host execution
world. Mount both this tool and the owner in a composition to give the agent
container execution without replacing the host `bash`/fs tools.

```yaml
- id: docker
  name: '@vladchatware/dsh-docker'
  config:
    image: debian:bookworm-slim
    cwd: /workspace
    timeoutMs: 180000
    volume: dsh-web-workspace
    lazy: true

- id: tool-docker
  name: '@vladchatware/dsh-tool-docker'
```

`lazy: true` boots the container only on the first `docker_bash` call, so a
session that never touches the container costs nothing.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| maxOutputBytes | 65536 | Per-stream output cap; overflow keeps the tail and sets truncated |
| timeoutMsCap | 60000 | Cap on the tool's timeoutMs parameter (silently clamped) |

## Model Experience

### docker_bash tool schema

#### What the model sees

A single tool, `docker_bash`, that runs one bash command inside the isolated
Docker container — a separate machine from the host with its own filesystem at
/workspace backed by a persistent volume. Parameters: `command` (required),
`description` (required), `workdir` (default: the owner's cwd, /workspace),
and `timeoutMs` (clamped to the cap). It returns `exitCode`, `stdout`,
`stderr`, `truncated`, and `timedOut`; a timeout kills the whole process
group. Registered alongside the host `bash` tool — use `docker_bash` for
untrusted code, experiments, or anything that must not touch the host. See the
[tool catalog](../../../docs/tool-catalog.md#docker_bash).

#### Token effect

Each `docker_bash` call contributes the command, description, and returned
stdout/stderr bounded to maxOutputBytes per stream; an internal list delimiter
separates stderr. A truncated or timed-out tail is marked explicitly.

#### KV Cache effect

No direct invalidation; the rendered result is a fresh call each time, so the
request prefix is unchanged.

## Known Limitations and Deferred Work

- **Container output is bounded but not spilled** — overflow keeps the tail
  with a truncated marker; no host spill file for full retention (unlike the
  subprocess adapter's collect mode).
- **Runs as root by default** — dropping to a non-root user in the tool target
  is a follow-up.
