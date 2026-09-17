import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Best-effort local audit trail of tool invocations. One NDJSON line per call,
 * never containing typed text, values, cookie contents or full params — only
 * the fields of {@link AuditEntry}. Failures are swallowed: logging must never
 * fail a tool call.
 */
export interface AuditEntry {
  /** ISO timestamp. */
  ts: string;
  tool: string;
  instanceId: string | null;
  tabId: number | null;
  url: string | null;
  ok: boolean;
  errorCode?: string;
  durationMs: number;
}

/** Explicit override for the audit directory (used by tests). `null` restores the default. */
let auditDirOverride: string | null = null;

/** Point the audit log at a specific directory; pass `null` to restore the default. */
export function setAuditDir(dir: string | null): void {
  auditDirOverride = dir;
}

/** Resolve the audit directory: override → `$WEBMCP_AUDIT_DIR` → `<repo>/reports/audit`. */
export function auditDir(): string {
  if (auditDirOverride) return auditDirOverride;
  const fromEnv = process.env.WEBMCP_AUDIT_DIR;
  if (fromEnv) return fromEnv;
  try {
    // dist/audit.js (or src/audit.ts under vitest) -> <repo>/reports/audit
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "reports", "audit");
  } catch {
    return "reports/audit";
  }
}

/**
 * Append one audit line to `<auditDir>/audit-YYYY-MM-DD.ndjson` (day taken from
 * `entry.ts`). Best-effort and synchronous: any error is swallowed.
 */
export function writeAudit(entry: AuditEntry): void {
  try {
    const dir = auditDir();
    mkdirSync(dir, { recursive: true });
    const day = entry.ts.slice(0, 10); // ISO "YYYY-MM-DD..."
    appendFileSync(path.join(dir, `audit-${day}.ndjson`), JSON.stringify(entry) + "\n");
  } catch {
    // Never let audit failures break a tool call.
  }
}
