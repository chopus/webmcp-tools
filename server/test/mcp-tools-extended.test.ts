import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { setAuditDir } from "../src/audit.js";
import { HubError, type HubApi } from "../src/hub.js";
import { textOf, withMcpClient } from "./helpers.js";

function fakeHub(result: Record<string, unknown> = {}): HubApi & { request: Mock } {
  return {
    request: vi.fn(async () => result),
    listInstances: () => [],
    activeInstanceId: null,
  };
}

/** Call a tool and expect success; returns nothing (use hub.request mock for params). */
async function expectOk(hub: HubApi, name: string, args: Record<string, unknown>): Promise<void> {
  await withMcpClient(hub, async (client) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, textOf(response.content!)).toBeFalsy();
  });
}

/** Call a tool and expect an EARGS error whose text contains `message`. */
async function expectEargs(hub: HubApi, name: string, args: Record<string, unknown>, message: string): Promise<void> {
  await withMcpClient(hub, async (client) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, name).toBe(true);
    const text = textOf(response.content!);
    expect(text, name).toMatch(/EARGS/);
    expect(text, name).toContain(message);
  });
}

describe("click targeting (ref / selector / x-y position)", () => {
  it("ref alone is ok", async () => {
    const hub = fakeHub({ clicked: true });
    await expectOk(hub, "click", { tabId: 1, ref: 3 });
    expect((hub.request as Mock).mock.calls[0][1]).toMatchObject({ ref: 3 });
  });

  it("x + y position is ok and forwarded", async () => {
    const hub = fakeHub({ clicked: true });
    await expectOk(hub, "click", { tabId: 1, x: 120, y: 45 });
    const params = (hub.request as Mock).mock.calls[0][1] as Record<string, unknown>;
    expect(params.x).toBe(120);
    expect(params.y).toBe(45);
    expect(params.ref).toBeUndefined();
    expect(params.selector).toBeUndefined();
  });

  it("x without y is EARGS", async () => {
    await expectEargs(fakeHub(), "click", { tabId: 1, x: 5 }, "click: x and y must be provided together");
    await expectEargs(fakeHub(), "click", { tabId: 1, y: 5 }, "click: x and y must be provided together");
  });

  it("x/y combined with ref or selector is EARGS", async () => {
    await expectEargs(fakeHub(), "click", { tabId: 1, x: 5, y: 5, selector: "#a" }, "click: provide one of ref, selector, or x/y position");
    await expectEargs(fakeHub(), "click", { tabId: 1, x: 5, y: 5, ref: 2 }, "click: provide one of ref, selector, or x/y position");
  });

  it("no targeting at all is EARGS", async () => {
    await expectEargs(fakeHub(), "click", { tabId: 1 }, 'exactly one of "ref", "selector", or "x"/"y"');
  });
});

describe("wait_for (text / selector / networkIdle)", () => {
  it("networkIdle alone is ok", async () => {
    const hub = fakeHub({ found: true, matched: "networkIdle" });
    await expectOk(hub, "wait_for", { tabId: 4, networkIdle: true });
    expect((hub.request as Mock).mock.calls[0][1]).toMatchObject({ networkIdle: true });
  });

  it("networkIdle with idleMs is ok", async () => {
    await expectOk(fakeHub(), "wait_for", { tabId: 4, networkIdle: true, idleMs: 1000 });
  });

  it("selector with state is ok", async () => {
    await expectOk(fakeHub(), "wait_for", { tabId: 4, selector: "#result", state: "visible" });
  });

  it("the idleMs default does not trip validation when absent", async () => {
    await expectOk(fakeHub(), "wait_for", { tabId: 4, text: "hello" });
    await expectOk(fakeHub(), "wait_for", { tabId: 4, selector: "#result" });
  });

  it("state without selector is EARGS", async () => {
    await expectEargs(fakeHub(), "wait_for", { tabId: 4, text: "hi", state: "visible" }, 'wait_for: "state" requires "selector"');
    await expectEargs(fakeHub(), "wait_for", { tabId: 4, networkIdle: true, state: "hidden" }, 'wait_for: "state" requires "selector"');
  });

  it("text plus selector is still EARGS", async () => {
    await expectEargs(fakeHub(), "wait_for", { tabId: 4, text: "hi", selector: "#x" }, "exactly one of");
  });

  it("idleMs without networkIdle is EARGS", async () => {
    await expectEargs(fakeHub(), "wait_for", { tabId: 4, text: "hi", idleMs: 1000 }, 'wait_for: "idleMs" requires "networkIdle"');
    await expectEargs(fakeHub(), "wait_for", { tabId: 4, networkIdle: false, idleMs: 1000 }, 'wait_for: "idleMs" requires "networkIdle"');
  });

  it("no condition at all is EARGS", async () => {
    await expectEargs(fakeHub(), "wait_for", { tabId: 4 }, "exactly one of");
  });
});

describe("upload_file (selector or ref)", () => {
  it("selector alone is ok", async () => {
    const hub = fakeHub({ uploaded: true });
    await expectOk(hub, "upload_file", { tabId: 2, selector: "input[type=file]", path: "/tmp/a.pdf" });
    expect((hub.request as Mock).mock.calls[0][1]).toMatchObject({ selector: "input[type=file]", path: "/tmp/a.pdf" });
  });

  it("ref alone is ok", async () => {
    await expectOk(fakeHub(), "upload_file", { tabId: 2, ref: 5, path: "/tmp/a.pdf" });
  });

  it("both selector and ref is EARGS", async () => {
    await expectEargs(fakeHub(), "upload_file", { tabId: 2, selector: "input", ref: 5, path: "/tmp/a.pdf" }, "exactly one of");
  });

  it("neither selector nor ref is EARGS", async () => {
    await expectEargs(fakeHub(), "upload_file", { tabId: 2, path: "/tmp/a.pdf" }, "exactly one of");
  });

  it("missing path is rejected by schema validation", async () => {
    await withMcpClient(fakeHub(), async (client) => {
      const response = await client.callTool({ name: "upload_file", arguments: { tabId: 2, selector: "input" } });
      expect(response.isError).toBe(true);
      expect(textOf(response.content!)).toMatch(/invalid arguments|required|path/i);
    });
  });
});

describe("set_origin_policy shape", () => {
  it("missing policy is rejected", async () => {
    await withMcpClient(fakeHub({}), async (client) => {
      const response = await client.callTool({ name: "set_origin_policy", arguments: {} });
      expect(response.isError).toBe(true);
      expect(textOf(response.content!)).toMatch(/invalid arguments|required|policy/i);
    });
  });

  it("invalid mode is rejected", async () => {
    await withMcpClient(fakeHub({}), async (client) => {
      const response = await client.callTool({ name: "set_origin_policy", arguments: { policy: { mode: "nope" } } });
      expect(response.isError).toBe(true);
      expect(textOf(response.content!)).toMatch(/invalid arguments|allowlist|denylist/i);
    });
  });

  it("a valid partial policy is forwarded as-is", async () => {
    const hub = fakeHub({ ok: true });
    await expectOk(hub, "set_origin_policy", {
      policy: { mode: "denylist", denylist: ["*.evil.com"], requireConfirmOnSubmit: true },
    });
    expect((hub.request as Mock).mock.calls[0][1]).toEqual({
      policy: { mode: "denylist", denylist: ["*.evil.com"], requireConfirmOnSubmit: true },
    });
  });
});

describe("audit log", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "webmcp-audit-"));
    setAuditDir(dir);
  });

  afterEach(() => {
    setAuditDir(null);
    rmSync(dir, { recursive: true, force: true });
  });

  function readAuditFile(): string {
    const files = readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
    expect(files).toHaveLength(1);
    return readFileSync(path.join(dir, files[0]), "utf8");
  }

  function readAuditEntries(): Record<string, unknown>[] {
    const raw = readAuditFile();
    expect(raw.endsWith("\n")).toBe(true);
    return raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("writes one NDJSON line per successful call (metadata only)", async () => {
    const hub = fakeHub({ tabId: 7, url: "https://example.com/page", title: "Example" });
    await withMcpClient(hub, async (client) => {
      const response = await client.callTool({
        name: "navigate",
        arguments: { tabId: 7, url: "https://example.com/page", instanceId: "inst-42" },
      });
      expect(response.isError).toBeFalsy();
    });
    const entries = readAuditEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.tool).toBe("navigate");
    expect(entry.ok).toBe(true);
    expect(entry.tabId).toBe(7);
    expect(entry.url).toBe("https://example.com/page");
    expect(entry.instanceId).toBe("inst-42");
    expect(typeof entry.ts).toBe("string");
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(entry.ts as string).toString()).not.toBe("Invalid Date");
    expect(typeof entry.durationMs).toBe("number");
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    // Only the whitelisted audit fields — nothing else.
    expect(Object.keys(entry).sort()).toEqual(["durationMs", "instanceId", "ok", "tabId", "tool", "ts", "url"]);
  });

  it("records hub failures with errorCode", async () => {
    const hub: HubApi & { request: Mock } = {
      request: vi.fn(async () => {
        throw new HubError("no such tab", "ETAB_NOT_FOUND");
      }),
      listInstances: () => [],
      activeInstanceId: null,
    };
    await withMcpClient(hub, async (client) => {
      const response = await client.callTool({ name: "get_dialog", arguments: { tabId: 3 } });
      expect(response.isError).toBe(true);
    });
    const entries = readAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tool: "get_dialog",
      ok: false,
      errorCode: "ETAB_NOT_FOUND",
      tabId: 3,
      url: null,
      instanceId: null,
    });
  });

  it("records EARGS validation failures without calling the hub", async () => {
    const hub = fakeHub({});
    await withMcpClient(hub, async (client) => {
      const response = await client.callTool({ name: "click", arguments: { tabId: 1, x: 5 } });
      expect(response.isError).toBe(true);
    });
    const entries = readAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].ok).toBe(false);
    expect(entries[0].errorCode).toBe("EARGS");
    expect((hub.request as Mock)).not.toHaveBeenCalled();
  });

  it("never logs typed text, selectors or params", async () => {
    await withMcpClient(fakeHub({ typed: true }), async (client) => {
      const response = await client.callTool({
        name: "type_text",
        arguments: { tabId: 2, selector: "#login-password", text: "SECRET-PASSWORD-XYZ" },
      });
      expect(response.isError).toBeFalsy();
    });
    const raw = readAuditFile();
    expect(raw).not.toContain("SECRET-PASSWORD-XYZ");
    expect(raw).not.toContain("#login-password");
  });

  it("audit failures never fail the tool call", async () => {
    // A regular file where a directory is needed: every write must be swallowed.
    const blocker = path.join(dir, "blocker.txt");
    writeFileSync(blocker, "x");
    setAuditDir(path.join(blocker, "audit"));
    await withMcpClient(fakeHub({ downloads: [] }), async (client) => {
      const response = await client.callTool({
        name: "list_downloads",
        arguments: {},
      });
      expect(response.isError).toBeFalsy();
    });
  });
});
