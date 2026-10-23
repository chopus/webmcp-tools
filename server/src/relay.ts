import * as net from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { FrameDecoder, LineDecoder, encodeFrame } from "./framing.js";
import { defaultHubFilePath } from "./hub.js";
import { log } from "./log.js";

const RETRY_DELAY_MS = 500;
const CONNECT_TIMEOUT_MS = 1000;
const DRAIN_TIMEOUT_MS = 500;

/**
 * Total window a freshly spawned relay keeps hunting for the hub (file read +
 * connect attempts). Long enough that a hub restarting right after the old one
 * died is caught mid-hunt, which reconnects without any extension-side timer.
 */
export const HUNT_MS = 30_000;

/**
 * Pipe-keepalive signal to the extension service worker. Every frame the SW
 * receives resets Chrome's ~30 s MV3 idle timeout, so heartbeats keep the
 * worker (and its reconnect backoff chain) alive through hub outages, and let
 * it detect a half-dead port via native-port.js isResponsive().
 */
export const HEARTBEAT_MS = 10_000;

export type RelayPhase = "hunt" | "pump";

/**
 * Chrome-side frame sink (native messaging over stdout). `write` returns false
 * on backpressure exactly like a Node stream; consumers must then wait for
 * `onceDrain` before expecting further writes to be accepted. Tests inject a
 * controllable sink; production uses stdout.
 */
export interface FrameSink {
  write(frame: Buffer): boolean;
  onceDrain(listener: () => void): void;
}

export function stdoutSink(): FrameSink {
  return {
    write(frame) {
      try {
        return process.stdout.write(frame);
      } catch {
        return false;
      }
    },
    onceDrain(listener) {
      process.stdout.once("drain", listener);
    },
  };
}

export interface RelayOptions {
  huntMs?: number;
  heartbeatMs?: number;
  /** Frame sink (tests inject a collector); defaults to stdout. */
  sink?: FrameSink;
}

interface HubEndpoint {
  port: number;
  token: string;
}

function readHubFile(filePath: string): HubEndpoint | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      port?: unknown;
      token?: unknown;
    };
    if (typeof parsed.port === "number" && typeof parsed.token === "string") {
      return { port: parsed.port, token: parsed.token };
    }
  } catch {
    // missing or unreadable — retry
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryConnect(endpoint: HubEndpoint): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: endpoint.port });
    const settled = { done: false };
    const finish = (value: net.Socket | null) => {
      if (settled.done) return;
      settled.done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(null);
    }, CONNECT_TIMEOUT_MS);
    socket.once("error", () => {
      socket.destroy();
      finish(null);
    });
    socket.once("connect", () => {
      socket.setNoDelay(true);
      finish(socket);
    });
  });
}

export interface Heartbeat {
  stop(): void;
  setPhase(phase: RelayPhase): void;
}

/** Emit relayHeartbeat frames until stopped. Never throws into the caller. */
export function startHeartbeat(opts: RelayOptions = {}): Heartbeat {
  const interval = opts.heartbeatMs ?? HEARTBEAT_MS;
  const sink = opts.sink ?? stdoutSink();
  let phase: RelayPhase = "hunt";
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    sink.write(encodeFrame({ v: 1, kind: "event", event: "relayHeartbeat", data: { phase } }));
  }, interval);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    setPhase(next: RelayPhase) {
      phase = next;
    },
  };
}

export type RelayOutcome = "pumped" | "hub-not-found";

/**
 * Relay main loop without process.exit (so tests can drive it): bridge Chrome
 * native-messaging frames on stdio to NDJSON lines on the hub TCP socket.
 * Transparent — payloads are forwarded verbatim (parsed + re-serialized so
 * every frame/line carries exactly one JSON object). Resolves when either
 * side closes or the hunt window passes without a hub.
 */
export async function relayMain(
  hubFilePath: string = defaultHubFilePath(),
  opts: RelayOptions = {},
): Promise<RelayOutcome> {
  const huntMs = opts.huntMs ?? HUNT_MS;
  const heartbeat = startHeartbeat(opts);
  const deadline = Date.now() + huntMs;
  while (Date.now() < deadline) {
    const endpoint = readHubFile(hubFilePath);
    if (endpoint) {
      const socket = await tryConnect(endpoint);
      if (socket) {
        log(`relay: connected to hub on 127.0.0.1:${endpoint.port}`);
        heartbeat.setPhase("pump");
        await pump(socket, endpoint, opts);
        heartbeat.stop();
        await drainStdout();
        return "pumped";
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // Sleep out short remainders too: staying alive for the whole window is
    // the point — heartbeats keep the extension's service worker alive.
    await sleep(Math.min(RETRY_DELAY_MS, remaining));
  }
  heartbeat.stop();
  return "hub-not-found";
}

/**
 * Relay mode entry point. Always exits 0: Chrome respawns the host when the
 * extension retries connectNative().
 */
export async function runRelay(hubFilePath: string = defaultHubFilePath()): Promise<void> {
  await relayMain(hubFilePath);
  process.exit(0);
}

function pump(socket: net.Socket, endpoint: HubEndpoint, opts: RelayOptions): Promise<void> {
  const sink = opts.sink ?? stdoutSink();
  return new Promise((resolve) => {
    const stdinDecoder = new FrameDecoder();
    const socketDecoder = new LineDecoder();
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      try {
        process.stdin.pause();
        process.stdin.removeAllListeners("data");
        process.stdin.removeAllListeners("end");
        process.stdin.removeAllListeners("error");
      } catch {
        // ignore
      }
      resolve();
    };

    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);

    // Handshake: relay must present the token as its first message.
    socket.write(JSON.stringify({ v: 1, kind: "hello", who: "relay", token: endpoint.token }) + "\n");

    socket.on("data", (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = socketDecoder.push(chunk);
      } catch (error) {
        log(`relay: hub protocol error: ${error instanceof Error ? error.message : String(error)}`);
        finish();
        return;
      }
      for (const line of lines) {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          log("relay: ignoring non-JSON hub line");
          continue;
        }
        const ok = sink.write(encodeFrame(message));
        if (!ok) {
          // Chrome is not keeping up: stop reading the hub until the Chrome
          // side drains (NOT the socket's own drain — that is the opposite
          // direction and would wedge the pipe permanently).
          socket.pause();
          sink.onceDrain(() => socket.resume());
        }
      }
    });
    socket.on("error", (error: Error) => {
      log(`relay: hub socket error: ${error.message}`);
      finish();
    });
    socket.on("close", () => finish());

    process.stdin.on("data", (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = stdinDecoder.push(chunk);
      } catch (error) {
        log(
          `relay: bad native frame from Chrome: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        finish();
        return;
      }
      for (const message of messages) {
        const ok = socket.write(JSON.stringify(message) + "\n");
        if (!ok) {
          process.stdin.pause();
          socket.once("drain", () => process.stdin.resume());
        }
      }
    });
    process.stdin.on("end", () => finish());
    process.stdin.on("error", () => finish());
    process.stdout.on("error", () => finish());
    process.stdin.resume();
  });
}

/** Give pending stdout writes a moment to flush before process.exit(). */
async function drainStdout(): Promise<void> {
  const stdout = process.stdout;
  if (!stdout.writableLength) return;
  await Promise.race([once(stdout, "drain"), sleep(DRAIN_TIMEOUT_MS)]);
}
