/**
 * Instagram profile-id extractor — runs INSIDE the page (evaluate, MAIN world).
 *
 * The whole file is one function expression, so the flow runner can send it
 * verbatim as the `function` argument of the `evaluate` tool: the extension
 * evaluates `(<file contents>)(args)`. Tests load it the same way against a
 * fixture page.
 *
 * Strategy: Instagram's server-rendered profile HTML embeds its data payloads
 * in <script type="application/json"> blocks. The document the browser keeps
 * after hydration still contains them, so a regex over the serialized DOM is
 * enough — no extra network round trip, no debugger attach.
 *
 * Keys scanned (both plain and backslash-escaped, because nested JSON shows
 * up as \\"key\\":\\"value\\" inside outer strings):
 *   - "profile_id":"<digits>"  — the profile owner's user id, once per payload
 *   - "pk":"<digits>"          — ids of the profile owner, posts, reels, stories
 *   - "pk":<digits>            — same key in newer payloads that omit quotes
 *
 * Returns (all fields best-effort, never throws):
 * {
 *   url, title, notFound, loginWall,
 *   htmlLength,
 *   profileId: { value, unique, total },
 *   pk:        { quoted: {first, unique, total}, numeric: {first, unique, total}, matchesProfileId },
 *   ogTitle, ogDescription
 * }
 */
(args) => {
  const html = document.documentElement.outerHTML;

  // Dead handles get a 404 shell ("Page not found") that contains no ids —
  // say so up front instead of regex-scraping ~700 KB of nothing.
  if (/^\s*page not found/i.test(document.title || "")) {
    return {
      url: location.href,
      title: document.title,
      notFound: true,
      loginWall: false,
      htmlLength: html.length,
      profileId: { value: null, unique: [], total: 0 },
      pk: { quoted: { first: null, unique: [], total: 0 }, numeric: { first: null, total: 0 }, matchesProfileId: false },
      ogTitle: null,
      ogDescription: null
    };
  }

  const collect = (re) => {
    const out = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(html)) !== null) out.push(m[1]);
    return out;
  };
  const uniq = (arr) => Array.from(new Set(arr));

  const profileIdAll = collect(/"profile_id":"(\d+)"/g)
    .concat(collect(/\\"profile_id\\":\\"(\d+)\\"/g));

  const pkQuoted = collect(/"pk":"(\d+)"/g)
    .concat(collect(/\\"pk\\":\\"(\d+)\\"/g));
  const pkNumeric = collect(/"pk":(\d+)/g)
    .concat(collect(/\\"pk\\":(\d+)/g));

  const meta = (sel) => {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute("content") || el.textContent || null) : null;
  };

  const profileIdUnique = uniq(profileIdAll);
  const pkQuotedUnique = uniq(pkQuoted);

  return {
    url: location.href,
    title: document.title,
    notFound: false,
    loginWall: /\/accounts\/login|\/challenge\//.test(location.href),
    htmlLength: html.length,
    profileId: {
      value: profileIdUnique[0] || null,
      unique: profileIdUnique.slice(0, 5),
      total: profileIdAll.length
    },
    pk: {
      quoted: {
        first: pkQuotedUnique[0] || null,
        unique: pkQuotedUnique.slice(0, 5),
        total: pkQuoted.length
      },
      numeric: {
        first: uniq(pkNumeric)[0] || null,
        total: pkNumeric.length
      },
      matchesProfileId: pkQuotedUnique.includes(profileIdUnique[0])
    },
    ogTitle: meta('meta[property="og:title"]'),
    ogDescription: meta('meta[property="og:description"]')
  };
}
