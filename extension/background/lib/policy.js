/**
 * WebMCP Tools — origin policy: storage (chrome.storage.local key
 * "originPolicy"), host-pattern matching, and enforcement in front of the
 * request router.
 *
 * Policy shape:
 *   { mode: "allowlist"|"denylist", allowlist: [hostPattern],
 *     denylist: [hostPattern], sensitive: [hostPattern],
 *     requireConfirmOnSubmit: boolean }
 *
 * Host patterns: "*" matches everything; otherwise a case-insensitive
 * hostname match where "example.com" / "*.example.com" matches example.com
 * AND any subdomain (leading "*." is stripped, then suffix-with-boundary).
 *
 * Enforcement (wrapDispatch, applied by router.js): ACTION tools check the
 * target origin before their handler runs — allow/deny gating plus a
 * confirm:true requirement for form submits on sensitive origins.
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const U = NS.util;

  const STORAGE_KEY = 'originPolicy';
  const LIST_KEYS = ['allowlist', 'denylist', 'sensitive'];

  // Tools whose target origin is checked before dispatch (TOOL CONTRACT §2).
  const ACTION_TOOLS = new Set([
    'navigate', 'new_tab', 'new_window', 'click', 'type_text', 'press_key',
    'hover', 'scroll', 'select_option', 'drag', 'evaluate', 'upload_file',
    'call_webmcp_tool', 'get_cookies', 'get_dialog', 'handle_dialog'
  ]);

  // Tools resolved from params.url (everything else resolves via the tab).
  const URL_TOOLS = new Set(['navigate', 'new_tab', 'new_window', 'get_cookies']);

  const DEFAULT_POLICY = {
    mode: 'allowlist',
    allowlist: ['*'],
    denylist: [],
    sensitive: [],
    requireConfirmOnSubmit: true
  };

  let cachedPolicy = copyPolicy(DEFAULT_POLICY);
  let loaded = false; // storage read done (until then the default applies)

  function copyPolicy(p) {
    return JSON.parse(JSON.stringify(p));
  }

  /** Coerce a stored/partial value into the full policy shape. */
  function normalizePolicy(raw) {
    if (!raw || typeof raw !== 'object') return copyPolicy(DEFAULT_POLICY);
    const out = {
      mode: raw.mode === 'denylist' ? 'denylist' : 'allowlist',
      allowlist: [],
      denylist: [],
      sensitive: [],
      requireConfirmOnSubmit: raw.requireConfirmOnSubmit !== false
    };
    for (const key of LIST_KEYS) {
      if (Array.isArray(raw[key])) out[key] = raw[key].map((x) => String(x));
    }
    return out;
  }

  async function load() {
    let stored = null;
    try {
      stored = await chrome.storage.local.get(STORAGE_KEY);
    } catch (e) {
      stored = null;
    }
    cachedPolicy = normalizePolicy(stored && stored[STORAGE_KEY]);
    loaded = true;
    return copyPolicy(cachedPolicy);
  }

  /** Current policy (deep copy); reads storage once, then serves the cache. */
  async function getPolicy() {
    if (!loaded) return load();
    return copyPolicy(cachedPolicy);
  }

  /** Merge PARTIAL fields into the stored policy and persist the result. */
  async function setPolicy(partial) {
    if (!partial || typeof partial !== 'object') {
      throw U.err('set_origin_policy requires policy fields to merge', 'EARGS');
    }
    if (partial.mode !== undefined && partial.mode !== null &&
        ['allowlist', 'denylist'].indexOf(partial.mode) < 0) {
      throw U.err('mode must be "allowlist" or "denylist"', 'EARGS');
    }
    for (const key of LIST_KEYS) {
      const v = partial[key];
      if (v === undefined || v === null) continue;
      if (!Array.isArray(v)) {
        throw U.err(`param "${key}" must be an array of host patterns`, 'EARGS');
      }
    }
    const next = await getPolicy();
    if (partial.mode === 'allowlist' || partial.mode === 'denylist') {
      next.mode = partial.mode;
    }
    for (const key of LIST_KEYS) {
      const v = partial[key];
      if (v !== undefined && v !== null) next[key] = v.map((x) => String(x));
    }
    if (partial.requireConfirmOnSubmit !== undefined &&
        partial.requireConfirmOnSubmit !== null) {
      next.requireConfirmOnSubmit = !!partial.requireConfirmOnSubmit;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    cachedPolicy = copyPolicy(next);
    loaded = true;
    return copyPolicy(cachedPolicy);
  }

  // Keep the cache fresh when the policy changes elsewhere (another worker
  // lifetime, or a set_origin_policy on a parallel connection).
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        cachedPolicy = normalizePolicy(changes[STORAGE_KEY].newValue);
        loaded = true;
      }
    });
  } catch (e) {
    /* storage.onChanged unavailable — get/set still refresh the cache */
  }

  // ---- host-pattern matching -------------------------------------------------

  function hostMatchesPattern(host, pattern) {
    const h = String(host || '').toLowerCase();
    let p = String(pattern == null ? '' : pattern).toLowerCase().trim();
    if (!h || !p) return false;
    if (p === '*') return true;
    if (p.slice(0, 2) === '*.') p = p.slice(2);
    return h === p || h.slice(-(p.length + 1)) === '.' + p;
  }

  function matchesAny(host, patterns) {
    for (const p of patterns || []) {
      if (hostMatchesPattern(host, p)) return true;
    }
    return false;
  }

  // ---- origin resolution ------------------------------------------------------

  /** Hostname of a non-empty http(s) url; null when unusable (skip the check). */
  function urlHost(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.hostname;
    } catch (e) {
      return null;
    }
  }

  async function resolveTabSafe(tabId) {
    try {
      return await NS.tabs.resolveTab(tabId);
    } catch (e) {
      return null; // the handler surfaces its own tab error
    }
  }

  // ---- sensitive-origin submit confirmation ----------------------------------

  function confirmRequired(host) {
    return U.err(
      `submit on sensitive origin "${host}" requires confirm:true`,
      'ECONFIRM_REQUIRED'
    );
  }

  /** The click targeting triple, without pickTarget's EARGS strictness. */
  function clickTarget(params) {
    if (params.ref !== undefined && params.ref !== null) return { ref: params.ref };
    if (params.selector !== undefined && params.selector !== null) {
      return { selector: params.selector };
    }
    if (params.x !== undefined && params.x !== null &&
        params.y !== undefined && params.y !== null) {
      const x = Number(params.x);
      const y = Number(params.y);
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }
    return null;
  }

  async function confirmCheck(tool, params, host, tab) {
    if (tool === 'type_text' && U.optBool(params, 'submit', false)) {
      throw confirmRequired(host);
    }
    if (tool === 'press_key') {
      const combo = U.parseKeyCombo(U.reqStr(params, 'key')); // EARGS on bad specs
      if (combo.key === 'Enter') throw confirmRequired(host);
      return;
    }
    if (tool === 'click' && tab) {
      const target = clickTarget(params);
      if (!target) return; // click itself will fail validation downstream
      try {
        // Pre-flight locate; only paid on sensitive origins without confirm.
        const loc = await U.withTimeout(
          NS.automation.locate(tab.id, target, false),
          5000,
          'origin-policy submit check timed out'
        );
        if (loc && loc.formSubmit) throw confirmRequired(host);
      } catch (e) {
        if (e && e.code === 'ECONFIRM_REQUIRED') throw e;
        // The locate failed (element gone / bad selector / timeout) — the
        // click handler will produce its own error; do not block on the
        // pre-flight.
      }
    }
  }

  // ---- enforcement -------------------------------------------------------------

  async function enforce(tool, params) {
    if (!ACTION_TOOLS.has(tool)) return;
    const p = params || {};
    const policy = await getPolicy();

    let host = null;
    let tab = null;
    if (URL_TOOLS.has(tool)) {
      host = urlHost(p.url);
    } else {
      tab = await resolveTabSafe(p.tabId);
      host = tab ? urlHost(tab.url) : null; // empty/about:blank/missing -> allow
    }
    if (!host) return;

    if (policy.mode === 'denylist') {
      if (matchesAny(host, policy.denylist)) {
        throw U.err(
          `origin "${host}" is blocked by the origin policy (mode=${policy.mode})`,
          'EORIGIN_POLICY'
        );
      }
    } else if (!matchesAny(host, policy.allowlist)) {
      throw U.err(
        `origin "${host}" is blocked by the origin policy (mode=${policy.mode})`,
        'EORIGIN_POLICY'
      );
    }

    if (policy.requireConfirmOnSubmit && matchesAny(host, policy.sensitive) &&
        p.confirm !== true) {
      await confirmCheck(tool, p, host, tab);
    }
  }

  /**
   * Wrap WMCP.router.dispatch so ACTION tools run the origin-policy check
   * before their handler. router.js applies this at load time.
   */
  function wrapDispatch(inner) {
    return async function dispatch(tool, params) {
      await enforce(tool, params);
      return inner(tool, params);
    };
  }

  NS.policy = {
    getPolicy,
    setPolicy,
    hostMatchesPattern,
    matchesAny,
    enforce,
    wrapDispatch
  };
})(self);
