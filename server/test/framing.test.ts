import { describe, expect, it } from "vitest";
import { FrameDecoder, LineDecoder, MAX_FRAME_BYTES, encodeFrame } from "../src/framing.js";

describe("native messaging framing", () => {
  it("round-trips a message through encode + decode", () => {
    const message = { v: 1, kind: "response", id: 7, ok: true, result: { url: "https://x/", title: "Hi" } };
    const decoder = new FrameDecoder();
    const out = decoder.push(encodeFrame(message));
    expect(out).toEqual([message]);
  });

  it("handles chunked delivery (frame split across many reads)", () => {
    const first = { v: 1, kind: "hello", who: "relay", token: "deadbeef" };
    const second = { v: 1, kind: "response", id: 2, ok: false, error: { message: "no", code: "ETIMEOUT" } };
    const wire = Buffer.concat([encodeFrame(first), encodeFrame(second)]);

    const decoder = new FrameDecoder();
    const collected: unknown[] = [];
    // Feed 3 bytes at a time to split frames at arbitrary boundaries.
    for (let offset = 0; offset < wire.length; offset += 3) {
      collected.push(...decoder.push(wire.subarray(offset, Math.min(offset + 3, wire.length))));
    }
    expect(collected).toEqual([first, second]);
  });

  it("handles chunked delivery byte-by-byte", () => {
    const message = { hello: "world", n: 12345 };
    const wire = encodeFrame(message);
    const decoder = new FrameDecoder();
    const collected: unknown[] = [];
    for (const byte of wire) {
      collected.push(...decoder.push(Buffer.from([byte])));
    }
    expect(collected).toEqual([message]);
  });

  it("returns two frames delivered in a single chunk at once", () => {
    const a = { n: 1 };
    const b = { n: 2, nested: { deep: [1, 2, 3] } };
    const decoder = new FrameDecoder();
    const out = decoder.push(Buffer.concat([encodeFrame(a), encodeFrame(b)]));
    expect(out).toEqual([a, b]);
  });

  it("rejects an oversized frame", () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    expect(() => decoder.push(header)).toThrow(/too large/);
  });

  it("encodes a little-endian 32-bit length prefix", () => {
    const payload = Buffer.from("{}", "utf8");
    const frame = encodeFrame({});
    expect(frame.length).toBe(4 + payload.length);
    expect(frame.readUInt32LE(0)).toBe(payload.length);
    expect(frame.subarray(4).toString("utf8")).toBe("{}");
  });

  it("rejects encoding of a frame above the cap", () => {
    const huge = "x".repeat(MAX_FRAME_BYTES + 1);
    expect(() => encodeFrame({ huge })).toThrow(/too large/);
  });
});

describe("NDJSON line decoding", () => {
  it("splits complete lines and buffers partial ones", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(Buffer.from('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
    expect(decoder.push(Buffer.from(':2}\n'))).toEqual(['{"b":2}']);
  });

  it("tolerates \\r\\n line endings (JSON.parse still succeeds)", () => {
    const decoder = new LineDecoder();
    const lines = decoder.push(Buffer.from('{"a":1}\r\n{"b":2}\r\n'));
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles a line split mid multi-byte UTF-8 sequence", () => {
    const text = JSON.stringify({ text: "héllo wörld ✓ 😀" });
    const wire = Buffer.from(`${text}\n`, "utf8");
    const decoder = new LineDecoder();
    const collected: string[] = [];
    for (const byte of wire) {
      collected.push(...decoder.push(Buffer.from([byte])));
    }
    expect(collected).toEqual([text]);
  });
});
