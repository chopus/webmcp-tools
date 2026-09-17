import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { HubApi } from "../src/hub.js";
import { startHttpServer, type HttpServerHandle } from "../src/http.js";
import { TOOL_NAMES } from "../src/mcp/server.js";

const ACCEPT = "application/json, text/event-stream";

function stubHub(): HubApi {
  return {
    request: async () => ({}),
    listInstances: () => [],
    activeInstanceId: null,
  };
}

/** POST one JSON-RPC message to /mcp, optionally on an existing session. */
function postRpc(
  url: string,
  method: string,
  id: number | null,
  params?: unknown,
  sessionId?: string,
): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: ACCEPT,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }),
  });
}

/**
 * Read a JSON or SSE body and return every JSON-RPC message it carries.
 * POST SSE streams close after the response is written, so text() resolves.
 */
async function readMessages(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [parsed as Record<string, unknown>];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length).trim()) as Record<string, unknown>);
}

let handle: HttpServerHandle;
let baseUrl: string;

beforeAll(async () => {
  handle = await startHttpServer(stubHub(), { port: 0 });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.close();
});

describe("HTTP (streamable) MCP transport", () => {
  it("initialize returns 200 with a session id and server info", async () => {
    const res = await postRpc(baseUrl, "initialize", 1, {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.0" },
    });
    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    const messages = await readMessages(res);
    const result = messages.find((m) => m.id === 1)?.result as
      | { serverInfo?: { name?: string } }
      | undefined;
    expect(result?.serverInfo?.name).toBe("webmcp-browser");
  });

  it("tools/list on the same session exposes the tool catalog", async () => {
    const init = await postRpc(baseUrl, "initialize", 1, {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.0" },
    });
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await readMessages(init); // drain so the connection is reusable

    const res = await postRpc(baseUrl, "tools/list", 2, undefined, sessionId!);
    expect(res.status).toBe(200);
    const messages = await readMessages(res);
    const result = messages.find((m) => m.id === 2)?.result as
      | { tools?: Array<{ name: string }> }
      | undefined;
    const names = (result?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("navigate");
    expect(names).toContain("get_browser_info");
    expect([...names].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("DELETE terminates the session; later POSTs are rejected", async () => {
    const init = await postRpc(baseUrl, "initialize", 1, {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.0" },
    });
    const sessionId = init.headers.get("mcp-session-id");
    await readMessages(init);

    const deleted = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(deleted.status).toBe(200);

    const res = await postRpc(baseUrl, "tools/list", 3, undefined, sessionId!);
    expect(res.status).toBe(404);
    await res.arrayBuffer(); // drain error body
  });

  it("POST without a session id (and not initialize) is a 400", async () => {
    const res = await postRpc(baseUrl, "tools/list", 1);
    expect(res.status).toBe(400);
    await res.arrayBuffer();
  });

  it("GET without an active session is a 405", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { headers: { accept: ACCEPT } });
    expect(res.status).toBe(405);
    await res.arrayBuffer();
  });

  it("unsupported methods get 405", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(405);
    await res.arrayBuffer();
  });
});
