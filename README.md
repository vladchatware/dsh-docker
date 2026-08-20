# @deepseek-ai/dsh-docker

Shared lifecycle owner for one Docker container. Capability adapters inject
`ctx.docker` and await the same container handle, so filesystem and process
operations inhabit one Linux execution world with an optional persistent named
volume at cwd. The owner mounts the engine through dockerode's socket/HTTP
transport; it never uses the gRPC transport, so the optional native
`cpu-features`/ssh2 builds stay denied in the workspace `allowBuilds`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| image | debian:bookworm-slim | OCI image to run |
| cwd | /workspace | Shared remote working directory, created before adapters start |
| timeoutMs | 2592000000 (30 days) | Idle container lifetime (ms); on expiry the container is killed and removed, then lazily recreated on the next use |
| volume | auto-generated | Named volume mounted at cwd (persists across container removal) |
| namePrefix | '' | Container-name prefix; a short uuid suffix keeps names unique |
| lazy | false | Create the container on first getContainer() instead of at construction |
| networkMode | bridge | Docker network mode: bridge, none, host, or a network name |
| env | {} | Extra environment entries for the container itself |

## Lifecycle and ownership

Construction starts container creation eagerly (unless `lazy`) under a name
like `dsh-dkr-<prefix>-<uuid8>`. Before `getContainer()` resolves, the owner
creates `cwd` and the private `cwd/.dsh-dkr` adapter-state directory, sets it
to mode `0700`, and verifies it is a real directory. Only session-end disposal is
permanent: it kills and removes the container. The idle timer also kills and
removes the container on expiry, but re-arms, so the next `getContainer()`
lazily creates a fresh container rather than erroring. `execStream` wraps every
argv so its process becomes its own process-group leader and writes
`pid == pgid` to a private pid file; the parsed, multiplexed exec output
comes from parseFrames (stream.ts).

## Model Experience

None, as this shared container owner registers no model-visible context;
provider adapters and consumers own any rendered effects.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **One container per harness session** — a real host footprint (a Debian
  container per session); operators should bound concurrent sessions.
- **Shared kernel isolation** — a container is weaker than a microVM for
  untrusted user code; treat it as an isolation improvement over the host,
  not a hardware boundary.
- **No network policy or secrets yet** — the container gets the default bridge
  network and its configured env only; per-host/port allow rules and secret
  wiring are follow-ups.
- **Runs as root by default** — dropping to a non-root user is a follow-up.
- **Requires a local Docker Engine and image pull** — `isInstalled()` pings
  the engine; tests gate on `hasLocalSocket()`.
