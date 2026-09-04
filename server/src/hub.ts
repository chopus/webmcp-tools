import * as net from "node:net";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LineDecoder } from "./framing.js";
import { log } from "./log.js";

export const HUB_FILE_NAME = "webmcp-tools-hub.json";

/** Discovery file location: `$WEBMCP_HUB_FILE` or `os.tmpdir()/webmcp-tools-hub.json`. */
export function defaultHubFilePath(): string {
  return process.env.WEBMCP_HUB_FILE || path.join(os.tmpdir(), HUB_FILE_NAME);
}

export class HubError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "HubError";
    this.code = code;
  }
}

export interface ExtensionInfo {
  chromeVersion?: string;
  userAgent?: string;
  platform?: string;
  extensionVersion?: string;
}

export interface ExtensionInstance extends ExtensionInfo {
  instanceId: string;
}

/** The slice of the hub that the MCP layer is allowed to touch. */
export interface HubApi {
  request(
    tool: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    instanceId?: string,
  ): Promise<unknown>;
  /** All connected browser instances (most recent last). */
  listInstances(): ExtensionInstance[];
  /** Instance that tool calls target when no `instanceId` is given. */
  activeInstanceId: string | null;
}

export interface HubOptions {
  filePath?: string;
  log?: (message: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: HubError) => void;
  timer: NodeJS.Timeout;
  socket: net.Socket;
  tool: string;
}

interface SocketState {
  socket: net.Socket;
  authenticated: boolean;
  decoder: LineDecoder;
  /** Synthetic (`conn-N`) until the extension's hello provides a real one. */
  instanceId: string;
}

interface InstanceEntry {
  socket: net.Socket;
  info: ExtensionInfo;
}

/**
 * TCP hub: listens on 127.0.0.1 (ephemeral port), authenticates native relays
 * via a token in the discovery file, tracks connected extension instances
 * (one per browser/profile — several may coexist), and routes request/response
 * envelopes by id. Knows nothing about MCP.
 */
export class Hub implements HubApi {
  readonly filePath: string;
  readonly token: string;
  port = 0;
  private connCounter = 0;
  private activeId: string | null = null;

  get extensionConnected(): boolean {
    return this.instances.size > 0;
  }

  get extensionInfo(): ExtensionInfo {
    const entry = this.activeEntry();
    return entry ? entry.info : {};
  }

  get activeInstanceId(): string | null {
    return this.activeId;
  }

  private server: net.Server | null = null;
  private readonly sockets = new Map<net.Socket, SocketState>();
  private readonly instances = new Map<string, InstanceEntry>();
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly logFn: (message: string) => void;
  private closed = false;

  constructor(options: HubOptions = {}) {
    this.filePath = options.filePath ?? defaultHubFilePath();
    this.token = randomBytes(32).toString("hex");
    this.logFn = options.log ?? log;
  }

  /** Bind 127.0.0.1:0 and write the `{ port, token }` discovery file. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.once("error", (error) => reject(error));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address == null || typeof address === "string") {
          server.close();
          reject(new Error("hub: could not determine listen port"));
          return;
        }
        this.port = address.port;
        this.server = server;
        try {
          writeFileSync(this.filePath, JSON.stringify({ port: this.port, token: this.token }), {
            mode: 0o600,
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.logFn(`hub listening on 127.0.0.1:${this.port} (discovery file: ${this.filePath})`);
        resolve(this.port);
      });
    });
  }

  request(
    tool: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30000,
    instanceId?: string,
  ): Promise<unknown> {
    let entry = instanceId ? this.instances.get(instanceId) : this.activeEntry();
    if (!entry && !instanceId && this.instances.size > 0) {
      // Default target vanished (e.g. mid-call disconnect): fall back to the
      // most recently connected instance rather than failing outright.
      const last = [...this.instances.entries()].pop();
      entry = last ? last[1] : undefined;
    }
    if (!entry || entry.socket.destroyed) {
      return Promise.reject(
        new HubError(
          "the WebMCP Tools Chrome extension is not connected",
          "extension_not_connected",
        ),
      );
    }
    const socket = entry.socket;
    const id = this.nextId++;
    const envelope = { v: 1, kind: "request" as const, id, tool, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop the pending entry so a late response is ignored.
        this.pending.delete(id);
        reject(new HubError(`tool "${tool}" timed out after ${timeoutMs}ms`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, socket, tool });
      socket.write(JSON.stringify(envelope) + "\n");
    });
  }

  /** Clean shutdown: delete discovery file, reject pending, destroy sockets. */
  async close(): Promise<void> {
    this.teardown();
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  /** Best-effort synchronous shutdown (safe from a process "exit" hook). */
  closeSync(): void {
    this.teardown();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // best effort
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(
        new HubError(
          `pending tool "${pending.tool}" rejected: extension disconnected`,
          "extension_disconnected",
        ),
      );
    }
    for (const [socket] of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.instances.clear();
    this.activeId = null;
  }

  private handleConnection(socket: net.Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    const state: SocketState = {
      socket,
      authenticated: false,
      decoder: new LineDecoder(),
      instanceId: "",
    };
    this.sockets.set(socket, state);

    socket.on("data", (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = state.decoder.push(chunk);
      } catch (error) {
        this.logFn(
          `hub: dropping connection after protocol error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        socket.destroy();
        return;
      }
      for (const line of lines) {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.logFn("hub: ignoring non-JSON line");
          continue;
        }
        try {
          this.handleMessage(state, message);
        } catch (error) {
          this.logFn(
            `hub: error while handling message: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    });
    socket.on("error", () => {
      // "close" always follows.
    });
    socket.on("close", () => this.handleClose(socket));
  }

  private handleClose(socket: net.Socket): void {
    this.sockets.delete(socket);
    let removedId: string | null = null;
    for (const [id, entry] of this.instances) {
      if (entry.socket === socket) {
        this.instances.delete(id);
        removedId = id;
      }
    }
    if (removedId != null) {
      this.logFn(`hub: instance ${removedId} disconnected`);
      if (this.activeId === removedId) {
        const last = [...this.instances.keys()].pop();
        this.activeId = last ?? null;
        if (this.activeId != null) {
          this.logFn(`hub: active instance is now ${this.activeId}`);
        }
      }
    }
    for (const [id, pending] of this.pending) {
      if (pending.socket === socket) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(
          new HubError(
            `pending tool "${pending.tool}" rejected: extension disconnected`,
            "extension_disconnected",
          ),
        );
      }
    }
  }

  private handleMessage(state: SocketState, message: Record<string, unknown>): void {
    const socket = state.socket;
    if (message.v !== 1) {
      socket.destroy();
      return;
    }

    if (!state.authenticated) {
      const tokenOk =
        message.kind === "hello" &&
        message.who === "relay" &&
        typeof message.token === "string" &&
        message.token === this.token;
      if (tokenOk) {
        state.authenticated = true;
        state.instanceId = `conn-${++this.connCounter}`;
        this.registerInstance(state, state.instanceId, {});
        socket.write(JSON.stringify({ v: 1, kind: "hello", who: "hub" }) + "\n");
        this.logFn("hub: relay authenticated");
      } else {
        this.logFn("hub: rejecting connection with invalid handshake");
        socket.destroy();
      }
      return;
    }

    if (message.kind === "response") {
      const id = message.id;
      if (typeof id !== "number") return; // malformed
      const pending = this.pending.get(id);
      if (!pending || pending.socket !== socket) return; // late or foreign response
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.ok === true) {
        pending.resolve(message.result);
      } else {
        const error = (message.error ?? {}) as { message?: unknown; code?: unknown };
        pending.reject(
          new HubError(
            typeof error.message === "string" ? error.message : "extension reported an error",
            typeof error.code === "string" ? error.code : "EUNKNOWN",
          ),
        );
      }
      return;
    }

    if (message.kind === "event" && message.event === "extensionHello") {
      const data = (message.data ?? {}) as Record<string, unknown>;
      const info: ExtensionInfo = {
        chromeVersion: str(data.chromeVersion),
        userAgent: str(data.userAgent),
        platform: str(data.platform),
        extensionVersion: str(data.extensionVersion),
      };
      const realId = str(data.instanceId);
      this.registerInstance(state, realId && realId !== state.instanceId ? realId : state.instanceId, info);
      this.logFn(
        `hub: extension ${state.instanceId} connected (extensionVersion=${
          info.extensionVersion ?? "?"
        }, chrome=${info.chromeVersion ?? "?"})`,
      );
      return;
    }
    // Unknown event kinds are ignored.
  }

  /**
   * Register a connection under an instance id. Same id from a new socket means
   * the extension reconnected (stale socket is dropped); different ids coexist
   * (multiple browsers/profiles). The most recent registration becomes the
   * default target for tool calls without an explicit instanceId.
   */
  private registerInstance(state: SocketState, instanceId: string, info: ExtensionInfo): void {
    for (const [id, entry] of this.instances) {
      if (entry.socket === state.socket) this.instances.delete(id);
    }
    const existing = this.instances.get(instanceId);
    if (existing && existing.socket !== state.socket && !existing.socket.destroyed) {
      this.logFn(`hub: instance ${instanceId} reconnected; closing previous connection`);
      existing.socket.destroy();
    }
    this.instances.set(instanceId, { socket: state.socket, info });
    state.instanceId = instanceId;
    this.activeId = instanceId;
  }

  private activeEntry(): InstanceEntry | undefined {
    if (this.activeId) {
      const entry = this.instances.get(this.activeId);
      if (entry && !entry.socket.destroyed) return entry;
    }
    const entries = Array.from(this.instances.entries()).filter(([, e]) => !e.socket.destroyed);
    return entries.length > 0 ? entries[entries.length - 1][1] : undefined;
  }

  listInstances(): ExtensionInstance[] {
    return [...this.instances.entries()].map(([instanceId, entry]) => ({
      instanceId,
      ...entry.info,
    }));
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
