/**
 * Report rendering for flow runs — pure functions from a RunRecord to
 * self-contained strings. The HTML file inlines its CSS and embeds
 * screenshots as data URLs, so a single file is the whole report.
 */
import type { RunRecord, StepRecord } from "./types.js";

const esc = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

const STATUS_LABEL: Record<StepRecord["status"], string> = {
  pass: "PASS",
  fail: "FAIL",
  soft: "SOFT-FAIL",
  skip: "SKIP",
};

/** Machine-readable report: the RunRecord as JSON (screenshots kept as base64). */
export function renderJsonReport(run: RunRecord): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

function statusBadge(status: StepRecord["status"]): string {
  return `<span class="badge badge-${status}">${STATUS_LABEL[status]}</span>`;
}

function stepCard(step: StepRecord): string {
  const parts: string[] = [];
  parts.push(
    `<div class="step step-${step.status}">` +
      `<div class="step-head">` +
        `<span class="step-index">#${step.index + 1}</span>` +
        `<span class="step-name">${esc(step.name)}</span>` +
        statusBadge(step.status) +
        `<span class="step-meta">${esc(step.tool)} · ${step.durationMs} ms` +
        (step.attempts > 1 ? ` · ${step.attempts} attempts` : "") +
        (step.section === "finally" ? ` · finally` : "") + `</span>` +
      `</div>`,
  );

  if (step.when) {
    parts.push(
      `<div class="when">when ${esc(step.when.condition)} → ` +
        (step.when.passed ? `<span class="ok">true</span>` : `<span class="muted">false (skipped)</span>`) +
        `</div>`,
    );
  }
  if (step.args !== undefined) {
    parts.push(`<details><summary>arguments</summary><pre>${esc(step.args)}</pre></details>`);
  }
  if (step.assertions && step.assertions.length > 0) {
    parts.push('<table class="asserts"><tbody>');
    for (const a of step.assertions) {
      parts.push(
        `<tr class="${a.pass ? "assert-pass" : "assert-fail"}">` +
          `<td>${a.pass ? "✓" : "✗"}</td>` +
          `<td><code>${esc(a.path)} ${esc(a.op)}${a.expected !== undefined ? ` ${esc(a.expected)}` : ""}</code></td>` +
          `<td class="actual">got <code>${esc(a.actual ?? "undefined")}</code></td>` +
        `</tr>`,
      );
    }
    parts.push("</tbody></table>");
  }
  if (step.error) {
    parts.push(`<pre class="error">${esc(step.error)}</pre>`);
  }
  if (step.result !== undefined) {
    parts.push(`<details><summary>result</summary><pre>${esc(step.result)}</pre></details>`);
  }
  if (step.screenshot) {
    parts.push(
      `<img src="data:${esc(step.screenshot.mimeType)};base64,${step.screenshot.dataBase64}" alt="screenshot: ${esc(step.name)}">`,
    );
  }
  parts.push("</div>");
  return parts.join("");
}

/** Human-readable, self-contained HTML report. */
export function renderHtmlReport(run: RunRecord): string {
  const rows = Object.entries(run.vars ?? {}).map(
    ([key, value]) =>
      `<tr><td><code>${esc(key)}</code></td><td><code>${esc(JSON.stringify(value))}</code></td></tr>`,
  );
  const varsTable = rows.length
    ? `<table class="vars"><thead><tr><th>variable</th><th>value</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(run.flow.name)} — flow report</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 52rem; padding: 1.5rem 1rem 4rem; }
  header h1 { margin: 0 0 .25rem; font-size: 1.4rem; }
  .meta { color: gray; font-size: .85rem; }
  .badge { display: inline-block; border-radius: .4rem; padding: .05rem .5rem; font-size: .75rem; font-weight: 700; }
  .badge-pass { background: #1a7f37; color: #fff; }
  .badge-fail { background: #cf222e; color: #fff; }
  .badge-soft { background: #9a6700; color: #fff; }
  .badge-skip { background: #6e7781; color: #fff; }
  .big { font-size: 1.1rem; padding: .3rem .8rem; }
  .step { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: .6rem; margin: .8rem 0; padding: .6rem .8rem; }
  .step-fail { border-color: #cf222e; }
  .step-soft { border-color: #9a6700; }
  .step-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
  .step-name { font-weight: 700; }
  .step-meta { color: gray; font-size: .8rem; margin-left: auto; }
  .step-index { color: gray; }
  pre { overflow-x: auto; background: color-mix(in srgb, currentColor 7%, transparent); border-radius: .4rem; padding: .5rem .7rem; font-size: .8rem; white-space: pre-wrap; word-break: break-word; }
  pre.error { border-left: 3px solid #cf222e; }
  details summary { cursor: pointer; color: gray; font-size: .85rem; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  .asserts td { border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); padding: .25rem .5rem; vertical-align: top; }
  .asserts td:first-child { width: 1.4rem; }
  .assert-pass td:first-child { color: #1a7f37; font-weight: 700; }
  .assert-fail td:first-child { color: #cf222e; font-weight: 700; }
  .assert-fail code { color: #cf222e; }
  td.actual { color: gray; }
  .vars td { border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); padding: .2rem .5rem; }
  img { max-width: 100%; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: .5rem; margin-top: .5rem; }
  .when { font-size: .85rem; color: gray; }
  .ok { color: #1a7f37; font-weight: 600; }
  .muted { color: gray; }
  footer { margin-top: 2rem; color: gray; font-size: .8rem; }
</style>
</head>
<body>
<header>
  <h1>Flow: ${esc(run.flow.name)} ${statusBadge(run.status).replace("badge ", "badge big ")}</h1>
  ${run.flow.description ? `<p class="meta">${esc(run.flow.description)}</p>` : ""}
  <p class="meta">
    ${esc(run.startedAt)} · ${run.durationMs} ms ·
    ${run.counts.pass} passed, ${run.counts.fail} failed, ${run.counts.soft} soft-failed, ${run.counts.skip} skipped
    ${run.browser ? ` · browser ${esc(run.browser.instanceId)}${run.browser.chromeVersion ? ` (Chrome ${esc(run.browser.chromeVersion)})` : ""}` : ""}
  </p>
  ${varsTable}
</header>
<main>
${run.steps.map(stepCard).join("\n")}
</main>
<footer>webmcp-tools flow runner — self-contained report; screenshots are embedded.</footer>
</body>
</html>
`;
}
