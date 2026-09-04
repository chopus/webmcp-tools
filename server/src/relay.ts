import * as net from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { FrameDecoder, LineDecoder, encodeFrame } from "./framing.js";
import { defaultHubFilePath } from "./hub.js";
import { log } from "./log.js";

const FILE_ATTEMPTS = 6;
const RETRY_DELAY_MS = 500;
const CONNECT_TIMEOUT_MS = 1000;
const DRAIN_TIMEOUT_MS = 500;

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

/**
 * Relay mode: bridge Chrome native-messaging frames on stdio to NDJSON lines
 * on the hub TCP socket. Transparent — payloads are forwarded verbatim
 * (parsed + re-serialized so every frame/line carries exactly one JSON
 * object). Resolves only when either side closes; exits 0 in all cases
 * (Chrome respawns the host when the extension retries connectNative).
 */
export async function runRelay(hubFilePath: string = defaultHubFilePath()): Promise<void> {
  for (let attempt = 1; attempt <= FILE_ATTEMPTS; attempt++) {
    const endpoint = readHubFile(hubFilePath);
    if (endpoint) {
      const socket = await tryConnect(endpoint);
      if (socket) {
        log(`relay: connected to hub on 127.0.0.1:${endpoint.port}`);
        await pump(socket, endpoint);
        await drainStdout();
        process.exit(0);
        return;
      }
    }
    if (attempt < FILE_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
    }
  }
  // Hub not reachable. Exit quietly (code 0): Chrome will respawn us when the
  // extension retries connectNative().
  process.exit(0);
}

function pump(socket: net.Socket, endpoint: HubEndpoint): Promise<void> {
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
        const frame = encodeFrame(message);
        if (!process.stdout.write(frame)) {
          socket.pause();
          process.stdout.once("drain", () => socket.resume());
        }
      }
    });
    socket.on("error", (error) => {
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
