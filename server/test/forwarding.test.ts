import { describe, expect, it, vi } from "vitest";
import { HubError, type HubApi } from "../src/hub.js";
import { textOf, withMcpClient } from "./helpers.js";

interface RecordedCall {
  tool: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

function fakeHub(
  respond: (call: RecordedCall) => Promise<unknown>,
): { hub: HubApi; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const hub: HubApi = {
    request: vi.fn(async (tool, params = {}, timeoutMs) => {
      const call = { tool, params, timeoutMs };
      calls.push(call);
      return respond(call);
    }),
  };
  return { hub, calls };
}

describe("MCP forwarding to the hub", () => {
  it("navigate forwards exact params and returns pretty JSON text", async () => {
    const result = { tabId: 3, url: "https://example.com/", title: "Example" };
    const { hub, calls } = fakeHub(async () => result);
    await withMcpClient(hub, async (client) => {
      const response = await client.callTool({
        name: "navigate",
        arguments: { url: "https://example.com/", tabId: 3, timeoutMs: 1500 },
      });
      expect(response.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].tool).toBe("navigate");
      expect(calls[0].params).toEqual({ url: "https://example.com/", tabId: 3, timeoutMs: 1500 });
      expect(calls[0].timeoutMs).toBe(1500);
      const block = response.content![0] as { type: string };
      expect(block.type).toBe("text");
      expect(JSON.parse(textOf(response.content!))).toEqual(result);
    });
  });

  it("applies per-tool timeoutMs defaults and the 120000 cap", async () => {
    const { hub, calls } = fakeHub(async () => ({}));
    await withMcpClient(hub, async (client) => {
      await client.callTool({ name: "navigate", arguments: { url: "https://x/" } });
      expect(calls[0].timeoutMs).toBe(30000);
      expect(calls[0].params.timeoutMs).toBe(30000);

      await client.callTool({ name: "click", arguments: { ref: 1 } });
      expect(calls[1].timeoutMs).toBe(5000);

      await client.callTool({ name: "wait_for", arguments: { selector: "#x" } });
      expect(calls[2].timeoutMs).toBe(10000);

      await client.callTool({ name: "navigate", arguments: { url: "https://x/", timeoutMs: 999999 } });
      expect(calls[3].timeoutMs).toBe(120000);

      // Tools without a timeoutMs param still get a server-side default.
      await client.callTool({ name: "get_browser_info", arguments: {} });
      expect(calls[4].timeoutMs).toBe(10000);
    });
  });

  it("screenshot returns image content with the right mimeType", async () => {
    const { hub } = fakeHub(async (call) =>
      call.tool === "screenshot" && call.params.format === "jpeg"
        ? { format: "jpeg", width: 800, height: 600, dataBase64: "anBlZWc=" }
        : { format: "png", width: 800, height: 600, dataBase64: "cG5nZGF0YQ==" },
    );
    await withMcpClient(hub, async (client) => {
      const png = await client.callTool({ name: "screenshot", arguments: {} });
      const pngBlock = png.content![0] as { type: string; data: string; mimeType: string };
      expect(pngBlock.type).toBe("image");
      expect(pngBlock.mimeType).toBe("image/png");
      expect(pngBlock.data).toBe("cG5nZGF0YQ==");

      const jpeg = await client.callTool({ name: "screenshot", arguments: { format: "jpeg", quality: 50 } });
      const jpegBlock = jpeg.content![0] as { type: string; data: string; mimeType: string };
      expect(jpegBlock.type).toBe("image");
      expect(jpegBlock.mimeType).toBe("image/jpeg");
      expect(jpegBlock.data).toBe("anBlZWc=");
    });
  });

  it("snapshot returns readable [ref] lines plus --- JSON --- appendix", async () => {
    const snapshot = {
      tabId: 1,
      url: "https://example.com/",
      title: "Example",
      viewport: { scrollX: 0, scrollY: 0, width: 1280, height: 800 },
      elements: [
        {
          ref: 3,
          tag: "a",
          role: "link",
          text: "Docs",
          href: "https://example.com/docs",
          rect: { x: 10, y: 20, w: 50, h: 20 },
          visible: true,
        },
        {
          ref: 5,
          tag: "input",
          value: "hi",
          placeholder: "Search",
          rect: { x: 10, y: 60, w: 200, h: 30 },
          visible: true,
        },
        { ref: 7, tag: "select", options: ["A", "B"], rect: { x: 1, y: 2, w: 3, h: 4 }, visible: true },
      ],
      truncated: false,
    };
    const { hub } = fakeHub(async () => snapshot);
    await withMcpClient(hub, async (client) => {
      const response = await client.callTool({ name: "snapshot", arguments: {} });
      const text = textOf(response.content!);
      const lines = text.split("\n");
      expect(lines[0]).toBe('[3] a "Docs" (role=link, href=https://example.com/docs)');
      expect(lines).toContain('[5] input (value="hi", placeholder="Search")');
      expect(lines).toContain("[7] select (options=[A | B])");
      expect(lines).toContain("--- JSON ---");
      const jsonStart = lines.indexOf("--- JSON ---") + 1;
      expect(JSON.parse(lines.slice(jsonStart).join("\n"))).toEqual(snapshot);
    });
  });

  it("maps hub extension_not_connected to the helpful MCP error", async () => {
    const { hub } = fakeHub(async () => {
      throw new HubError("the WebMCP Tools Chrome extension is not connected", "extension_not_connected");
    });
    await withMcpClient(hub, async (client) => {
      const response = await client.callTool({ name: "list_tabs", arguments: {} });
      expect(response.isError).toBe(true);
      const text = textOf(response.content!);
      expect(text).toContain("Error (extension_not_connected)");
      expect(text).toContain("chrome://extensions");
      expect(text).toContain("install-host");
      expect(text).toContain("docs/USAGE.md");
    });
  });

  it("surfaces other hub error codes in parentheses", async () => {
    const { hub } = fakeHub(async () => {
      throw new HubError("no such ref", "ENO_SUCH_REF");
    });
    await withMcpClient(hub, async (client) => {
      const response = await client.callTool({ name: "click", arguments: { ref: 99 } });
      expect(response.isError).toBe(true);
      expect(textOf(response.content!)).toBe("Error (ENO_SUCH_REF): no such ref");
    });
  });

  it("validates exactly-one targeting rules at the MCP layer", async () => {
    const { hub, calls } = fakeHub(async () => ({}));
    await withMcpClient(hub, async (client) => {
      const neither = await client.callTool({ name: "click", arguments: {} });
      expect(neither.isError).toBe(true);
      expect(textOf(neither.content!)).toContain("EARGS");
      expect(textOf(neither.content!)).toContain('"ref"');

      const both = await client.callTool({ name: "click", arguments: { ref: 1, selector: "#x" } });
      expect(both.isError).toBe(true);
      expect(textOf(both.content!)).toContain("EARGS");

      const waitNeither = await client.callTool({ name: "wait_for", arguments: {} });
      expect(waitNeither.isError).toBe(true);
      expect(textOf(waitNeither.content!)).toContain("EARGS");

      const selectNeither = await client.callTool({ name: "select_option", arguments: { ref: 2 } });
      expect(selectNeither.isError).toBe(true);
      expect(textOf(selectNeither.content!)).toContain("EARGS");

      // Valid calls go through to the hub.
      await client.callTool({ name: "click", arguments: { selector: "#btn", button: "right" } });
      expect(calls.at(-1)?.params).toEqual({ selector: "#btn", button: "right", clickCount: 1, modifiers: [], trusted: false, timeoutMs: 5000 });
    });
  });

  it("forwards the evaluate function param and applies defaults", async () => {
    const { hub, calls } = fakeHub(async () => ({ result: 42 }));
    await withMcpClient(hub, async (client) => {
      const response = await client.callTool({
        name: "evaluate",
        arguments: { function: "(args) => args.a + 1", args: { a: 41 } },
      });
      expect(JSON.parse(textOf(response.content!))).toEqual({ result: 42 });
      expect(calls[0].params).toEqual({
        function: "(args) => args.a + 1",
        args: { a: 41 },
        world: "MAIN",
        awaitPromise: true,
        timeoutMs: 10000,
      });
    });
  });

  it("applies defaults for new_tab, get_console_logs and reload", async () => {
    const { hub, calls } = fakeHub(async () => ({}));
    await withMcpClient(hub, async (client) => {
      await client.callTool({ name: "new_tab", arguments: {} });
      expect(calls[0].params).toEqual({ url: "about:blank", active: true });

      await client.callTool({ name: "reload", arguments: {} });
      expect(calls[1].params).toEqual({ bypassCache: false, timeoutMs: 30000 });

      await client.callTool({ name: "get_console_logs", arguments: {} });
      expect(calls[2].params).toEqual({ levels: ["error", "warn", "log", "info", "debug"], lastN: 200 });

      await client.callTool({ name: "scroll", arguments: {} });
      expect(calls[3].params).toEqual({ direction: "down", amount: 600, smooth: true });
    });
  });
});
