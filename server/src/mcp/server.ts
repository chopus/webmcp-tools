import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodTypeAny } from "zod";
import { HubError, type HubApi } from "../hub.js";
import { VERSION } from "../version.js";

/** Per-request timeout ceiling (PROTOCOL.md: "Per-request hub timeout ... cap 120000"). */
export const MAX_TOOL_TIMEOUT_MS = 120000;

type Shape = Record<string, ZodTypeAny>;

// ---------------------------------------------------------------------------
// Shared shape fragments
// ---------------------------------------------------------------------------

const tabIdShape: Shape = { tabId: z.number().int().optional() };

function timeoutShape(defaultMs: number): Shape {
  return { timeoutMs: z.number().int().optional().default(defaultMs) };
}

/** ref/selector targeting pair used by interaction tools. */
function targetingShape(): Shape {
  return {
    ref: z.number().int().optional(),
    selector: z.string().optional(),
  };
}

// ---------------------------------------------------------------------------
// Validation helpers (cross-field rules the raw zod shape cannot express)
// ---------------------------------------------------------------------------

function requireExactlyOne(args: Record<string, unknown>, keys: string[], tool: string): void {
  const present = keys.filter((key) => args[key] !== undefined && args[key] !== null);
  if (present.length !== 1) {
    throw new HubError(
      `${tool}: exactly one of ${keys.map((k) => `"${k}"`).join(", ")} must be provided`,
      "EARGS",
    );
  }
}

function requireAtMostOne(args: Record<string, unknown>, keys: string[], tool: string): void {
  const present = keys.filter((key) => args[key] !== undefined && args[key] !== null);
  if (present.length > 1) {
    throw new HubError(
      `${tool}: at most one of ${keys.map((k) => `"${k}"`).join(", ")} may be provided`,
      "EARGS",
    );
  }
}

// ---------------------------------------------------------------------------
// Result formatting (PROTOCOL.md "Server-side MCP behavior")
// ---------------------------------------------------------------------------

function stringifyResult(result: unknown): string {
  return JSON.stringify(result === undefined ? null : result, null, 2);
}

function textResult(result: unknown): CallToolResult {
  return { content: [{ type: "text", text: stringifyResult(result) }] };
}

function screenshotResult(result: Record<string, unknown>, args: Record<string, unknown>): CallToolResult {
  const format =
    typeof result.format === "string"
      ? result.format
      : typeof args.format === "string"
        ? args.format
        : "png";
  const data = typeof result.dataBase64 === "string" ? result.dataBase64 : "";
  return {
    content: [{ type: "image", data, mimeType: format === "jpeg" ? "image/jpeg" : "image/png" }],
  };
}

/**
 * Snapshot: human-readable `[ref] tag "text" (role=…, value=…, href=…)` lines
 * first (fast for agents to read), then `--- JSON ---` and the full JSON
 * (rect data and all).
 */
function snapshotResult(result: Record<string, unknown>): CallToolResult {
  const lines: string[] = [];
  const elements = Array.isArray(result.elements) ? (result.elements as Record<string, unknown>[]) : [];
  for (const el of elements) {
    const attrs: string[] = [];
    if (typeof el.role === "string" && el.role) attrs.push(`role=${el.role}`);
    if (el.value !== undefined && el.value !== null && String(el.value) !== "") {
      attrs.push(`value=${JSON.stringify(String(el.value))}`);
    }
    if (typeof el.href === "string" && el.href) attrs.push(`href=${el.href}`);
    if (typeof el.placeholder === "string" && el.placeholder) {
      attrs.push(`placeholder=${JSON.stringify(el.placeholder)}`);
    }
    if (typeof el.checked === "boolean") attrs.push(`checked=${el.checked}`);
    if (typeof el.name === "string" && el.name) attrs.push(`name=${el.name}`);
    if (typeof el.id === "string" && el.id) attrs.push(`id=${el.id}`);
    if (typeof el.ariaLabel === "string" && el.ariaLabel) {
      attrs.push(`ariaLabel=${JSON.stringify(el.ariaLabel)}`);
    }
    if (Array.isArray(el.options) && el.options.length > 0) {
      attrs.push(`options=[${(el.options as unknown[]).join(" | ")}]`);
    }
    const text = typeof el.text === "string" && el.text ? ` ${JSON.stringify(el.text)}` : "";
    const attrsText = attrs.length > 0 ? ` (${attrs.join(", ")})` : "";
    lines.push(`[${el.ref}] ${el.tag}${text}${attrsText}`);
  }
  lines.push("--- JSON ---");
  lines.push(stringifyResult(result));
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function extensionDirHint(): string {
  try {
    // dist/mcp/server.js -> <repo>/extension
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "extension");
  } catch {
    return "<repo>/extension";
  }
}

function errorResult(error: unknown): CallToolResult {
  const code =
    error !== null && error !== undefined && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "internal";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error) ?? String(error);
  if (code === "extension_not_connected") {
    return {
      content: [
        {
          type: "text",
          text:
            "Error (extension_not_connected): the WebMCP Tools Chrome extension is not connected. " +
            `Load the unpacked extension from ${extensionDirHint()} in chrome://extensions and run ` +
            "installer/install-host. See docs/USAGE.md.",
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: `Error (${code}): ${message}` }], isError: true };
}

function clampTimeout(requested: unknown, fallbackMs: number): number {
  const value = typeof requested === "number" && Number.isFinite(requested) ? requested : fallbackMs;
  return Math.max(1, Math.min(Math.floor(value), MAX_TOOL_TIMEOUT_MS));
}

// ---------------------------------------------------------------------------
// Tool definitions (PROTOCOL.md §1–§7, names/params/defaults exactly)
// ---------------------------------------------------------------------------

type ResultFormat = "text" | "screenshot" | "snapshot";

interface ToolDef {
  name: string;
  description: string;
  shape: Shape;
  /** Server-side timeout when the tool has no `timeoutMs` param or it is omitted. */
  timeoutMs: number;
  validate?: (args: Record<string, unknown>) => void;
  format?: ResultFormat;
}

const TOOL_DEFS: ToolDef[] = [
  // ----- §1 Browser / tabs -----
  {
    name: "get_browser_info",
    description: "Get browser and extension info: chromeVersion, userAgent, platform, extensionVersion.",
    shape: {},
    timeoutMs: 10000,
  },
  {
    name: "list_tabs",
    description: "List all open tabs across windows.",
    shape: {},
    timeoutMs: 10000,
  },
  {
    name: "new_tab",
    description: "Open a new tab (about:blank by default) and return its Tab object.",
    shape: {
      url: z.string().optional().default("about:blank"),
      active: z.boolean().optional().default(true),
      windowId: z.number().int().optional(),
    },
    timeoutMs: 15000,
  },
  {
    name: "activate_tab",
    description: "Activate a tab (also focuses its window) and return its Tab object.",
    shape: { tabId: z.number().int() },
    timeoutMs: 10000,
  },
  {
    name: "close_tab",
    description: "Close a tab.",
    shape: { tabId: z.number().int() },
    timeoutMs: 10000,
  },

  // ----- §2 Navigation -----
  {
    name: "navigate",
    description: "Navigate a tab to a URL and wait for it to finish loading.",
    shape: { ...tabIdShape, url: z.string(), ...timeoutShape(30000) },
    timeoutMs: 30000,
  },
  {
    name: "go_back",
    description: "Go back in history (like pressing the Back button).",
    shape: { ...tabIdShape, ...timeoutShape(15000) },
    timeoutMs: 15000,
  },
  {
    name: "go_forward",
    description: "Go forward in history (like pressing the Forward button).",
    shape: { ...tabIdShape, ...timeoutShape(15000) },
    timeoutMs: 15000,
  },
  {
    name: "reload",
    description: "Reload a tab, optionally bypassing the cache.",
    shape: {
      ...tabIdShape,
      bypassCache: z.boolean().optional().default(false),
      ...timeoutShape(30000),
    },
    timeoutMs: 30000,
  },
  {
    name: "wait_for",
    description: 'Wait until text content or a CSS selector appears in a tab (polls ~250ms). Provide exactly one of "text" or "selector".',
    shape: {
      ...tabIdShape,
      text: z.string().optional(),
      selector: z.string().optional(),
      ...timeoutShape(10000),
    },
    timeoutMs: 10000,
    validate: (args) => requireExactlyOne(args, ["text", "selector"], "wait_for"),
  },

  // ----- §3 Observation -----
  {
    name: "snapshot",
    description: "Capture the interactive elements of a page with stable refs for targeting. Returns readable [ref] lines plus full JSON (rects, roles, values).",
    shape: {
      ...tabIdShape,
      maxElements: z.number().int().optional().default(800),
      viewportOnly: z.boolean().optional().default(false),
    },
    timeoutMs: 30000,
    format: "snapshot",
  },
  {
    name: "get_page_text",
    description: "Get the innerText of a page body.",
    shape: { ...tabIdShape, maxChars: z.number().int().optional().default(20000) },
    timeoutMs: 30000,
  },
  {
    name: "get_links",
    description: "Get the links (first 300 anchors with href) on a page.",
    shape: { ...tabIdShape },
    timeoutMs: 30000,
  },
  {
    name: "screenshot",
    description: "Capture a screenshot of a tab (PNG or JPEG), optionally full-page, downscaled to maxWidth.",
    shape: {
      ...tabIdShape,
      format: z.enum(["png", "jpeg"]).optional().default("png"),
      quality: z.number().int().optional().default(80),
      fullPage: z.boolean().optional().default(false),
      maxWidth: z.number().int().optional().default(1600),
    },
    timeoutMs: 30000,
    format: "screenshot",
  },

  // ----- §4 Interaction -----
  {
    name: "click",
    description: 'Click an element by ref (from snapshot) or CSS selector.',
    shape: {
      ...tabIdShape,
      ...targetingShape(),
      button: z.enum(["left", "right", "middle"]).optional().default("left"),
      clickCount: z.number().int().optional().default(1),
      modifiers: z.array(z.string()).optional().default([]),
      trusted: z.boolean().optional().default(false),
      ...timeoutShape(5000),
    },
    timeoutMs: 5000,
    validate: (args) => requireExactlyOne(args, ["ref", "selector"], "click"),
  },
  {
    name: "type_text",
    description: "Type text into an element; optionally clear first and submit with Enter.",
    shape: {
      ...tabIdShape,
      ...targetingShape(),
      text: z.string(),
      clearFirst: z.boolean().optional().default(true),
      submit: z.boolean().optional().default(false),
      trusted: z.boolean().optional().default(false),
      ...timeoutShape(10000),
    },
    timeoutMs: 10000,
    validate: (args) => requireExactlyOne(args, ["ref", "selector"], "type_text"),
  },
  {
    name: "press_key",
    description: 'Press a key (e.g. "Enter", "Tab", "ArrowDown", "Control+A") on an element or the page.',
    shape: {
      ...tabIdShape,
      key: z.string(),
      ...targetingShape(),
      trusted: z.boolean().optional().default(false),
      ...timeoutShape(5000),
    },
    timeoutMs: 5000,
    validate: (args) => requireExactlyOne(args, ["ref", "selector"], "press_key"),
  },
  {
    name: "hover",
    description: "Hover an element by ref or CSS selector.",
    shape: { ...tabIdShape, ...targetingShape(), ...timeoutShape(5000) },
    timeoutMs: 5000,
    validate: (args) => requireExactlyOne(args, ["ref", "selector"], "hover"),
  },
  {
    name: "scroll",
    description: 'Scroll the page or an element. "direction" is up/down/left/right; "amount" is pixels.',
    shape: {
      ...tabIdShape,
      direction: z.enum(["up", "down", "left", "right"]).optional().default("down"),
      amount: z.number().int().optional().default(600),
      ...targetingShape(),
      smooth: z.boolean().optional().default(true),
    },
    timeoutMs: 5000,
    validate: (args) => requireAtMostOne(args, ["ref", "selector"], "scroll"),
  },
  {
    name: "select_option",
    description: "Select an option on a <select> by value, label or index (exactly one).",
    shape: {
      ...tabIdShape,
      ...targetingShape(),
      value: z.string().optional(),
      label: z.string().optional(),
      index: z.number().int().optional(),
      ...timeoutShape(5000),
    },
    timeoutMs: 5000,
    validate: (args) => {
      requireExactlyOne(args, ["ref", "selector"], "select_option");
      requireExactlyOne(args, ["value", "label", "index"], "select_option");
    },
  },
  {
    name: "drag",
    description: "Drag from one element to another (each given as a ref or CSS selector).",
    shape: {
      ...tabIdShape,
      fromRef: z.number().int().optional(),
      fromSelector: z.string().optional(),
      toRef: z.number().int().optional(),
      toSelector: z.string().optional(),
      trusted: z.boolean().optional().default(false),
      ...timeoutShape(8000),
    },
    timeoutMs: 8000,
    validate: (args) => {
      requireExactlyOne(args, ["fromRef", "fromSelector"], "drag");
      requireExactlyOne(args, ["toRef", "toSelector"], "drag");
    },
  },

  // ----- §5 JavaScript -----
  {
    name: "evaluate",
    description: 'Evaluate a JS function "(args) => expression-or-promise" in a tab (MAIN world by default). Only JSON-serializable results are returned.',
    shape: {
      ...tabIdShape,
      function: z.string(),
      args: z.record(z.unknown()).optional().default({}),
      world: z.enum(["MAIN", "ISOLATED"]).optional().default("MAIN"),
      awaitPromise: z.boolean().optional().default(true),
      ...timeoutShape(10000),
    },
    timeoutMs: 10000,
  },

  // ----- §6 Console / network -----
  {
    name: "get_console_logs",
    description: "Get recent console logs for a tab (ring buffer, cleared on navigation).",
    shape: {
      ...tabIdShape,
      levels: z
        .array(z.enum(["error", "warn", "log", "info", "debug"]))
        .optional()
        .default(["error", "warn", "log", "info", "debug"]),
      lastN: z.number().int().optional().default(200),
    },
    timeoutMs: 10000,
  },
  {
    name: "get_network_requests",
    description: "Get recent network requests for a tab (attaches the debugger and captures via CDP Network domain).",
    shape: {
      ...tabIdShape,
      urlContains: z.string().optional(),
      lastN: z.number().int().optional().default(50),
    },
    timeoutMs: 15000,
  },
  {
    name: "stop_network_capture",
    description: "Stop network capture and detach the debugger for a tab.",
    shape: { ...tabIdShape },
    timeoutMs: 10000,
  },
  {
    name: "get_cookies",
    description:
      "Read the cookies visible to a tab — including HttpOnly cookies such as session " +
      "credentials — via a momentary debugger attach. The values are sensitive; treat " +
      "them as secrets.",
    shape: {
      ...tabIdShape,
      url: z.string().optional().describe("Read cookies for this URL instead of the tab's URL"),
    },
    timeoutMs: 10000,
  },

  // ----- §7 WebMCP -----
  {
    name: "list_webmcp_tools",
    description: "List tools the page exposes via WebMCP (document.modelContext, polyfill, or declarative forms).",
    shape: {
      ...tabIdShape,
      injectPolyfill: z.boolean().optional().default(false),
    },
    timeoutMs: 15000,
  },
  {
    name: "call_webmcp_tool",
    description: "Call a WebMCP tool exposed by the page, by name.",
    shape: {
      ...tabIdShape,
      name: z.string(),
      args: z.record(z.unknown()).optional().default({}),
      ...timeoutShape(30000),
    },
    timeoutMs: 30000,
  },
];

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Build the MCP server with every PROTOCOL.md tool registered against the
 * given hub. Never throws for per-call failures: every tool error is returned
 * as `{ isError: true }` text content with the error code in parentheses.
 */
export function createMcpServer(hub: HubApi): McpServer {
  const server = new McpServer({ name: "webmcp-browser", version: VERSION }, {
    capabilities: { tools: {} },
  });

  for (const def of TOOL_DEFS) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: {
          ...def.shape,
          instanceId: z
            .string()
            .optional()
            .describe(
              "Target a specific connected browser instance (id from get_browser_info). " +
                "Defaults to the most recently connected browser — set this when several " +
                "Chrome instances are connected.",
            ),
        },
      },
      async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
        const args = rawArgs ?? {};
        try {
          def.validate?.(args);
          const timeoutMs = clampTimeout(args.timeoutMs, def.timeoutMs);
          const { instanceId, ...params } = args;
          const result = (await hub.request(
            def.name,
            params,
            timeoutMs,
            typeof instanceId === "string" && instanceId ? instanceId : undefined,
          )) as Record<string, unknown>;
          if (def.name === "get_browser_info") {
            // Augment with multi-instance routing info from the hub.
            result.instanceId = typeof instanceId === "string" && instanceId
              ? instanceId
              : hub.activeInstanceId;
            result.instances = hub.listInstances();
          }
          switch (def.format) {
            case "screenshot":
              return screenshotResult(result ?? {}, args);
            case "snapshot":
              return snapshotResult(result ?? {});
            default:
              return textResult(result);
          }
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }

  return server;
}

/** Tool names in protocol order (handy for tests and docs). */
export const TOOL_NAMES: string[] = TOOL_DEFS.map((def) => def.name);
