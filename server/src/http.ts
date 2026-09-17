/**
 * HTTP (streamable) MCP transport.
 *
 * Exposes the same MCP server (`createMcpServer(hub)`) over the MCP streamable
 * HTTP transport, in addition to stdio, so remote agents (ssh tunnel / proxy)
 * and a second simultaneous MCP client can connect. One hub, two transports:
 * tool calls from HTTP sessions reach the same connected browser as stdio.
 *
 * Stateful sessions (like the SDK's streamable-http examples): every
 * `initialize` POST without a session id creates a fresh McpServer +
 * transport pair; the client echoes the returned `mcp-session-id` header on
 * every later request and ends the session with `DELETE /mcp`.
 */
import { randomUUID } from "node:crypto";
import { serve, type ServerType } from "@hono/node-server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Hono, type Context } from "hono";
import { DEFAULT_HTTP_PORT } from "./args.js";
import type { HubApi } from "./hub.js";
import { log } from "./log.js";
import { createMcpServer } from "./mcp/server.js";

const SESSION_ID_HEADER = "mcp-session-id";

interface Session {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

export interface HttpServerOptions {
  /** TCP port to bind; 0 asks the OS for an ephemeral port. */
  port?: number;
  /** Bind address. Default `127.0.0.1` (local / tunneled use only). */
  hostname?: string;
}

export interface HttpServerHandle {
  server: ServerType;
  /** The actually bound port (useful when `port: 0` was requested). */
  port: number;
  /** Close all MCP sessions and the HTTP server. */
  close(): Promise<void>;
}

/** JSON-RPC error body in the same shape the SDK transport itself uses. */
function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function createSession(hub: HubApi, sessions: Map<string, Session>): Promise<Session> {
  const server = createMcpServer(hub);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, entry);
      log(`http: MCP session ${sessionId} initialized`);
    },
    onsessionclosed: (sessionId) => {
      if (sessions.delete(sessionId)) {
        log(`http: MCP session ${sessionId} closed`);
      }
      void server.close().catch(() => undefined);
    },
  });
  transport.onerror = (error) => {
    log(`http: transport error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  };
  const entry: Session = { server, transport };
  await server.connect(transport);
  return entry;
}

function buildApp(hub: HubApi, sessions: Map<string, Session>): Hono {
  const app = new Hono();

  app.all("/mcp", async (c: Context): Promise<Response> => {
    const sessionId = c.req.header(SESSION_ID_HEADER);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !session) {
      return jsonRpcError(404, -32001, `Session not found: ${sessionId}`);
    }

    switch (c.req.method) {
      case "POST": {
        if (session) {
          return session.transport.handleRequest(c.req.raw);
        }
        // No session id yet: only an initialize request may start a session.
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return jsonRpcError(400, -32700, "Parse error: Invalid JSON");
        }
        if (!isInitializeRequest(body)) {
          return jsonRpcError(
            400,
            -32000,
            "Bad Request: Mcp-Session-Id header is required (initialize first)",
          );
        }
        const entry = await createSession(hub, sessions);
        return entry.transport.handleRequest(c.req.raw, { parsedBody: body });
      }
      case "GET": {
        // GET on a live session opens the server->client SSE stream; without a
        // session there is nothing to stream (this server never pushes first).
        if (!session) {
          return jsonRpcError(405, -32000, "Method Not Allowed: no active session", {
            Allow: "POST, DELETE",
          });
        }
        return session.transport.handleRequest(c.req.raw);
      }
      case "DELETE": {
        if (!session) {
          return jsonRpcError(405, -32000, "Method Not Allowed: no active session", {
            Allow: "POST",
          });
        }
        return session.transport.handleRequest(c.req.raw);
      }
      default:
        return jsonRpcError(405, -32000, `Method Not Allowed: ${c.req.method}`, {
          Allow: "GET, POST, DELETE",
        });
    }
  });

  return app;
}

/**
 * Start the streamable HTTP MCP transport for `hub` on `hostname:port`
 * (default `127.0.0.1:8930`; port 0 = ephemeral). Resolves once the port is
 * bound; all diagnostics go through the shared stderr `log()` helper.
 */
export function startHttpServer(
  hub: HubApi,
  options: HttpServerOptions = {},
): Promise<HttpServerHandle> {
  const port = options.port ?? DEFAULT_HTTP_PORT;
  const hostname = options.hostname ?? "127.0.0.1";
  const sessions = new Map<string, Session>();
  const app = buildApp(hub, sessions);

  return new Promise<HttpServerHandle>((resolve, reject) => {
    let settled = false;
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      const close = async (): Promise<void> => {
        for (const [id, entry] of sessions) {
          sessions.delete(id);
          await entry.transport.close().catch(() => undefined);
          await entry.server.close().catch(() => undefined);
        }
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
          // Drop lingering keep-alive sockets so close() always settles. (The
          // cast is safe: serve() only builds an HTTP/1.1 server here.)
          const httpServer = server as import("node:http").Server;
          httpServer.closeIdleConnections?.();
          httpServer.closeAllConnections?.();
        });
      };

      settled = true;
      log(`http: MCP streamable HTTP transport listening on http://${hostname}:${info.port}/mcp`);
      resolve({ server, port: info.port, close });
    });
    server.once("error", (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}
