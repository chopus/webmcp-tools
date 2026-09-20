/**
 * Reddit extension-injection counter — runs INSIDE the page (evaluate, MAIN
 * world). The flow runner sends this file verbatim as the `function` argument
 * of the `evaluate` tool, so it is one function expression.
 *
 * Counts <shreddit-post> elements and the buttons another extension injected
 * next to each post's action row. Reddit renders posts as open shadow roots,
 * so the pill selector is searched through the composed tree (shadow roots
 * recursively), which plain document.querySelectorAll cannot reach — the same
 * technique snapshot uses, kept here as the page-side half of the smoke test.
 *
 * args: { pillSelector: CSS selector for the injected control }
 * Returns (never throws): {
 *   url, title,
 *   posts: number,        // <shreddit-post> elements in the light DOM
 *   pills: number,        // matches inside any open shadow root OR light DOM
 *   pillsPerPost: number  // pills / posts, 0 when no posts
 * }
 */
(args) => {
  const selector = (args && args.pillSelector) || "[data-postsaver-pill]";

  // Depth-first over element + its open shadow roots (slots are transparent:
  // assigned nodes also appear in the light DOM walk of the host document).
  const countComposed = (root, sel) => {
    let n = 0;
    try {
      n += root.querySelectorAll(sel).length;
    } catch (e) { /* invalid selector — reported by the 0 count */ }
    let hosts;
    try {
      hosts = root.querySelectorAll("*");
    } catch (e) {
      return n;
    }
    for (const el of hosts) {
      if (el.shadowRoot) n += countComposed(el.shadowRoot, sel);
    }
    return n;
  };

  const posts = document.querySelectorAll("shreddit-post").length;
  const pills = countComposed(document, selector);

  return {
    url: location.href,
    title: document.title || "",
    posts,
    pills,
    pillsPerPost: posts > 0 ? Math.round((pills / posts) * 100) / 100 : 0
  };
}
