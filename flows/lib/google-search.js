/**
 * Google search-result parser — runs INSIDE the page (evaluate, MAIN world).
 *
 * The whole file is one function expression, so the flow runner can send it
 * verbatim as the `function` argument of the `evaluate` tool: the extension
 * evaluates `(<file contents>)(args)`. Tests load it the same way against a
 * fixture page (server/test/fixtures/google-serp.html).
 *
 * Selector strategy: structural anchors first (#search, a-with-h3, #bres,
 * #pnnext, #result-stats), obfuscated class names (.VwiC3b, .VuuXrf) only as
 * hints inside a known result block. Google renames those classes at any
 * time; a renamed hint degrades the field to null, it never breaks the parse.
 * Selectors verified against a live SERP captured in September 2026.
 *
 * Returns (all fields best-effort, never throws):
 * {
 *   url, query, page,
 *   resultsTotalText,                    // "About 74.000.000 results (0,40s)"
 *   results: [ { position, title, href, display, snippet } ],   // organic
 *   ads:      [ { title, href, display } ],
 *   peopleAlsoAsk:   [ "…", … ],         // may be empty
 *   relatedSearches: [ "…", … ],
 *   hasNextPage, nextHref
 * }
 */
(args) => {
  const root = document.querySelector("#search") || document.querySelector("#rso") || document.body;
  const q = (sel, scope) => (scope || document).querySelector(sel);
  const qa = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));
  const txt = (el) => {
    if (!el) return "";
    const raw = el.innerText || el.textContent || "";
    return raw.replace(/\s+/g, " ").trim();
  };
  const param = (name) => {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  };

  const inAds = (el) => !!el.closest("#tads, #tadsb, #taw, #bottomads, [data-text-ad]");
  // "People also ask" and other non-organic blocks also use a-with-h3 entries.
  const inPaa = (el) =>
    !!el.closest('div[data-initq], g-accordion-expander, div[jsname="Cpkphb"]');

  // Snippet/description lives next to the anchor (div[data-sncf]) — walk up
  // from the anchor until a level contains a description element. Two guards
  // keep attribution honest: stop at the results root, and stop as soon as a
  // level also contains a DIFFERENT result anchor — past that point the
  // snippet belongs to a sibling result (seen live with video rows).
  const snippetOf = (anchor) => {
    let block = anchor;
    while (block && block !== root) {
      const hit = q(".VwiC3b", block) || q('div[data-sncf="1"]', block);
      if (hit) return txt(hit);
      block = block.parentElement;
      if (!block || block === root) break;
      const foreignAnchor = qa("a", block).some((a) => a !== anchor && a.querySelector("h3"));
      if (foreignAnchor) return "";
    }
    return "";
  };

  const toEntry = (anchor, position) => ({
    position,
    title: txt(anchor.querySelector("h3")),
    href: anchor.getAttribute("href") ? anchor.href : null,
    display: txt(anchor.querySelector("cite")) || txt(anchor.querySelector(".VuuXrf")) || null,
  });

  const resultAnchors = qa("a", root).filter(
    (a) => a.querySelector("h3") && !inAds(a) && !inPaa(a) && txt(a.querySelector("h3")),
  );
  const adAnchors = qa("a", document).filter((a) => a.querySelector("h3") && inAds(a));

  const nextLink = q("#pnnext") || q('a[aria-label*="Page 2"]');

  return {
    url: location.href,
    query: param("q"),
    page: param("start") ? Math.floor(Number(param("start")) / 10) + 1 : 1,
    resultsTotalText: txt(q("#result-stats")) || null,
    results: resultAnchors.map((a, i) => ({ ...toEntry(a, i + 1), snippet: snippetOf(a) || null })),
    ads: adAnchors.map((a, i) => toEntry(a, i + 1)),
    peopleAlsoAsk: qa('div[data-initq] [role="heading"], div[data-initq] .Y0iuFc')
      .map(txt)
      .filter(Boolean),
    relatedSearches: qa("#bres a")
      .map(txt)
      .filter(Boolean),
    hasNextPage: !!nextLink,
    nextHref: nextLink && nextLink.getAttribute("href") ? nextLink.href : null,
  };
}
