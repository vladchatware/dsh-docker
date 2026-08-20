# @vladchatware/dsh-fs-docker

Docker implementation of the [filesystem seam](../../fs/fs/README.md)
(`ctx.fs`). Paths, contents, and atomic staging files stay inside the shared
container owned by `@vladchatware/dsh-docker`. Load the owner first, then this
service in place of `dsh-fs-local`; `dsh-tool-fs` and the policy layer then
operate on the container execution world unchanged.

Implementation notes and known limits:

- **Canonical targets** are absolute guest paths transported as base64 with
  strict NUL framing; resolve/processPath/fileUrl/contains project container
  paths into the seam.
- **Version tokens** derive from guest stat facts (path, kind, size, mode,
  mtime) — the Docker metadata API exposes no per-file revision, so two writes
  within the mtime tick with identical facts collide and the stale guard
  degrades to a no-op.
- **Atomic writes** stage into a private sibling temp name and commit with a
  container-side mv (a guarded ln -T no-clobber publication for
  `createIfAbsent`), mirroring the E2B adapter.
- **lstat** reports symlinks via an in-guest helper because dockerode exposes
  no no-follow primitive.
- **Text/binary handling** mirrors the seam: UTF-8 validation and an 8192-byte
  NUL sample reject binary and invalid content as FS_NOT_TEXT.
- The logged image must contain the GNU utilities this adapter invokes
  (realpath, base64, stat, ln, chmod — debian:bookworm-slim does).

## Model Experience

Indirectly, through `dsh-tool-fs`, which renders remote UTF-8 content,
directory results, mutation acknowledgements, and provider errors while
container identity and transport remain internal.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **No host synchronization** — the container cwd starts empty; local files
  are neither uploaded nor reflected back.
- **Mutation coordination is host-process-local** — a concurrent container
  process can still race replacement; version guards detect only metadata
  changes Docker exposes.
- **Whole-file mutation costs remain** — overwrite diffs and literal edits
  read complete files through the archive transport.
- **File transfer cost** — every read and write crosses the Docker archive
  API tar in/out of the container.
