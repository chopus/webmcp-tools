#!/usr/bin/env node
/**
 * Generates extension/icons/icon16|32|48|128.png — dependency-free PNG writer.
 * Simple, legible mark: indigo rounded square + white "tool plug" glyph (blocky).
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "extension", "icons");
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const px = new Uint8Array(size * size * 4);
  const r = size * 0.22; // corner radius
  const set = (x, y, [R, G, B, A]) => {
    const i = (y * size + x) * 4;
    px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = A;
  };
  // inside-rounded-square test
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - 1 - r);
    const cy = Math.min(Math.max(y, r), size - 1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // glyph: white "plug": vertical stem + two prongs, in unit coords scaled to size
  const S = (v) => Math.round(v * size);
  const glyph = (x, y) => {
    const u = x / size, v = y / size;
    const stem = u >= 0.42 && u <= 0.58 && v >= 0.30 && v <= 0.86;
    const prongL = u >= 0.22 && u <= 0.34 && v >= 0.30 && v <= 0.52;
    const prongR = u >= 0.66 && u <= 0.78 && v >= 0.30 && v <= 0.52;
    const base = u >= 0.28 && u <= 0.72 && v >= 0.70 && v <= 0.86;
    return stem || prongL || prongR || base;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inside(x, y)) continue;
      // subtle vertical gradient indigo
      const t = y / size;
      const col = glyph(x, y)
        ? [255, 255, 255, 255]
        : [Math.round(79 - t * 18), Math.round(70 - t * 16), Math.round(229 - t * 10), 255];
      set(x, y, col);
    }
  }
  const raw = Buffer.from(px);
  const stride = size * 4;
  const scanlines = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    scanlines[y * (stride + 1)] = 0; // filter: none
    raw.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const s of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon${s}.png`), png(s));
  console.log(`wrote extension/icons/icon${s}.png`);
}
