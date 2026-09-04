/**
 * WebMCP Tools — shared service-worker utilities (classic script, loaded via
 * importScripts from background/service-worker.js). Defines the global `WMCP`
 * namespace used by all background/lib files.
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});

  const CODES = [
    'ETAB_NOT_FOUND', 'ENO_SUCH_REF', 'ENO_SUCH_SELECTOR', 'ETIMEOUT',
    'EEXECUTION', 'EDEBUGGER', 'EWEBMCP', 'EARGS', 'ENAVIGATION'
  ];

  class ProtocolError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'ProtocolError';
      this.code = CODES.indexOf(code) >= 0 ? code : 'EEXECUTION';
    }
  }

  function err(message, code) {
    return new ProtocolError(message, code);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Race `promise` against a timeout; rejects with ETIMEOUT when it loses. */
  function withTimeout(promise, ms, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(err(message || 'operation timed out', 'ETIMEOUT')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** Best-effort JSON-safe deep copy. Returns { ok, value }. */
  function jsonSafe(value) {
    try {
      return { ok: true, value: JSON.parse(JSON.stringify(value === undefined ? null : value)) };
    } catch (e) {
      return { ok: false };
    }
  }

  // ---- param validation helpers (EARGS on bad input) -----------------------

  function reqStr(params, name) {
    const v = params ? params[name] : undefined;
    if (typeof v !== 'string' || v.length === 0) {
      throw err(`missing required string param "${name}"`, 'EARGS');
    }
    return v;
  }

  function optStr(params, name, dflt) {
    const v = params ? params[name] : undefined;
    return typeof v === 'string' && v.length > 0 ? v : dflt;
  }

  function optInt(params, name, dflt) {
    const v = params ? params[name] : undefined;
    if (v === undefined || v === null) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      throw err(`param "${name}" must be a non-negative number`, 'EARGS');
    }
    return Math.trunc(n);
  }

  function optBool(params, name, dflt) {
    const v = params ? params[name] : undefined;
    if (v === undefined || v === null) return dflt;
    return !!v;
  }

  function optStrArray(params, name, dflt) {
    const v = params ? params[name] : undefined;
    if (v === undefined || v === null) return dflt;
    if (!Array.isArray(v)) throw err(`param "${name}" must be an array of strings`, 'EARGS');
    return v.map((x) => String(x));
  }

  /** Exactly one of `names` must be present; returns the present name. */
  function reqOneOf(params, names) {
    const present = names.filter((n) => params[n] !== undefined && params[n] !== null);
    if (present.length !== 1) {
      throw err(`exactly one of ${names.join(' / ')} must be provided`, 'EARGS');
    }
    return present[0];
  }

  // ---- key parsing (shared by CDP trusted input) ---------------------------

  const NAMED_KEYS = {
    'enter': { key: 'Enter', code: 'Enter', vk: 13 },
    'return': { key: 'Enter', code: 'Enter', vk: 13 },
    'tab': { key: 'Tab', code: 'Tab', vk: 9 },
    'escape': { key: 'Escape', code: 'Escape', vk: 27 },
    'esc': { key: 'Escape', code: 'Escape', vk: 27 },
    'backspace': { key: 'Backspace', code: 'Backspace', vk: 8 },
    'delete': { key: 'Delete', code: 'Delete', vk: 46 },
    'del': { key: 'Delete', code: 'Delete', vk: 46 },
    'insert': { key: 'Insert', code: 'Insert', vk: 45 },
    'arrowleft': { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    'arrowup': { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    'arrowright': { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    'arrowdown': { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    'left': { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    'up': { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    'right': { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    'down': { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    'home': { key: 'Home', code: 'Home', vk: 36 },
    'end': { key: 'End', code: 'End', vk: 35 },
    'pageup': { key: 'PageUp', code: 'PageUp', vk: 33 },
    'pagedown': { key: 'PageDown', code: 'PageDown', vk: 34 },
    'space': { key: ' ', code: 'Space', vk: 32 },
    'shift': { key: 'Shift', code: 'ShiftLeft', vk: 16 },
    'control': { key: 'Control', code: 'ControlLeft', vk: 17 },
    'ctrl': { key: 'Control', code: 'ControlLeft', vk: 17 },
    'alt': { key: 'Alt', code: 'AltLeft', vk: 18 },
    'meta': { key: 'Meta', code: 'MetaLeft', vk: 91 },
    'cmd': { key: 'Meta', code: 'MetaLeft', vk: 91 },
    'command': { key: 'Meta', code: 'MetaLeft', vk: 91 },
    'windows': { key: 'Meta', code: 'MetaLeft', vk: 91 },
    'backquote': { key: '`', code: 'Backquote', vk: 192 },
    'minus': { key: '-', code: 'Minus', vk: 189 },
    'equal': { key: '=', code: 'Equal', vk: 187 },
    'comma': { key: ',', code: 'Comma', vk: 188 },
    'period': { key: '.', code: 'Period', vk: 190 },
    'slash': { key: '/', code: 'Slash', vk: 191 },
    'backslash': { key: '\\', code: 'Backslash', vk: 220 },
    'semicolon': { key: ';', code: 'Semicolon', vk: 186 },
    'quote': { key: "'", code: 'Quote', vk: 222 },
    'bracketleft': { key: '[', code: 'BracketLeft', vk: 219 },
    'bracketright': { key: ']', code: 'BracketRight', vk: 221 }
  };

  const PUNCT_CODES = {
    '`': { code: 'Backquote', vk: 192 }, '-': { code: 'Minus', vk: 189 },
    '=': { code: 'Equal', vk: 187 }, ',': { code: 'Comma', vk: 188 },
    '.': { code: 'Period', vk: 190 }, '/': { code: 'Slash', vk: 191 },
    '\\': { code: 'Backslash', vk: 220 }, ';': { code: 'Semicolon', vk: 186 },
    "'": { code: 'Quote', vk: 222 }, '[': { code: 'BracketLeft', vk: 219 },
    ']': { code: 'BracketRight', vk: 221 }
  };

  const MOD_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

  /**
   * Parse a key spec like "Enter", "a", "Control+A", "Shift+ArrowDown".
   * Returns { key, code, keyCode, text, modifiers: ['Control', ...], modifierBits }.
   */
  function parseKeyCombo(spec) {
    if (typeof spec !== 'string' || spec.length === 0) {
      throw err('key must be a non-empty string', 'EARGS');
    }
    if (spec === ' ') spec = 'Space';
    const parts = spec.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
    let keyPart = null;
    const modifiers = [];
    for (const part of parts) {
      const lower = part.toLowerCase();
      const mod = lower === 'control' || lower === 'ctrl' ? 'Control'
        : lower === 'shift' ? 'Shift'
        : lower === 'alt' || lower === 'option' ? 'Alt'
        : lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'windows' ? 'Meta'
        : null;
      if (mod) { modifiers.push(mod); continue; }
      keyPart = part;
    }
    if (keyPart === null) {
      if (modifiers.length === 1) {
        // Bare modifier like "Control" — synthesize a keydown of the modifier itself.
        keyPart = modifiers[0];
        modifiers.length = 0;
      } else {
        throw err(`cannot parse key spec "${spec}"`, 'EARGS');
      }
    }
    if (modifiers.length > 2) {
      throw err(`too many modifiers in key "${spec}"`, 'EARGS');
    }

    const lower = keyPart.toLowerCase();
    let out;
    if (NAMED_KEYS[lower]) {
      out = { key: NAMED_KEYS[lower].key, code: NAMED_KEYS[lower].code, keyCode: NAMED_KEYS[lower].vk };
    } else if (/^f([1-9]|1[0-2])$/i.test(lower)) {
      const n = parseInt(lower.slice(1), 10);
      out = { key: 'F' + n, code: 'F' + n, keyCode: 111 + n };
    } else if (/^[0-9]$/.test(keyPart)) {
      out = { key: keyPart, code: 'Digit' + keyPart, keyCode: 48 + Number(keyPart) };
    } else if (/^[a-z]$/i.test(keyPart)) {
      const lowerChar = keyPart.toLowerCase();
      const upperChar = keyPart.toUpperCase();
      const withShift = modifiers.indexOf('Shift') >= 0;
      out = {
        key: withShift ? upperChar : lowerChar,
        code: 'Key' + upperChar,
        keyCode: upperChar.charCodeAt(0)
      };
    } else if (keyPart.length === 1 && PUNCT_CODES[keyPart]) {
      out = { key: keyPart, code: PUNCT_CODES[keyPart].code, keyCode: PUNCT_CODES[keyPart].vk };
    } else {
      throw err(`unknown key "${keyPart}" in "${spec}"`, 'EARGS');
    }

    let modifierBits = 0;
    for (const m of modifiers) modifierBits |= MOD_BITS[m];

    // Text is produced for printable keys without ctrl/meta/alt modifiers.
    let text = '';
    if (modifierBits & ~(MOD_BITS.Shift) && modifierBits !== 0) {
      // Ctrl/Meta/Alt held — no text insertion.
      text = '';
    } else if (out.key.length === 1) {
      text = out.key;
    }
    // Shift with non-letter (e.g. Shift+1) keeps the literal key; good enough.

    return { key: out.key, code: out.code, keyCode: out.keyCode, text, modifiers, modifierBits };
  }

  // ---- misc ----------------------------------------------------------------

  /** Decode base64 to Uint8Array (chunked, no atob size surprises). */
  function base64ToBytes(b64) {
    const bin = atob(String(b64));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** Encode an ArrayBuffer/Uint8Array to base64 without stack overflow. */
  async function bytesToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function blobToBase64(blob) {
    return bytesToBase64(await blob.arrayBuffer());
  }

  NS.util = {
    ProtocolError,
    err,
    sleep,
    withTimeout,
    jsonSafe,
    reqStr,
    optStr,
    optInt,
    optBool,
    optStrArray,
    reqOneOf,
    parseKeyCombo,
    MOD_BITS,
    base64ToBytes,
    bytesToBase64,
    blobToBase64
  };
})(self);
