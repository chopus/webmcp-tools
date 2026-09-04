/**
 * WebMCP Tools — interaction tools (click / type_text / press_key / hover /
 * scroll / select_option / drag) and `evaluate`.
 *
 * DOM mode (default): the content script locates the element (ref or
 * selector) and runs its synthetic-event interaction. Trusted mode:
 * chrome.debugger CDP input at the element's viewport-center coordinates.
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const U = NS.util;

  /**
   * Validate/extract a targeting pair. `required=false` lets tools like
   * press_key/scroll work without an explicit element.
   */
  function pickTarget(params, refName, selName, required) {
    const hasRef = params[refName] !== undefined && params[refName] !== null;
    const hasSel = params[selName] !== undefined && params[selName] !== null;
    if (hasRef && hasSel) {
      throw U.err(`provide either ${refName} or ${selName}, not both`, 'EARGS');
    }
    if (!hasRef && !hasSel) {
      if (required) throw U.err(`one of ${refName} or ${selName} is required`, 'EARGS');
      return null;
    }
    if (hasRef) {
      const ref = params[refName];
      if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 1) {
        throw U.err(`${refName} must be a positive integer ref from snapshot`, 'EARGS');
      }
      return { ref };
    }
    if (typeof params[selName] !== 'string' || params[selName].length === 0) {
      throw U.err(`${selName} must be a non-empty CSS selector`, 'EARGS');
    }
    return { selector: params[selName] };
  }

  function normalizeButton(button) {
    return button === 'right' || button === 'middle' ? button : 'left';
  }

  async function locate(tabId, target) {
    const res = await NS.contentBridge.askTab(tabId, { type: 'locate', scroll: true, ...target });
    return res;
  }

  function withText(loc) {
    const out = { tag: loc.tag };
    if (loc.text !== undefined && loc.text !== null && loc.text !== '') out.text = loc.text;
    return out;
  }

  // ---- handlers (each takes the resolved `tab` + raw params) ----------------

  /** Apply the per-tool timeoutMs as an internal cap (ETIMEOUT). */
  function timed(params, dfltMs, promise) {
    const ms = Math.max(250, U.optInt(params, 'timeoutMs', dfltMs));
    return U.withTimeout(promise, ms, `tool timed out after ${ms}ms`);
  }

  async function click(tab, params) {
    const target = pickTarget(params, 'ref', 'selector', true);
    const button = normalizeButton(params.button);
    const clickCount = U.optInt(params, 'clickCount', 1);
    const modifiers = U.optStrArray(params, 'modifiers', []);
    if (U.optBool(params, 'trusted', false)) {
      const loc = await timed(params, 5000, locate(tab.id, target));
      await timed(params, 5000, NS.cdp.withDebugger(tab.id, (command) =>
        NS.cdp.trustedClick(command, {
          x: loc.x, y: loc.y, button, clickCount, modifiers
        })));
      return Object.assign({ clicked: true }, withText(loc));
    }
    const res = await timed(params, 5000, NS.contentBridge.askTab(tab.id, Object.assign(
      { type: 'click', button, clickCount, modifiers }, target)));
    return Object.assign({ clicked: true }, withText(res));
  }

  async function typeText(tab, params) {
    const target = pickTarget(params, 'ref', 'selector', true);
    const text = U.reqStr(params, 'text');
    const clearFirst = U.optBool(params, 'clearFirst', true);
    const submit = U.optBool(params, 'submit', false);
    if (U.optBool(params, 'trusted', false)) {
      const loc = await timed(params, 10000, locate(tab.id, target));
      await timed(params, 10000, NS.cdp.withDebugger(tab.id, async (command) => {
        // Focus the field, then select-all + delete when clearing.
        await NS.cdp.trustedClick(command, {
          x: loc.x, y: loc.y, button: 'left', clickCount: 1, modifiers: []
        });
        if (clearFirst) {
          await NS.cdp.trustedKeyCombo(command, U.parseKeyCombo('Control+A'));
          await NS.cdp.trustedKeyCombo(command, U.parseKeyCombo('Delete'));
        }
        await NS.cdp.trustedType(command, text);
        if (submit) await NS.cdp.trustedKeyCombo(command, U.parseKeyCombo('Enter'));
      }));
      return { typed: true };
    }
    await timed(params, 10000, NS.contentBridge.askTab(tab.id, Object.assign(
      { type: 'type_text', text, clearFirst, submit }, target)));
    return { typed: true };
  }

  async function pressKey(tab, params) {
    const key = U.reqStr(params, 'key');
    const combo = U.parseKeyCombo(key); // EARGS on unparsable specs
    const target = pickTarget(params, 'ref', 'selector', false);
    if (U.optBool(params, 'trusted', false)) {
      let loc = null;
      if (target) loc = await timed(params, 5000, locate(tab.id, target));
      await timed(params, 5000, NS.cdp.withDebugger(tab.id, async (command) => {
        if (loc) {
          await NS.cdp.trustedClick(command, {
            x: loc.x, y: loc.y, button: 'left', clickCount: 1, modifiers: []
          });
        }
        await NS.cdp.trustedKeyCombo(command, combo);
      }));
      return { pressed: true };
    }
    const msg = { type: 'press_key', key };
    if (target) Object.assign(msg, target);
    await timed(params, 5000, NS.contentBridge.askTab(tab.id, msg));
    return { pressed: true };
  }

  async function hover(tab, params) {
    const target = pickTarget(params, 'ref', 'selector', true);
    const res = await timed(params, 5000, locate(tab.id, target));
    // Hovering is a pure mouse-move; no trusted flag needed (CDP move equals
    // synthetic move for hover CSS), but honor trusted for consistency.
    if (U.optBool(params, 'trusted', false)) {
      await timed(params, 5000, NS.cdp.withDebugger(tab.id, (command) =>
        NS.cdp.trustedMouseMove(command, res.x, res.y, 0)));
      return { hovered: true };
    }
    await timed(params, 5000, NS.contentBridge.askTab(tab.id, Object.assign({ type: 'hover' }, target)));
    return { hovered: true };
  }

  async function scroll(tab, params) {
    const target = pickTarget(params, 'ref', 'selector', false);
    const direction = ['up', 'down', 'left', 'right'].indexOf(params.direction) >= 0
      ? params.direction : 'down';
    const amount = Math.max(0, U.optInt(params, 'amount', 600));
    const smooth = U.optBool(params, 'smooth', true);
    const msg = { type: 'scroll', direction, amount, smooth };
    if (target) Object.assign(msg, target);
    const res = await NS.contentBridge.askTab(tab.id, msg);
    return { scrollX: res.scrollX, scrollY: res.scrollY };
  }

  async function selectOption(tab, params) {
    const target = pickTarget(params, 'ref', 'selector', true);
    const which = U.reqOneOf(params, ['value', 'label', 'index']);
    if (which === 'index') {
      const idx = params.index;
      if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
        throw U.err('index must be a non-negative integer', 'EARGS');
      }
    }
    const res = await timed(params, 5000, NS.contentBridge.askTab(tab.id, Object.assign(
      { type: 'select_option', [which]: params[which] }, target)));
    if (!Array.isArray(res.selected)) {
      throw U.err('select_option got an invalid response', 'EEXECUTION');
    }
    return { selected: res.selected.map((v) => String(v)) };
  }

  async function drag(tab, params) {
    const from = pickTarget(params, 'fromRef', 'fromSelector', true);
    const to = pickTarget(params, 'toRef', 'toSelector', true);
    if (U.optBool(params, 'trusted', false)) {
      const fromLoc = await timed(params, 8000, locate(tab.id, from));
      const toLoc = await timed(params, 8000, locate(tab.id, to));
      await timed(params, 8000, NS.cdp.withDebugger(tab.id, async (command) => {
        await NS.cdp.trustedMouseMove(command, fromLoc.x, fromLoc.y, 0);
        await NS.cdp.trustedClick(command, {
          x: fromLoc.x, y: fromLoc.y, button: 'left', clickCount: 1, modifiers: []
        });
        // Chrome's input pipeline interpolates between moves; several steps
        // keeps drag-over detection reliable.
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          const x = fromLoc.x + ((toLoc.x - fromLoc.x) * i) / steps;
          const y = fromLoc.y + ((toLoc.y - fromLoc.y) * i) / steps;
          await NS.cdp.trustedMouseMove(command, x, y, 1);
        }
        await NS.cdp.trustedMouseMove(command, toLoc.x, toLoc.y, 1);
        await command('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: toLoc.x, y: toLoc.y, button: 'left',
          buttons: 0, clickCount: 1, modifiers: 0, pointerType: 'mouse'
        });
      }));
      return { dragged: true };
    }
    const msg = {
      type: 'drag',
      [from.ref !== undefined ? 'fromRef' : 'fromSelector']:
        from.ref !== undefined ? from.ref : from.selector,
      [to.ref !== undefined ? 'toRef' : 'toSelector']:
        to.ref !== undefined ? to.ref : to.selector
    };
    await timed(params, 8000, NS.contentBridge.askTab(tab.id, msg));
    return { dragged: true };
  }

  // ---- evaluate -------------------------------------------------------------

  /**
   * ISOLATED/MAIN world evaluation wrapper (serialized into the page).
   * Chrome awaits the returned promise and delivers the plain object below.
   */
  async function evaluateWrapper(src, args, awaitPromise) {
    const out = { result: null, exception: null };
    let fn = null;
    try {
      // eslint-disable-next-line no-eval
      fn = (0, eval)('(' + src + ')');
    } catch (e) {
      out.exception = 'SyntaxError: ' + ((e && e.message) || String(e));
      return out;
    }
    if (typeof fn !== 'function') {
      out.exception = 'the provided function string did not evaluate to a function';
      return out;
    }
    try {
      let value = fn(args);
      if (awaitPromise && value && typeof value.then === 'function') {
        value = await value;
      }
      try {
        out.result = JSON.parse(JSON.stringify(value === undefined ? null : value));
      } catch (e) {
        out.result = null;
        out.exception = 'non-serializable result';
      }
    } catch (e) {
      out.result = null;
      out.exception = e && e.stack ? String(e.stack) : String(e);
    }
    return out;
  }

  async function evaluate(tab, params) {
    const fnSrc = U.reqStr(params, 'function');
    let argsVal = params.args;
    if (argsVal === undefined || argsVal === null) argsVal = {};
    if (typeof argsVal !== 'object' || Array.isArray(argsVal)) {
      throw U.err('args must be an object', 'EARGS');
    }
    const world = params.world === 'ISOLATED' ? 'ISOLATED' : 'MAIN';
    const awaitPromise = U.optBool(params, 'awaitPromise', true);
    const timeoutMs = Math.max(100, U.optInt(params, 'timeoutMs', 10000));

    let results;
    try {
      results = await U.withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world,
          func: evaluateWrapper,
          args: [fnSrc, argsVal, awaitPromise]
        }),
        timeoutMs,
        `evaluate timed out after ${timeoutMs}ms`
      );
    } catch (e) {
      if (e && e.code === 'ETIMEOUT') throw e;
      void chrome.runtime.lastError;
      throw U.err(
        `executeScript failed in tab ${tab.id} (${(e && e.message) || e})`,
        'EEXECUTION'
      );
    }
    const injected = results && results[0] && results[0].result;
    if (!injected || typeof injected !== 'object') {
      throw U.err('evaluate returned no usable result', 'EEXECUTION');
    }
    const out = { result: injected.result === undefined ? null : injected.result };
    if (injected.exception) out.exception = String(injected.exception);
    return out;
  }

  NS.automation = {
    click,
    typeText,
    pressKey,
    hover,
    scroll,
    selectOption,
    drag,
    evaluate
  };
})(self);
