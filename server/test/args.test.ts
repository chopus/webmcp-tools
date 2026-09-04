import { describe, expect, it } from "vitest";
import { detectMode } from "../src/args.js";

describe("detectMode", () => {
  it("defaults to MCP mode", () => {
    expect(detectMode([])).toBe("mcp");
    expect(detectMode(["--foo"])).toBe("mcp");
    expect(detectMode(["some", "args"])).toBe("mcp");
  });

  it("--native-host selects relay mode", () => {
    expect(detectMode(["--native-host"])).toBe("relay");
  });

  it("a chrome-extension:// origin argv selects relay mode", () => {
    expect(detectMode(["chrome-extension://abcdefghijklmnop/"])).toBe("relay");
    expect(detectMode(["--foo", "chrome-extension://abcdefghijklmnop/"])).toBe("relay");
  });

  it("--version wins", () => {
    expect(detectMode(["--version"])).toBe("version");
    expect(detectMode(["-v"])).toBe("version");
    expect(detectMode(["--version", "--native-host"])).toBe("version");
  });

  it("--help wins", () => {
    expect(detectMode(["--help"])).toBe("help");
    expect(detectMode(["-h"])).toBe("help");
    expect(detectMode(["--help", "chrome-extension://x/"])).toBe("help");
  });

  it("--print-mcp-config", () => {
    expect(detectMode(["--print-mcp-config"])).toBe("print-mcp-config");
  });
});
