/**
 * WebMCP Tools — interaction tools (click / type_text / press_key / hover /
 * scroll / select_option / drag / upload_file) and `evaluate`.
 *
 * DOM mode (default): the content script locates the element (ref or
 * selector) and runs its synthetic-event interaction. Trusted mode:
 * chrome.debugger CDP input at the element's viewport-center coordinates.
 * click additionally accepts raw {x, y} viewport coordinates (always trusted
 * CDP input). Element targets resolve frame-aware: snapshot refs translate
 * through the content-bridge frame map and selectors fall back to frame
 * iteration on not-found.
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

  /**
   * Frame-aware locate: translates snapshot refs through the frame map and
   * falls back to frame iteration on not-found. `scroll:false` keeps the
   * pre-flight locate side-effect free (origin-policy submit checks).
   */
  function locate(tabId, target, scroll) {
    const msg = { type: 'locate', scroll: scroll !== false };
    if (target && target.x !== undefined) {
      msg.x = target.x;
      msg.y = target.y;
      return NS.contentBridge.askTab(tabId, msg);
    }
    return NS.contentBridge.askTargeted(tabId, msg, target);
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

  /**
   * Validate an optional {x, y} coordinate pair (viewport CSS px). Returns
   * null when neither coordinate is present; EARGS when only one is.
   */
  function optCoords(params) {
    const hasX = params.x !== undefined && params.x !== null;
    const hasY = params.y !== undefined && params.y !== null;
    if (!hasX && !hasY) return null;
    if (!hasX || !hasY) throw U.err('x and y must be provided together', 'EARGS');
    const x = Number(params.x);
    const y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw U.err('x and y must be finite numbers (viewport CSS pixels)', 'EARGS');
    }
    return { x, y };
  }

  async function click(tab, params) {
    const button = normalizeButton(params.button);
    const clickCount = U.optInt(params, 'clickCount', 1);
    const modifiers = U.optStrArray(params, 'modifiers', []);
    const coords = optCoords(params);
    if (coords) {
      if ((params.ref !== undefined && params.ref !== null) ||
          (params.selector !== undefined && params.selector !== null)) {
        throw U.err('provide one of ref / selector / x,y — not several', 'EARGS');
      }
      // Synthetic events need an element, so coordinates ALWAYS go through
      // trusted CDP input (the `trusted` flag is irrelevant here).
      await timed(params, 5000, NS.cdp.withDebugger(tab.id, (command) =>
        NS.cdp.trustedClick(command, {
          x: coords.x, y: coords.y, button, clickCount, modifiers
        })));
      return { clicked: true };
    }
    const target = pickTarget(params, 'ref', 'selector', true);
    if (U.optBool(params, 'trusted', false)) {
      const loc = await timed(params, 5000, locate(tab.id, target));
      await timed(params, 5000, NS.cdp.withDebugger(tab.id, (command) =>
        NS.cdp.trustedClick(command, {
          x: loc.x, y: loc.y, button, clickCount, modifiers
        })));
      return Object.assign({ clicked: true }, withText(loc));
    }
    const res = await timed(params, 5000, NS.contentBridge.askTargeted(tab.id,
      { type: 'click', button, clickCount, modifiers }, target));
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
    await timed(params, 10000, NS.contentBridge.askTargeted(tab.id,
      { type: 'type_text', text, clearFirst, submit }, target));
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
    await timed(params, 5000, NS.contentBridge.askTargeted(tab.id, msg, target));
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
    await timed(params, 5000, NS.contentBridge.askTargeted(tab.id, { type: 'hover' }, target));
    return { hovered: true };
  }

  async function scroll(tab, params) {
    const target = pickTarget(params, 'ref', 'selector', false);
    const direction = ['up', 'down', 'left', 'right'].indexOf(params.direction) >= 0
      ? params.direction : 'down';
    const amount = Math.max(0, U.optInt(params, 'amount', 600));
    const smooth = U.optBool(params, 'smooth', true);
    const msg = { type: 'scroll', direction, amount, smooth };
    const res = await NS.contentBridge.askTargeted(tab.id, msg, target);
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
    const res = await timed(params, 5000, NS.contentBridge.askTargeted(tab.id,
      { type: 'select_option', [which]: params[which] }, target));
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
    // DOM mode: a synthetic drag must run in ONE frame. When both refs map to
    // the same frame, send the translated local refs there; otherwise fall
    // back to the frame scan (main-frame refs are identical globally, since
    // the main frame always renumbers from base 0).
    const fromLoc = from.ref !== undefined
      ? NS.contentBridge.translateRef(tab.id, from.ref) : null;
    const toLoc = to.ref !== undefined
      ? NS.contentBridge.translateRef(tab.id, to.ref) : null;
    if (fromLoc && toLoc && fromLoc.frameId === toLoc.frameId) {
      await timed(params, 8000, NS.contentBridge.askFrame(tab.id, fromLoc.frameId, {
        type: 'drag', fromRef: fromLoc.localRef, toRef: toLoc.localRef
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
    await timed(params, 8000, NS.contentBridge.askFrames(tab.id, msg));
    return { dragged: true };
  }

  // ---- upload_file ------------------------------------------------------------
  //
  // Real file selection cannot be synthesized (no FilePicker step from page
  // JS), so the path is set directly on the <input type=file> node via CDP
  // DOM.setFileInputFiles.

  async function uploadFile(tab, params) {
    const path = U.reqStr(params, 'path');
    const target = pickTarget(params, 'ref', 'selector', true);

    // DOM.setFileInputFiles addresses the node by CSS selector; refs are
    // resolved through a locate that reports a unique cssSelector.
    let selector = target.selector;
    try {
      if (!selector) {
        const loc = await timed(params, 5000, locate(tab.id, target));
        if (!loc || !loc.cssSelector) {
          throw U.err('could not derive a CSS selector for the upload target', 'EUPLOAD');
        }
        selector = loc.cssSelector;
      }
      await timed(params, 10000, NS.cdp.withDebugger(tab.id, async (command) => {
        await command('DOM.enable', {});
        const doc = await command('DOM.getDocument', {});
        const rootId = doc && doc.root && doc.root.nodeId;
        if (!rootId) throw U.err('DOM.getDocument returned no root node', 'EUPLOAD');
        const node = await command('DOM.querySelector', { nodeId: rootId, selector });
        if (!node || !node.nodeId) {
          throw U.err(`no element matches selector "${selector}" for upload`, 'EUPLOAD');
        }
        await command('DOM.setFileInputFiles', { files: [path], nodeId: node.nodeId });
      }));
    } catch (e) {
      // upload_file failures surface as EUPLOAD (param validation above
      // already threw EARGS where appropriate).
      if (e && e.code === 'EUPLOAD') throw e;
      throw U.err(`upload_file failed (${(e && e.message) || e})`, 'EUPLOAD');
    }
    return { uploaded: true };
  }

  // ---- evaluate -------------------------------------------------------------
  //
  // Runs over CDP Runtime.evaluate (NS.cdp.cdpEvaluate): `new Function`-style
  // evaluation via chrome.scripting is blocked in ISOLATED worlds by the
  // extension's MV3 CSP and in MAIN worlds by the page's CSP.

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

    let argsJson;
    try {
      argsJson = JSON.stringify(argsVal);
    } catch (e) {
      throw U.err('args is not JSON-serializable', 'EARGS');
    }
    const expression = '(' + fnSrc + ')(' + argsJson + ')';

    let res;
    try {
      res = await U.withTimeout(
        NS.cdp.cdpEvaluate(tab.id, expression, { world, awaitPromise }),
        timeoutMs,
        `evaluate timed out after ${timeoutMs}ms`
      );
    } catch (e) {
      if (e && e.code) throw e;
      throw U.err(
        `evaluate failed in tab ${tab.id} (${(e && e.message) || e})`,
        'EEXECUTION'
      );
    }

    const out = { result: null, exception: null };
    if (res && res.exceptionDetails) {
      const d = res.exceptionDetails;
      out.exception =
        (d.exception && (d.exception.description || d.exception.value)) ||
        d.text ||
        'evaluation threw';
      out.exception = String(out.exception).split('\n').slice(0, 6).join('\n');
      return out;
    }
    const r = res && res.result;
    if (!r || r.type === 'undefined' || r.type === 'function' || r.type === 'symbol' ||
        r.subtype === 'node' || r.subtype === 'error') {
      return out; // { result: null, exception: null }
    }
    out.result = r.value !== undefined ? r.value : null;
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
    uploadFile,
    evaluate,
    locate
  };
})(self);
