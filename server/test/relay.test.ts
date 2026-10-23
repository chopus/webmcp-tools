import * as net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FrameDecoder } from "../src/framing.js";
import { relayMain, startHeartbeat, type FrameSink, type RelayOptions } from "../src/relay.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** Sink that collects parsed frames and never backpressures. */
function collectorSink() {
  const decoder = new FrameDecoder();
  const messages: unknown[] = [];
  const sink: FrameSink = {
    write(frame: Buffer) {
      for (const message of decoder.push(frame)) messages.push(message);
      return true;
    },
    onceDrain() {
      /* never backpressured */
    },
  };
  return { sink, messages };
}

/** Sink whose backpressure the test controls manually. */
function blockingSink() {
  const decoder = new FrameDecoder();
  const messages: unknown[] = [];
  const drainListeners: Array<() => void> = [];
  let blocked = false;
  return {
    sink: {
      write(frame: Buffer) {
        for (const message of decoder.push(frame)) messages.push(message);
        return !blocked;
      },
      onceDrain(listener: () => void) {
        drainListeners.push(listener);
      },
    } as FrameSink,
    messages,
    block() {
      blocked = true;
    },
    drain() {
      blocked = false;
      for (const listener of drainListeners.splice(0)) listener();
    },
  };
}

function writeHubFile(): { file: string; setPort: (port: number) => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "webmcp-relay-test-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "hub.json");
  const setPort = (port: number) => writeFileSync(file, JSON.stringify({ port, token: "test-token" }));
  setPort(0);
  return { file, setPort };
}

/** Minimal hub: accepts the relay handshake, then lets the test script it. */
function scriptedHub(
  onHello: (
    send: (message: unknown) => void,
    end: () => void,
  ) => void,
): Promise<{
  port: number;
  close: () => Promise<void>;
  destroyClient: () => void;
}> {
  return new Promise((resolve) => {
    let client: net.Socket | null = null;
    const server = net.createServer((socket) => {
      client = socket;
      socket.setNoDelay(true);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          const parsed = JSON.parse(line) as { kind?: string; token?: string };
          if (parsed.kind === "hello" && parsed.token === "test-token") {
            onHello(
              (message) => socket.write(JSON.stringify(message) + "\n"),
              () => socket.end(),
            );
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => new Promise((done) => server.close(() => done())),
        destroyClient: () => client?.destroy(),
      });
    });
  });
}

const hubLine = (id: number) => ({ v: 1, kind: "request", id, tool: "probe", params: {} });
const isHubLine = (m: unknown, id: number) =>
  (m as { kind?: string; id?: number }).kind === "request" && (m as { id?: number }).id === id;

describe("startHeartbeat", () => {
  it("emits relayHeartbeat frames carrying the current phase, then stops", async () => {
    const { sink, messages } = collectorSink();
    const hb = startHeartbeat({ sink, heartbeatMs: 30 });
    await new Promise((r) => setTimeout(r, 45));
    hb.setPhase("pump");
    await new Promise((r) => setTimeout(r, 45));
    hb.stop();
    const count = messages.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(messages.length).toBe(count); // stopped — nothing new

    const hearts = messages.filter(
      (m) => (m as { kind?: string; event?: string }).kind === "event"
        && (m as { event?: string }).event === "relayHeartbeat",
    );
    expect(hearts.length).toBeGreaterThanOrEqual(2);
    const phases = hearts.map((m) => (m as { data?: { phase?: string } }).data?.phase);
    expect(phases).toContain("hunt");
    expect(phases).toContain("pump");
  });
});

describe("relayMain", () => {
  it("resolves hub-not-found (with heartbeats flowing) when no hub file exists", async () => {
    const { sink, messages } = collectorSink();
    const missing = path.join(os.tmpdir(), "webmcp-relay-test-no-such-file.json");
    const outcome = await relayMain(missing, { sink, huntMs: 400, heartbeatMs: 80 });
    expect(outcome).toBe("hub-not-found");
    const hearts = messages.filter(
      (m) => (m as { event?: string }).event === "relayHeartbeat",
    );
    expect(hearts.length).toBeGreaterThanOrEqual(1);
  });

  it("hunts, connects to the hub, forwards a hub line, and resolves pumped on close", async () => {
    const { file, setPort } = writeHubFile();
    const { sink, messages } = collectorSink();
    const hub = await scriptedHub((send, end) => {
      send({ v: 1, kind: "hello", who: "hub" });
      send(hubLine(1));
      end();
    });
    setPort(hub.port);

    const outcome = await relayMain(file, { sink, huntMs: 5000, heartbeatMs: 100 });
    expect(outcome).toBe("pumped");
    expect(messages.find((m) => (m as { who?: string }).who === "hub")).toBeDefined();
    expect(messages.find((m) => isHubLine(m, 1))).toBeDefined();
    await hub.close();
  });

  it("pauses the hub socket on chrome-side backpressure and resumes on the sink's drain", async () => {
    const { file, setPort } = writeHubFile();
    const { sink, messages, block, drain } = blockingSink();
    const hub = await scriptedHub((send) => {
      send(hubLine(1));
      setTimeout(() => send(hubLine(2)), 80);
      setTimeout(() => send(hubLine(3)), 160);
    });
    setPort(hub.port);
    block(); // every write reports backpressure from the start

    const pumped = relayMain(file, { sink, huntMs: 5000, heartbeatMs: 1000 });
    await new Promise((r) => setTimeout(r, 400));
    // Line 1 arrived and reported backpressure → socket paused: lines 2 and 3
    // must be withheld until the chrome side drains.
    expect(messages.find((m) => isHubLine(m, 1))).toBeDefined();
    expect(messages.find((m) => isHubLine(m, 2))).toBeUndefined();
    expect(messages.find((m) => isHubLine(m, 3))).toBeUndefined();

    drain();
    await new Promise((r) => setTimeout(r, 400));
    expect(messages.find((m) => isHubLine(m, 2))).toBeDefined();
    expect(messages.find((m) => isHubLine(m, 3))).toBeDefined();

    hub.destroyClient(); // closing the hub side resolves pump()
    expect(await pumped).toBe("pumped");
    await hub.close();
  });
});
