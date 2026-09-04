/**
 * Wire framing for both hops:
 *
 * - Native messaging (relay <-> Chrome): 4-byte little-endian length prefix
 *   followed by a UTF-8 JSON payload. Chrome caps messages at 1MB sent to the
 *   host and 64MB received from the host; we accept up to 64MB.
 * - Hub TCP (hub <-> relay): newline-delimited JSON (NDJSON).
 */

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_LINE_BYTES = MAX_FRAME_BYTES;

/** Encode one JSON message as a native-messaging frame. */
export function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(
      `native frame too large: ${payload.length} bytes (max ${MAX_FRAME_BYTES})`,
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Incremental decoder for native-messaging frames. Feed it arbitrary chunks;
 * each `push` returns the complete JSON messages contained in everything
 * received so far. Throws on an oversized length prefix (the caller should
 * treat that as a protocol violation and drop the connection).
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(chunk: Buffer): unknown[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    if (this.chunks.length === 0) return [];
    let buffer =
      this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;

    const messages: unknown[] = [];
    let offset = 0;
    for (;;) {
      const remaining = buffer.length - offset;
      if (remaining < 4) break;
      const length = buffer.readUInt32LE(offset);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(
          `native frame too large: ${length} bytes (max ${MAX_FRAME_BYTES})`,
        );
      }
      if (remaining < 4 + length) break;
      const payload = buffer.subarray(offset + 4, offset + 4 + length);
      messages.push(JSON.parse(payload.toString("utf8")));
      offset += 4 + length;
    }
    if (offset < buffer.length) {
      const rest = buffer.subarray(offset);
      this.chunks = [rest];
      this.buffered = rest.length;
    }
    return messages;
  }
}

/**
 * Incremental newline-delimited-JSON line splitter. Feed it arbitrary chunks;
 * each `push` returns every complete line (without the newline) that became
 * available. Throws when an unterminated line exceeds MAX_LINE_BYTES.
 */
export class LineDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(chunk: Buffer): string[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    if (this.chunks.length === 0) return [];
    const buffer =
      this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;

    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf(10, start);
      if (newline === -1) break;
      lines.push(buffer.toString("utf8", start, newline));
      start = newline + 1;
    }
    if (start < buffer.length) {
      const rest = buffer.subarray(start);
      if (rest.length > MAX_LINE_BYTES) {
        throw new Error(`hub line too large: ${rest.length} bytes (max ${MAX_LINE_BYTES})`);
      }
      this.chunks = [rest];
      this.buffered = rest.length;
    }
    return lines;
  }
}
