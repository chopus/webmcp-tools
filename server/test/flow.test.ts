import { describe, expect, it } from "vitest";
import {
  FlowError,
  evaluateExpectation,
  getPath,
  interpolate,
  materializeFunctionFiles,
  runFlow,
  validateFlow,
} from "../src/flow/engine.js";
import { renderHtmlReport, renderJsonReport } from "../src/flow/report.js";
import type { FlowFile, ToolCaller } from "../src/flow/types.js";

const TOOLS = ["get_browser_info", "new_tab", "navigate", "click", "wait_for", "evaluate", "screenshot", "close_tab"];

// ---------------------------------------------------------------- templates

describe("getPath", () => {
  it("walks objects and arrays", () => {
    const root = { a: { b: [{ c: 7 }, { c: 8 }] } };
    expect(getPath(root, "a.b.1.c")).toBe(8);
    expect(getPath(root, "a.b.0.c")).toBe(7);
  });

  it("returns undefined for missing segments", () => {
    expect(getPath({ a: 1 }, "b")).toBeUndefined();
    expect(getPath({ a: null }, "a.b")).toBeUndefined();
    expect(getPath("scalar", "a")).toBeUndefined();
  });
});

describe("interpolate", () => {
  const vars = { query: "capybara facts", tab: { tabId: 42 }, n: 3, on: true };

  it("returns the raw value when the string is exactly one template", () => {
    expect(interpolate("{{tab.tabId}}", vars)).toBe(42);
    expect(interpolate("{{n}}", vars)).toBe(3);
    expect(interpolate("{{on}}", vars)).toBe(true);
    expect(interpolate(" {{tab.tabId}} ", vars)).toBe(42);
  });

  it("embeds values inside larger strings", () => {
    expect(interpolate("id={{tab.tabId}}!", vars)).toBe("id=42!");
  });

  it("applies the uri filter", () => {
    expect(interpolate("https://google.com/search?q={{query|uri}}", vars)).toBe(
      "https://google.com/search?q=capybara%20facts",
    );
  });

  it("interpolates deep into objects and arrays", () => {
    expect(interpolate({ url: "{{query}}", list: ["{{n}}", { keep: true }] }, vars)).toEqual({
      url: "capybara facts",
      list: [3, { keep: true }],
    });
  });

  it("rejects unknown variables and filters", () => {
    expect(() => interpolate("{{nope}}", vars)).toThrow(FlowError);
    expect(() => interpolate("{{query|base64}}", vars)).toThrow(/unknown template filter/);
  });
});

// --------------------------------------------------------------- assertions

describe("evaluateExpectation", () => {
  const value = { s: "hello world", n: 5, arr: ["a", "b"], obj: { k: 1 }, nul: null };

  it.each([
    ["exists", { path: "s" }, "hello world", true],
    ["exists", { path: "nul" }, null, false],
    ["exists", {}, undefined, false],
    ["equals", { value: 5 }, 5, true],
    ["equals", { value: 5 }, "5", false],
    ["notEquals", { value: 5 }, 6, true],
    ["contains", { value: "world" }, "hello world", true],
    ["contains", { value: "zebra" }, "hello world", false],
    ["contains", { value: "b" }, ["a", "b"], true],
    ["contains", { value: "k" }, { k: 1 }, true],
    ["matches", { regex: "^hello" }, "hello world", true],
    ["matches", { regex: "^world" }, "hello world", false],
    ["in", { value: ["clicked", "absent"] }, "absent", true],
    ["in", { value: ["clicked", "absent"] }, "other", false],
    ["gt", { value: 4 }, 5, true],
    ["gte", { value: 5 }, 5, true],
    ["lt", { value: 6 }, 5, true],
    ["lte", { value: 5 }, 5, true],
    ["gt", { value: "x" }, 5, false],
    ["type", { type: "string" }, "x", true],
    ["type", { type: "array" }, [1], true],
    ["type", { type: "number" }, "5", false],
    ["lengthGte", { value: 3 }, "hello", true],
    ["lengthLte", { value: 2 }, ["a", "b"], true],
    ["lengthGte", { value: 1 }, 5, false],
  ] as const)("op %s %j on %j → %s", (op, extra, actual, expected) => {
    expect(evaluateExpectation(actual, { path: "x", op, ...extra })).toBe(expected);
  });

  it("treats a broken regex as a failed check, not a crash", () => {
    expect(evaluateExpectation("x", { path: "x", op: "matches", regex: "(" })).toBe(false);
  });
});

// ---------------------------------------------------------------- validation

describe("validateFlow", () => {
  const base = (): FlowFile => ({
    name: "t",
    steps: [{ name: "s1", tool: "new_tab", args: { url: "https://example.com" } }],
  });

  it("accepts a minimal flow", () => {
    expect(() => validateFlow(base(), TOOLS)).not.toThrow();
  });

  it("rejects structural problems", () => {
    expect(() => validateFlow({ name: "", steps: [] } as unknown as FlowFile, TOOLS)).toThrow(/name/);
    expect(() => validateFlow({ name: "x", steps: [] } as unknown as FlowFile, TOOLS)).toThrow(/steps/);
    expect(() =>
      validateFlow(
        { name: "x", steps: [{ name: "s", tool: "new_tab" }], vars: [1] } as unknown as FlowFile,
        TOOLS,
      ),
    ).toThrow(/vars/);
  });

  it("rejects unknown tools and operators", () => {
    const flow = base();
    flow.steps[0].tool = "press_the_button";
    expect(() => validateFlow(flow, TOOLS)).toThrow(/unknown tool/);
    const flow2 = base();
    flow2.steps[0].expect = [{ path: "x", op: "smells" }];
    expect(() => validateFlow(flow2, TOOLS)).toThrow(/unknown operator/);
  });

  it("rejects a bad save name and negative retries", () => {
    const flow = base();
    flow.steps[0].save = "not a name";
    expect(() => validateFlow(flow, TOOLS)).toThrow(/save/);
    const flow2 = base();
    flow2.steps[0].retries = -1;
    expect(() => validateFlow(flow2, TOOLS)).toThrow(/retries/);
  });

  it("validates finally steps too", () => {
    const flow = base();
    flow.finally = [{ name: "f", tool: "nope" }];
    expect(() => validateFlow(flow, TOOLS)).toThrow(/unknown tool/);
  });
});

describe("functionFile", () => {
  it("validateFlow restricts functionFile to evaluate steps", () => {
    const flow: FlowFile = {
      name: "ff",
      steps: [{ name: "s", tool: "click", functionFile: "lib/p.js" }],
    };
    expect(() => validateFlow(flow, TOOLS)).toThrow(/evaluate/);
  });

  it("rejects functionFile together with an inline function", () => {
    const flow: FlowFile = {
      name: "ff",
      steps: [{ name: "s", tool: "evaluate", functionFile: "lib/p.js", args: { function: "(a)=>1" } }],
    };
    expect(() => validateFlow(flow, TOOLS)).toThrow(/not both/);
  });

  it("materializeFunctionFiles injects file contents as args.function", () => {
    const flow: FlowFile = {
      name: "ff",
      steps: [
        { name: "parse", tool: "evaluate", functionFile: "lib/google-search.js", args: { world: "MAIN" } },
      ],
      finally: [{ name: "cleanup eval", tool: "evaluate", functionFile: "lib/other.js" }],
    };
    const files: Record<string, string> = {
      "lib/google-search.js": "(args) => 41 + 1",
      "lib/other.js": "(args) => 'done'",
    };
    const out = materializeFunctionFiles(flow, (rel) => files[rel]);
    expect(out.steps[0].args).toEqual({ world: "MAIN", function: "(args) => 41 + 1" });
    expect(out.finally?.[0].args).toEqual({ function: "(args) => 'done'" });
    expect(out.steps[0].functionFile).toBe("lib/google-search.js"); // original untouched otherwise
  });

  it("fails clearly on a missing or empty file", () => {
    const flow: FlowFile = { name: "ff", steps: [{ name: "s", tool: "evaluate", functionFile: "nope.js" }] };
    expect(() => materializeFunctionFiles(flow, () => { throw new Error("ENOENT"); })).toThrow(/cannot read functionFile/);
    expect(() => materializeFunctionFiles(flow, () => "   ")).toThrow(/is empty/);
  });

  it("end to end: a functionFile step runs its loaded function through the caller", async () => {
    let received: unknown;
    const caller: ToolCaller = async (_tool, args) => {
      received = (args as { function?: string }).function;
      const fn = new Function(`return (${received});`)() as (a: unknown) => number;
      return { result: fn({}) };
    };
    const flow: FlowFile = {
      name: "ff-e2e",
      steps: [{ name: "parse", tool: "evaluate", functionFile: "lib/parse.js", expect: [{ path: "result", op: "equals", value: 42 }] }],
    };
    const run = await runFlow(materializeFunctionFiles(flow, () => "(args) => 6 * 7"), caller);
    expect(run.status).toBe("pass");
    expect(received).toBe("(args) => 6 * 7");
  });
});

// ----------------------------------------------------------------- execution

describe("runFlow", () => {
  it("runs steps, saves results, and interpolates them into later args", async () => {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const caller: ToolCaller = async (tool, args) => {
      seen.push({ tool, args });
      if (tool === "new_tab") return { tab: { tabId: 77, url: "https://google.com" } };
      if (tool === "wait_for") return { found: true, matched: "text" };
      return { ok: true };
    };
    const flow: FlowFile = {
      name: "chain",
      vars: { query: "capybara" },
      steps: [
        {
          name: "open",
          tool: "new_tab",
          args: { url: "https://google.com/search?q={{query|uri}}" },
          save: "tab",
          saveFrom: "tab",
        },
        { name: "wait", tool: "wait_for", args: { tabId: "{{tab.tabId}}", text: "{{query}}" } },
      ],
    };
    const run = await runFlow(flow, caller);
    expect(run.status).toBe("pass");
    expect(run.counts).toEqual({ pass: 2, fail: 0, soft: 0, skip: 0 });
    expect(seen[0].args.url).toBe("https://google.com/search?q=capybara");
    expect(seen[1].args.tabId).toBe(77); // typed, not "77"
    expect(seen[1].args.text).toBe("capybara");
    expect(run.vars.tab).toEqual({ tabId: 77, url: "https://google.com" });
  });

  it("fails a step whose saveFrom path is missing from the result", async () => {
    const caller: ToolCaller = async () => ({ completely: "different" });
    const flow: FlowFile = {
      name: "bad-save",
      steps: [{ name: "open", tool: "new_tab", save: "tab", saveFrom: "tab" }],
    };
    const run = await runFlow(flow, caller);
    expect(run.status).toBe("fail");
    expect(run.steps[0].error).toContain("saveFrom");
  });

  it("option vars override flow vars", async () => {
    const caller: ToolCaller = async (_tool, args) => ({ echoed: (args as { q?: string }).q });
    const flow: FlowFile = {
      name: "vars",
      vars: { q: "default" },
      steps: [{ name: "echo", tool: "evaluate", args: { q: "{{q}}" } }],
    };
    const run = await runFlow(flow, caller, { vars: { q: "override" } });
    expect(run.status).toBe("pass");
    expect(run.vars.q).toBe("override");
  });

  it("retries a failing tool call and records attempts", async () => {
    let calls = 0;
    const caller: ToolCaller = async () => {
      calls += 1;
      if (calls < 3) throw new Error("flaky");
      return { fine: true };
    };
    const flow: FlowFile = {
      name: "retry",
      steps: [{ name: "flaky", tool: "evaluate", retries: 3, retryDelayMs: 1 }],
    };
    const run = await runFlow(flow, caller);
    expect(run.status).toBe("pass");
    expect(run.steps[0].attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it("retries when an assertion fails, then succeeds", async () => {
    let calls = 0;
    const caller: ToolCaller = async () => {
      calls += 1;
      return { count: calls };
    };
    const flow: FlowFile = {
      name: "assert-retry",
      steps: [
        {
          name: "wait for two",
          tool: "evaluate",
          expect: [{ path: "count", op: "gte", value: 2 }],
          retries: 2,
          retryDelayMs: 1,
        },
      ],
    };
    const run = await runFlow(flow, caller);
    expect(run.status).toBe("pass");
    expect(run.steps[0].attempts).toBe(2);
    expect(run.steps[0].assertions?.every((a) => a.pass)).toBe(true);
  });

  it("aborts on a non-optional failure, runs finally, skips the rest", async () => {
    const order: string[] = [];
    const caller: ToolCaller = async (tool) => {
      order.push(tool);
      if (tool === "wait_for") throw new Error("never appeared");
      return { ok: true };
    };
    const flow: FlowFile = {
      name: "abort",
      steps: [
        { name: "open", tool: "new_tab" },
        { name: "wait", tool: "wait_for", retries: 1, retryDelayMs: 1 },
        { name: "later", tool: "click", args: { selector: "#x" } },
      ],
      finally: [{ name: "cleanup", tool: "close_tab", args: { tabId: 1 }, optional: true }],
    };
    const run = await runFlow(flow, caller);
    expect(run.status).toBe("fail");
    expect(run.steps[1].status).toBe("fail");
    expect(run.steps[1].error).toContain("never appeared");
    expect(run.steps[2].status).toBe("skip");
    expect(run.steps[3].status).toBe("pass"); // finally still ran
    expect(order).toEqual(["new_tab", "wait_for", "wait_for", "close_tab"]);
  });

  it("marks an optional failure as soft and continues", async () => {
    const caller: ToolCaller = async (tool) => {
      if (tool === "evaluate") throw new Error("page had no banner");
      return { ok: true };
    };
    const flow: FlowFile = {
      name: "soft",
      steps: [
        { name: "dismiss banner", tool: "evaluate", optional: true },
        { name: "continue", tool: "new_tab" },
      ],
    };
    const run = await runFlow(flow, caller);
    expect(run.status).toBe("pass");
    expect(run.steps[0].status).toBe("soft");
    expect(run.steps[0].error).toContain("banner");
    expect(run.steps[1].status).toBe("pass");
  });

  it("interpolates variables into assertion operands", async () => {
    const caller: ToolCaller = async () => ({ result: { echoed: "capybara" } });
    const flow: FlowFile = {
      name: "expect-var",
      vars: { query: "capybara" },
      steps: [
        {
          name: "check echo",
          tool: "evaluate",
          expect: [{ path: "result.echoed", op: "equals", value: "{{query}}" }],
        },
      ],
    };
    const run = await runFlow(flow, caller);
    expect(run.status).toBe("pass");
    expect(run.steps[0].assertions?.[0].expected).toBe('"capybara"');
  });

  it("skips a step whose when-condition is false", async () => {
    const caller: ToolCaller = async () => ({ result: "clicked" });
    const flow: FlowFile = {
      name: "when",
      steps: [
        { name: "maybe click", tool: "click", args: { selector: "#consent" }, when: { path: "page.result", op: "equals", value: "absent" } },
      ],
    };
    const run = await runFlow(flow, caller, { vars: { page: { result: "clicked" } } });
    expect(run.steps[0].status).toBe("skip");
    expect(run.steps[0].when?.passed).toBe(false);
    expect(run.steps[0].attempts).toBe(0);
  });

  it("stashes screenshots and redacts the base64 from the recorded result", async () => {
    const caller: ToolCaller = async (tool) =>
      tool === "screenshot" ? { format: "jpeg", width: 800, height: 600, dataBase64: "QUJD" } : { ok: 1 };
    const flow: FlowFile = {
      name: "shot",
      steps: [{ name: "snap", tool: "screenshot", args: { format: "jpeg" } }],
    };
    const run = await runFlow(flow, caller);
    expect(run.steps[0].screenshot).toEqual({ mimeType: "image/jpeg", dataBase64: "QUJD" });
    expect(run.steps[0].result).not.toContain("QUJD");
    expect(run.steps[0].result).toContain("[image data omitted]");
  });

  it("fails fast on a broken template without calling the tool", async () => {
    const caller: ToolCaller = async () => {
      throw new Error("must not be called");
    };
    const flow: FlowFile = {
      name: "bad-template",
      steps: [{ name: "oops", tool: "new_tab", args: { url: "{{missing.thing}}" } }],
    };
    const run = await runFlow(flow, caller);
    expect(run.status).toBe("fail");
    expect(run.steps[0].attempts).toBe(0);
    expect(run.steps[0].error).toContain("unknown variable");
  });
});

// ------------------------------------------------------------------- report

describe("reports", () => {
  const run = {
    flow: { name: "google-search<script>", description: "checks <b>escaping</b>" },
    startedAt: "2026-09-05T10:00:00.000Z",
    finishedAt: "2026-09-05T10:00:05.000Z",
    durationMs: 5000,
    status: "pass" as const,
    vars: { query: "capybara" },
    browser: { instanceId: "abc", chromeVersion: "152.0.0" },
    counts: { pass: 2, fail: 0, soft: 0, skip: 0 },
    steps: [
      {
        index: 0,
        section: "steps" as const,
        name: "open results page",
        tool: "new_tab",
        args: '{"url":"https://google.com/search?q=capybara"}',
        status: "pass" as const,
        attempts: 1,
        startedAt: "2026-09-05T10:00:00.000Z",
        durationMs: 1200,
        assertions: [{ path: "tab.tabId", op: "type" as const, actual: "42", pass: true }],
      },
      {
        index: 1,
        section: "steps" as const,
        name: "screenshot the results",
        tool: "screenshot",
        status: "pass" as const,
        attempts: 1,
        startedAt: "2026-09-05T10:00:03.000Z",
        durationMs: 900,
        screenshot: { mimeType: "image/jpeg", dataBase64: "QUJD" },
      },
    ],
  };

  it("renders a self-contained HTML report with escaping and embedded images", () => {
    const html = renderHtmlReport(run);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("google-search&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;escaping&lt;/b&gt;");
    expect(html).toContain("open results page");
    expect(html).toContain("badge-pass");
    expect(html).toContain("data:image/jpeg;base64,QUJD");
    expect(html).not.toContain("<script>"); // nothing unescaped slipped through
  });

  it("renders a JSON report that round-trips", () => {
    const parsed = JSON.parse(renderJsonReport(run));
    expect(parsed.flow.name).toBe("google-search<script>");
    expect(parsed.steps[1].screenshot.dataBase64).toBe("QUJD");
    expect(parsed.counts).toEqual({ pass: 2, fail: 0, soft: 0, skip: 0 });
  });
});
