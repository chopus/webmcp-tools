/**
 * HTTP (streamable) MCP transport.
 *
 * Exposes the same MCP server (`createMcpServer(hub)`) over the MCP streamable
 * HTTP transport, in addition to stdio, so remote agents (ssh tunnel / proxy)
 * and a second simultaneous MCP client can connect. One hub, two transports:
 * tool calls from HTTP sessions reach the same connected browser as stdio.
 *
 * Every request must authenticate: `Authorization: Bearer <token>` (or
 * `?token=<token>` for curl ergonomics). The token comes from the caller
 * (`--http-token` / `WEBMCP_HTTP_TOKEN`) or is generated at startup — either
 * way it lands in a 0600 discovery file (`WEBMCP_HTTP_FILE`, default
 * `<tmpdir>/webmcp-tools-http.json`, same pattern as the hub discovery file)
 * so local same-user helpers can pick it up automatically while other local
 * users and stray scanners get a 401.
 *
 * Stateful sessions (like the SDK's streamable-http examples): every
 * `initialize` POST without a session id creates a fresh McpServer +
 * transport pair; the client echoes the returned `mcp-session-id` header on
 * every later request and ends the session with `DELETE /mcp`.
 */
import { randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

export const HTTP_FILE_NAME = "webmcp-tools-http.json";

/** Discovery file location: `$WEBMCP_HTTP_FILE` or `os.tmpdir()/webmcp-tools-http.json`. */
export function defaultHttpFilePath(): string {
  return process.env.WEBMCP_HTTP_FILE || path.join(os.tmpdir(), HTTP_FILE_NAME);
}

interface Session {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

export interface HttpServerOptions {
  /** TCP port to bind; 0 asks the OS for an ephemeral port. */
  port?: number;
  /** Bind address. Default `127.0.0.1` (local / tunneled use only). */
  hostname?: string;
  /** Explicit auth token (`--http-token` / `WEBMCP_HTTP_TOKEN`); generated when omitted. */
  token?: string;
  /** Where the `{ port, token }` discovery file is written. */
  tokenFile?: string;
}

export interface HttpServerHandle {
  server: ServerType;
  /** The actually bound port (useful when `port: 0` was requested). */
  port: number;
  /** The auth token every client must present (also in the discovery file). */
  token: string;
  /** Path of the `{ port, token }` discovery file (removed on close). */
  tokenFile: string;
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

/** Extract the presented token from a request (Bearer header or ?token=). */
function presentedToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  try {
    const url = new URL(req.url);
    const query = url.searchParams.get("token");
    if (query) return query;
  } catch {
    /* unreachable for served requests */
  }
  return null;
}

function unauthorized(): Response {
  // Name the fix, not just the failure (project error-ergonomics rule).
  return jsonRpcError(
    401,
    -32001,
    "Unauthorized: this server requires a bearer token. Send 'Authorization: Bearer <token>' " +
      "or append '?token=<token>'. The token is the value of --http-token/WEBMCP_HTTP_TOKEN, " +
      "or lives in the 0600 discovery file printed at startup (default <tmpdir>/" +
      HTTP_FILE_NAME +
      ").",
    { "WWW-Authenticate": "Bearer" },
  );
}

function buildApp(hub: HubApi, sessions: Map<string, Session>, token: string): Hono {
  const app = new Hono();

  app.use("/mcp", async (c: Context, next) => {
    if (presentedToken(c.req.raw) === token) return next();
    return unauthorized();
  });

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
 * (default `127.0.0.1:8930`; port 0 = ephemeral). Every request must
 * authenticate with the token (explicit or generated); `{ port, token }` is
 * written 0600 to the discovery file so local helpers can find it. Resolves
 * once the port is bound; all diagnostics go through the shared stderr
 * `log()` helper.
 */
export function startHttpServer(
  hub: HubApi,
  options: HttpServerOptions = {},
): Promise<HttpServerHandle> {
  const port = options.port ?? DEFAULT_HTTP_PORT;
  const hostname = options.hostname ?? "127.0.0.1";
  const token = options.token || randomBytes(32).toString("hex");
  const tokenFile = options.tokenFile ?? defaultHttpFilePath();
  const sessions = new Map<string, Session>();
  const app = buildApp(hub, sessions, token);

  return new Promise<HttpServerHandle>((resolve, reject) => {
    let settled = false;
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      try {
        writeFileSync(tokenFile, JSON.stringify({ port: info.port, token }), { mode: 0o600 });
      } catch (error) {
        server.once("error", () => undefined);
        server.close();
        if (!settled) {
          settled = true;
          reject(
            error instanceof Error
              ? error
              : new Error(`could not write http discovery file ${tokenFile}`),
          );
        }
        return;
      }
      const close = async (): Promise<void> => {
        try {
          rmSync(tokenFile, { force: true });
        } catch {
          // best effort
        }
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
      log(`http: auth required (Authorization: Bearer <token> or ?token=); token file: ${tokenFile}`);
      resolve({ server, port: info.port, token, tokenFile, close });
    });
    server.once("error", (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}
