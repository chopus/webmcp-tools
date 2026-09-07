/**
 * Instagram user-pk fetcher — runs INSIDE an instagram.com tab (evaluate,
 * MAIN world). The whole file is one function expression, so the flow runner
 * can send it verbatim as the `function` argument of the `evaluate` tool;
 * scripts and agents can do the same.
 *
 * Strategy: "pk" is not in the server-rendered HTML (verified Sep 2026: 0
 * regex hits across 23 profile pages) — it arrives in the XHR response of
 * /api/v1/users/web_profile_info. Instead of capturing network bodies (the
 * extension does not fetch them), call that endpoint from page context: the
 * fetch carries the tab's instagram.com origin and the logged-in cookies,
 * exactly like the page's own hydration call.
 *
 * args: { username: "handle" }
 * Returns (best-effort, never throws):
 * {
 *   username, pk, userId, fullName, isPrivate, isVerified, followers,
 *   ok: true
 * }
 * or { username, ok: false, reason: "not_found" | "auth" | "rate_limited" | "http_<n>" | "parse", status }
 */
(args) => {
  const username = String((args && args.username) || "");
  const APP_ID = "936619743392459"; // instagram.com web app id, public and stable
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  return fetch("/api/v1/users/web_profile_info/?username=" + encodeURIComponent(username), {
    headers: { "x-ig-app-id": APP_ID, accept: "application/json" },
    credentials: "include",
    signal: ctrl.signal
  })
    .then((res) =>
      res.json().then((body) => ({ status: res.status, body })).catch(() => ({ status: res.status, body: null }))
    )
    .catch((e) => ({ status: 0, body: null, err: String((e && e.message) || e) }))
    .then(({ status, body, err }) => {
      clearTimeout(timer);
      if (status === 404) return { username, ok: false, reason: "not_found", status };
      if (status === 401 || status === 403) return { username, ok: false, reason: "auth", status };
      if (status === 429) return { username, ok: false, reason: "rate_limited", status };
      const u = body && body.data && body.data.user;
      if (!u) return { username, ok: false, reason: status ? "parse" : "network", status, err: err ? String(err) : undefined };
      return {
        username,
        ok: true,
        pk: String(u.pk ?? u.id ?? "") || null,
        userId: u.id != null ? String(u.id) : null,
        fullName: u.full_name || null,
        isPrivate: !!u.is_private,
        isVerified: !!u.is_verified,
        followers: (u.edge_followed_by && u.edge_followed_by.count) || 0
      };
    });
}
