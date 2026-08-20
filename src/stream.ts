/**
 * Parsing for Docker's multiplexed exec output streams. The daemon wraps every
 * exec stdout/stderr payload in an 8-byte header (stream type byte + 3
 * reserved bytes + 4-byte big-endian length) on the hijacked or streamed
 * transport; consumers must split the frames back out before routing output.
 * @module @deepseek-ai/dsh-docker/stream
 */

import { Buffer } from 'node:buffer'

/** One parsed payload from a multiplexed Docker exec stream. */
export interface DockerFrame {
  /** 1 for stdout, 2 for stderr; other header types are never emitted here. */
  readonly stream: 1 | 2
  /** The payload bytes; empty frames are dropped by the parser. */
  readonly data: Buffer
}

/**
 * Split a raw Docker exec byte stream into stdout/stderr frames. Chunks may
 * split or merge frames across the 8-byte headers, so a carry buffer joins
 * partial headers across iterations. Frames with type other than 1/2 (stdin
 * echo, resize, terminal events) are dropped.
 * @param source - the raw bytes from the exec stream.
 * @returns parsed stdout/stderr frames in arrival order.
 */
export async function* parseFrames(source: AsyncIterable<Uint8Array>): AsyncGenerator<DockerFrame> {
  let pending = Buffer.alloc(0)
  for await (const chunk of source) {
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk])
    while (pending.length >= 8) {
      const stream = pending[0] as number
      const length = pending.readUInt32BE(4)
      if (pending.length < 8 + length) break
      const payload = pending.subarray(8, 8 + length)
      if ((stream === 1 || stream === 2) && length > 0) {
        yield { stream, data: Buffer.from(payload) }
      }
      pending = pending.subarray(8 + length)
    }
  }
}

/**
 * Frame-parsing sink that demultiplexes Docker exec output into per-stream
 * chunks as they arrive. Adapters feed raw bytes and receive typed frames on
 * the iterable returned by {@link parseFrames}.
 */
export const FRAME_STDOUT = 1 as const
export const FRAME_STDERR = 2 as const
