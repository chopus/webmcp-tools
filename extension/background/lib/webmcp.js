/**
 * WebMCP Tools — WebMCP discovery + execution in the page's MAIN world via
 * chrome.scripting.executeScript({ world: "MAIN" }).
 *
 * Discovery: document.modelContext.getTools() when available (native or
 * polyfilled), else window.__webmcp_registered_tools + declarative
 * form[toolname] elements. Execution prefers modelContext.executeTool, with a
 * declarative-form fallback that fills fields and submits.
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const U = NS.util;

  const POLYFILL_FILES = ['lib/webmcp-polyfill.js'];

  /**
   * MAIN-world discovery function (must be fully self-contained).
   * Returns { supported, polyfilled, mode, tools }.
   */
  async function webmcpDiscoverFn() {
    const clean = (t) => {
      if (!t || typeof t !== 'object' || typeof t.name !== 'string') return null;
      const o = { name: t.name };
      if (typeof t.title === 'string') o.title = t.title;
      if (typeof t.description === 'string') o.description = t.description;
      try {
        const s = JSON.stringify(t.inputSchema);
        if (s !== undefined) o.inputSchema = JSON.parse(s);
      } catch (e) { /* drop non-serializable schema */ }
      if (typeof t.origin === 'string') o.origin = t.origin;
      try {
        if (t.annotations && typeof t.annotations === 'object') {
          const s = JSON.stringify(t.annotations);
          if (s !== undefined) o.annotations = JSON.parse(s);
        }
      } catch (e) { /* drop */ }
      return o;
    };
    // Declarative form tools — mirrors webmcp-polyfill.js derivation.
    const formTools = () => {
      const tools = [];
      const forms = document.querySelectorAll('form[toolname]');
      for (const form of forms) {
        const name = form.getAttribute('toolname') || '';
        if (!name) continue;
        const properties = {};
        const required = [];
        const elements = form.querySelectorAll('input[name], select[name], textarea[name]');
        for (const el of elements) {
          const propName = el.name;
          const propDesc = el.getAttribute('toolparamdescription') || '';
          let type = 'string';
          let enumValues;
          if (el.tagName === 'SELECT') {
            type = 'string';
            enumValues = Array.from(el.options).map((opt) => opt.value || opt.text);
          } else if (el.type === 'number' || el.type === 'range') {
            type = 'number';
          } else if (el.type === 'checkbox') {
            type = 'boolean';
          }
          const property = { type: type };
          if (propDesc) property.description = propDesc;
          if (enumValues) property.enum = enumValues;
          properties[propName] = property;
          if (el.hasAttribute('required')) required.push(propName);
        }
        const inputSchema = { type: 'object', properties: properties };
        if (required.length > 0) inputSchema.required = required;
        tools.push({
          name: name,
          description: form.getAttribute('tooldescription') || '',
          inputSchema: inputSchema,
          origin: location.origin
        });
      }
      return tools;
    };

    const supported = !!(document.modelContext);
    const polyfilled = !!(window.__webmcp_registered_tools);
    let tools = [];
    if (supported) {
      try {
        const list = await document.modelContext.getTools();
        for (const t of list || []) {
          const c = clean(t);
          if (c) tools.push(c);
        }
      } catch (e) { /* fall through with empty list */ }
    } else {
      if (polyfilled && window.__webmcp_registered_tools &&
          typeof window.__webmcp_registered_tools.values === 'function') {
        try {
          for (const t of window.__webmcp_registered_tools.values()) {
            const c = clean(t);
            if (c) tools.push(c);
          }
        } catch (e) { /* ignore */ }
      }
      tools = tools.concat(formTools());
    }
    let mode = 'none';
    if (polyfilled) mode = 'polyfill';
    else if (supported) mode = 'native';
    else if (tools.length > 0) mode = 'declarative';
    return { supported: supported, polyfilled: polyfilled, mode: mode, tools: tools };
  }

  /**
   * MAIN-world execution function (self-contained). Finds the tool by name
   * and runs it; returns { ok, result } or { ok: false, error }.
   */
  async function webmcpExecuteFn(name, args) {
    const jsonSafe = (v) => {
      try {
        return { serializable: true, value: JSON.parse(JSON.stringify(v === undefined ? null : v)) };
      } catch (e) {
        return { serializable: false };
      }
    };
    const callArgs = (args && typeof args === 'object') ? args : {};

    if (document.modelContext && typeof document.modelContext.executeTool === 'function') {
      let tool = null;
      try {
        const tools = await document.modelContext.getTools();
        tool = (tools || []).find((t) => t && t.name === name) || null;
      } catch (e) { /* lookup failure falls through to the stub */ }
      if (!tool) tool = { name: name, description: '' }; // polyfill resolves by name
      const raw = await document.modelContext.executeTool(tool, callArgs);
      const safe = jsonSafe(raw);
      return safe.serializable
        ? { ok: true, result: safe.value }
        : { ok: true, result: null };
    }

    if (window.__webmcp_registered_tools &&
        typeof window.__webmcp_registered_tools.has === 'function' &&
        window.__webmcp_registered_tools.has(name)) {
      const registered = window.__webmcp_registered_tools.get(name);
      const fn = registered && registered._execute;
      const raw = typeof fn === 'function' ? await fn(callArgs) : null;
      const safe = jsonSafe(raw);
      return safe.serializable
        ? { ok: true, result: safe.value }
        : { ok: true, result: null };
    }

    // Declarative form fallback (no modelContext on this page).
    const esc = String(name).replace(/["\\]/g, '\\$&');
    const form = document.querySelector(`form[toolname="${esc}"]`);
    if (!form) {
      return { ok: false, error: `WebMCP tool "${name}" not found on this page` };
    }
    for (const key of Object.keys(callArgs)) {
      let value = callArgs[key];
      const el = (form.elements && form.elements[key]) ||
        form.querySelector(`[name="${key}"]`);
      if (!el) continue;
      try {
        if (el.type === 'checkbox') {
          el.checked = !!value;
        } else if (el.type === 'radio') {
          const radio = form.querySelector(
            `input[name="${key}"][value="${String(value).replace(/["\\]/g, '\\$&')}"]`);
          if (radio) radio.checked = true;
        } else if (el.tagName === 'SELECT') {
          el.value = value === null || value === undefined ? '' : String(value);
        } else {
          if ((el.type === 'number' || el.type === 'range') && value !== '' &&
              value !== null && value !== undefined && typeof value !== 'number') {
            const n = Number(value);
            if (Number.isFinite(n)) value = n;
          }
          el.value = value === null || value === undefined ? '' : String(value);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) { /* keep filling the rest */ }
    }
    let submitted = false;
    try {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      submitted = true;
    } catch (e) { /* submission failed; report below */ }
    // Optional result marker: <form toolname="…" data-toolresult="sel" />
    // (or bare toolresult attr) selecting an element whose text is the result.
    let marker;
    const sel = form.getAttribute('data-toolresult') || form.getAttribute('toolresult');
    if (sel) {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const target = document.querySelector(sel);
        if (target && (target.textContent || '').trim()) {
          marker = (target.textContent || '').trim().slice(0, 2000);
          break;
        }
      }
    }
    if (!submitted) return { ok: false, error: `form for tool "${name}" could not be submitted` };
    return { ok: true, result: marker !== undefined ? marker : { submitted: true } };
  }

  async function runInMain(tabId, func, args) {
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func,
        args
      });
    } catch (e) {
      throw U.err(
        `MAIN-world execution failed in tab ${tabId} (${(e && e.message) || e})`,
        'EWEBMCP'
      );
    }
    const result = results && results[0] && results[0].result;
    if (result === undefined || result === null) {
      throw U.err('WebMCP page function returned nothing', 'EWEBMCP');
    }
    return result;
  }

  /** list_webmcp_tools(tab, { injectPolyfill? }) */
  async function listTools(tab, params) {
    const injectPolyfill = U.optBool(params, 'injectPolyfill', false);
    let res = await runInMain(tab.id, webmcpDiscoverFn, []);
    if (injectPolyfill && !res.supported) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          files: POLYFILL_FILES
        });
      } catch (e) {
        throw U.err(
          `polyfill injection failed in tab ${tab.id} (${(e && e.message) || e})`,
          'EWEBMCP'
        );
      }
      res = await runInMain(tab.id, webmcpDiscoverFn, []);
    }
    return { supported: !!res.supported, mode: res.mode || 'none', tools: res.tools || [] };
  }

  /** call_webmcp_tool(tab, { name, args?, timeoutMs? }) -> { ok: true, result } */
  async function callTool(tab, params) {
    const name = U.reqStr(params, 'name');
    let callArgs = params.args;
    if (callArgs === undefined || callArgs === null) callArgs = {};
    if (typeof callArgs !== 'object' || Array.isArray(callArgs)) {
      throw U.err('args must be an object', 'EARGS');
    }
    const timeoutMs = Math.max(250, U.optInt(params, 'timeoutMs', 30000));
    const res = await U.withTimeout(
      runInMain(tab.id, webmcpExecuteFn, [name, callArgs]),
      timeoutMs,
      `WebMCP tool "${name}" timed out after ${timeoutMs}ms`
    );
    if (res.ok === false) {
      throw U.err(res.error || `WebMCP tool "${name}" failed`, 'EWEBMCP');
    }
    return { ok: true, result: res.result === undefined ? null : res.result };
  }

  NS.webmcp = { listTools, callTool };
})(self);
