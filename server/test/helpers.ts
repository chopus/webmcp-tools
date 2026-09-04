import * as net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HubApi } from "../src/hub.js";
import { createMcpServer } from "../src/mcp/server.js";
import { LineDecoder } from "../src/framing.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fake relay/extension client that speaks the hub's NDJSON protocol. */
export class FakeRelay {
  readonly socket: net.Socket;
  closed = false;
  private decoder = new LineDecoder();
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];

  constructor(port: number) {
    this.socket = net.connect({ host: "127.0.0.1", port });
    this.socket.setNoDelay(true);
    this.socket.on("data", (chunk: Buffer) => {
      for (const line of this.decoder.push(chunk)) {
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
      }
    });
    this.socket.on("close", () => {
      this.closed = true;
    });
  }

  send(message: unknown): void {
    this.socket.write(JSON.stringify(message) + "\n");
  }

  /** Resolves the next hub message (JSON-parsed), or throws after timeoutMs. */
  async next(timeoutMs = 3000): Promise<Record<string, unknown>> {
    const line =
      this.lines.length > 0
        ? (this.lines.shift() as string)
        : await Promise.race([
            new Promise<string>((resolve) => this.waiters.push(resolve)),
            sleep(timeoutMs).then(() => {
              throw new Error("timed out waiting for a hub message");
            }),
          ]);
    return JSON.parse(line) as Record<string, unknown>;
  }

  async closedWithin(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.closed) return true;
      await sleep(20);
    }
    return this.closed;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** Connect the MCP server to an in-memory client and run `fn(client)`. */
export async function withMcpClient(
  hub: HubApi,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createMcpServer(hub);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

export function textOf(content: Array<{ type: string }>): string {
  const block = content[0] as { type: string; text?: string };
  if (block?.type !== "text" || typeof block.text !== "string") {
    throw new Error(`expected text content, got ${JSON.stringify(content[0])}`);
  }
  return block.text;
}
