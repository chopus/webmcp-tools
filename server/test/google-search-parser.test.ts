// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PARSER_SOURCE = readFileSync(join(TEST_DIR, "..", "..", "flows", "lib", "google-search.js"), "utf8");
const FIXTURE = readFileSync(join(TEST_DIR, "fixtures", "google-serp.html"), "utf8");

/** The flow runner sends the whole file as the evaluate `function` argument;
 *  the extension evaluates `(<source>)(args)`. Mirror that contract exactly. */
const loadParser = (): ((args: unknown) => Record<string, unknown>) =>
  new Function(`return (${PARSER_SOURCE});`)() as (args: unknown) => Record<string, unknown>;

beforeAll(() => {
  // The parser reads location.href / location.search; stub a results URL.
  vi.stubGlobal("location", new URL("https://www.google.com/search?q=test+query&start=10"));
});

describe("google-search parser (live-verified structure, synthetic content)", () => {
  beforeAll(() => {
    document.body.innerHTML = FIXTURE.replace(/^[\s\S]*?<body>|<\/body>[\s\S]*$/g, "");
  });

  it("parses organic results with title, href, display, and snippet", () => {
    const out = loadParser()({});
    const results = out.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.position)).toEqual([1, 2, 3, 4]);
    expect(results[0].title).toBe("The 6 Best Gaming Keyboards of 2026");
    expect(results[0].href).toBe("https://www.rtings.com/keyboard/reviews/best");
    expect(results[0].display).toContain("rtings.com");
    expect(String(results[0].snippet)).toContain("We tested 200 keyboards");
    expect(results[1].title).toContain("Best Mechanical Keyboards");
    expect(results[2].href).toBeNull(); // JS-wired anchor without href
    expect(results[2].title).toContain("TKL");
    // video row: keeps its own metadata, never steals a sibling's snippet
    expect(results[3].snippet).toBeNull();
    expect(String(results[3].display)).toContain("95K+ views");
  });

  it("separates ads from organic results", () => {
    const out = loadParser()({});
    const ads = out.ads as Array<Record<string, unknown>>;
    expect(ads).toHaveLength(1);
    expect(ads[0].title).toContain("Sponsored");
    expect(ads[0].href).toContain("ad.example.com");
  });

  it("reads page metadata: query, page, stats, related searches, pagination", () => {
    const out = loadParser()({});
    expect(out.query).toBe("test query");
    expect(out.page).toBe(2); // start=10
    expect(out.resultsTotalText).toContain("12.300.000");
    expect(out.relatedSearches).toEqual(["best 60 percent keyboard", "hall effect keyboard"]);
    expect(out.hasNextPage).toBe(true);
    expect(String(out.nextHref)).toContain("start=10");
    expect(out.peopleAlsoAsk).toEqual([
      "What keyboard do pro gamers use?",
      "Are mechanical keyboards louder?",
    ]);
  });

  it("survives renamed obfuscated hint classes (degraded, not broken)", () => {
    document.body.innerHTML = document.body.innerHTML
      .replace(/VuuXrf/g, "renamed1")
      .replace(/qLRx3b[^"]*/g, "renamed2")
      .replace(/VwiC3b/g, "renamed3")
      .replace(/<cite /g, '<div data-was-cite ')
      .replace(/<\/cite>/g, "</div>");
    try {
      const out = loadParser()({});
      const results = out.results as Array<Record<string, unknown>>;
      expect(results).toHaveLength(4);
      expect(results[0].title).toBe("The 6 Best Gaming Keyboards of 2026");
      expect(results[0].href).toContain("rtings.com");
      expect(results[0].display).toBeNull(); // hint classes gone
      // .VwiC3b renamed → snippet falls back to the div[data-sncf] container
      expect(String(results[0].snippet)).toContain("200 keyboards");
    } finally {
      document.body.innerHTML = FIXTURE.replace(/^[\s\S]*?<body>|<\/body>[\s\S]*$/g, "");
    }
  });

  it("returns an empty-but-valid parse on a page with no results", () => {
    document.body.innerHTML = "<div>not a search page</div>";
    try {
      const out = loadParser()({});
      expect(out.results).toEqual([]);
      expect(out.ads).toEqual([]);
      expect(out.hasNextPage).toBe(false);
      expect(out.nextHref).toBeNull();
    } finally {
      document.body.innerHTML = FIXTURE.replace(/^[\s\S]*?<body>|<\/body>[\s\S]*$/g, "");
    }
  });
});
