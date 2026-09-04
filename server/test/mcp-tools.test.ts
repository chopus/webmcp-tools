import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../src/hub.js";
import { withMcpClient } from "./helpers.js";

// The exact tool surface from docs/PROTOCOL.md §1–§7 (27 tools).
const EXPECTED_TOOLS = [
  // §1 Browser / tabs
  "get_browser_info",
  "list_tabs",
  "new_tab",
  "activate_tab",
  "close_tab",
  // §2 Navigation
  "navigate",
  "go_back",
  "go_forward",
  "reload",
  "wait_for",
  // §3 Observation
  "snapshot",
  "get_page_text",
  "get_links",
  "screenshot",
  // §4 Interaction
  "click",
  "type_text",
  "press_key",
  "hover",
  "scroll",
  "select_option",
  "drag",
  // §5 JavaScript
  "evaluate",
  // §6 Console / network
  "get_console_logs",
  "get_network_requests",
  "stop_network_capture",
  // §7 WebMCP
  "list_webmcp_tools",
  "call_webmcp_tool",
];

function fakeHub(): HubApi {
  return {
    request: vi.fn(async () => ({})),
  };
}

describe("MCP tool surface", () => {
  it("exposes exactly the 27 tools from PROTOCOL.md", async () => {
    await withMcpClient(fakeHub(), async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual([...EXPECTED_TOOLS].sort());
      expect(tools).toHaveLength(27);
    });
  });

  it("gives every tool a description and a JSON Schema input schema", async () => {
    await withMcpClient(fakeHub(), async (client) => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(typeof tool.description).toBe("string");
        expect(tool.description!.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });
  });

  it("requires the required params (navigate without url is rejected)", async () => {
    await withMcpClient(fakeHub(), async (client) => {
      for (const [name, args] of [
        ["navigate", {}],
        ["click", {}],
        ["evaluate", {}],
        ["activate_tab", {}],
        ["type_text", { ref: 1 }],
      ] as const) {
        const response = await client.callTool({ name, arguments: { ...args } });
        expect(response.isError, name).toBe(true);
        expect(
          (response.content![0] as { type: string; text?: string }).text,
          name,
        ).toMatch(/validation|Invalid arguments|Required|EARGS|must be provided/i);
      }
    });
  });
});
