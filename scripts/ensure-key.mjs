#!/usr/bin/env node
/**
 * Generates the repo-root key.pem if missing (RSA-2048) and prints info:
 *   {"keyPath": "...", "extensionId": "abcdefghijklmnop...", "manifestKey": "<base64 DER SPKI>"}
 *
 * The public half (DER SPKI, base64) goes into extension/manifest.json "key" field so
 * the unpacked extension has a deterministic ID; the ID is the first 16 bytes of
 * SHA-256(SPKI) hex-mapped a..p (same algorithm Chrome uses).
 *
 * key.pem lives at the REPO ROOT (not inside extension/) — Chrome warns when a
 * key file ships inside the extension directory. It is gitignored: installers
 * re-derive the ID at install time from the committed manifest "key" field.
 */
import { generateKeyPairSync, createHash } from "node:crypto";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = join(root, "key.pem");

let privPem;
if (existsSync(keyPath)) {
  privPem = readFileSync(keyPath, "utf8");
} else {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  privPem = privateKey;
  writeFileSync(keyPath, privPem, { mode: 0o600 });
}

// Extract DER SPKI from the private key's public half (for key.pem info only).
const { createPublicKey } = await import("node:crypto");
const privKey = await import("node:crypto").then((c) => c.createPrivateKey(privPem));

// The extension ID MUST come from the committed manifest "key" field (the
// base64 DER SPKI), NOT from key.pem: key.pem is gitignored, so a fresh clone
// would otherwise generate a new key, derive a different ID, and the installer
// would pin allowed_origins to an extension that does not exist. key.pem is
// only needed to pack a CRX later.
let manifestKey = null;
try {
  const manifest = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"));
  if (typeof manifest.key === "string" && manifest.key.length > 0) manifestKey = manifest.key;
} catch (e) { /* manifest unreadable — fall back to key.pem below */ }

let spkiDer;
if (manifestKey) {
  spkiDer = Buffer.from(manifestKey, "base64");
} else {
  console.error("warning: extension/manifest.json has no key field; deriving the id from key.pem instead (NOT stable across clones)");
  spkiDer = createPublicKey(privKey).export({ type: "spki", format: "der" });
}

const hash = createHash("sha256").update(spkiDer).digest("hex").slice(0, 32);
const extensionId = [...hash].map((h) => String.fromCharCode("a".charCodeAt(0) + parseInt(h, 16))).join("");

console.log(JSON.stringify({ keyPath, extensionId, manifestKey }, null, 2));
