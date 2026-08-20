/**
 * Bounded host-side projection of one Docker exec output stream.
 * @module @vladchatware/dsh-subprocess-docker/output
 */

import { Buffer } from 'node:buffer'
import { createWriteStream, unlinkSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import type { SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/**
 * Byte-faithful offset reader over one collect-mode stream. Keeps the bounded
 * TAIL in host memory and, when configured, mirrors the complete stream to a
 * host spill file up to the spill cap. Offsets are whole-stream byte
 * coordinates owned by the caller.
 */
export class CollectReader implements SubprocessOutputReader {
  private chunks: Buffer[] = []
  private retainedBytes = 0
  private totalBytes = 0
  private spillValid = false
  private spillWriter: WriteStream | undefined
  private finished = false

  constructor(
    private readonly maxBytes: number,
    private readonly maxSpillBytes: number | undefined,
    private readonly spillPath: string | undefined,
  ) {
    if (spillPath !== undefined && maxSpillBytes !== undefined) {
      // 'wx' refuses to follow or clobber a pre-existing file at a guessable path.
      this.spillWriter = createWriteStream(spillPath, { flags: 'wx' })
      this.spillValid = true
    }
  }

  /** Total bytes observed from the exec frame stream. */
  get size(): number {
    return this.totalBytes
  }

  /** Append one raw output chunk from the Docker exec stream. */
  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return
    const chunk = Buffer.from(bytes)
    this.totalBytes += chunk.length
    this.chunks.push(chunk)
    this.retainedBytes += chunk.length
    while (this.retainedBytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.retainedBytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.retainedBytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retainedBytes -= excess
      }
    }
    if (this.spillWriter !== undefined && this.spillValid) {
      const cap = this.maxSpillBytes
      if (cap !== undefined && this.totalBytes <= cap) {
        this.spillWriter.write(chunk)
      } else {
        // A stream past the spill cap discards its now-incomplete spill.
        this.invalidateSpill()
      }
    }
  }

  /** Mark the spill invalid (overflow or interrupted transport). */
  invalidateSpill(): void {
    if (this.spillWriter !== undefined) {
      this.spillWriter.destroy()
      this.spillWriter = undefined
    }
    if (this.spillPath !== undefined) {
      try {
        unlinkSync(this.spillPath)
      } catch {
        // The spill file may never have been created or already removed.
      }
    }
  }

  /** Finish the reader: close the spill and publish the offset surface. */
  finish(): void {
    if (this.finished) return
    this.finished = true
    if (this.spillWriter !== undefined) this.spillWriter.end()
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    const spillPath = this.spillValid ? this.spillPath : undefined
    if (this.totalBytes === 0) {
      return { text: '', nextOffset: 0, lossy: false, ...(spillPath !== undefined ? { spillPath } : {}) }
    }
    if (fromByte < this.tailStart()) {
      const tail = Buffer.concat(this.chunks).toString('utf8')
      return { text: tail, nextOffset: this.totalBytes, lossy: true, ...(spillPath !== undefined ? { spillPath } : {}) }
    }
    let offset = this.tailStart()
    const selected: Buffer[] = []
    for (const chunk of this.chunks) {
      const end = offset + chunk.length
      if (end <= fromByte) {
        offset = end
        continue
      }
      const start = Math.max(0, fromByte - offset)
      selected.push(chunk.subarray(start))
      offset = end
    }
    const text = Buffer.concat(selected).toString('utf8')
    return { text, nextOffset: this.totalBytes, lossy: false, ...(spillPath !== undefined ? { spillPath } : {}) }
  }

  private tailStart(): number {
    return this.totalBytes - this.retainedBytes
  }
}
