/**
 * WebMCP Tools — native dialog (alert / confirm / prompt / beforeunload)
 * support via the chrome.debugger CDP attachment.
 *
 * ensureWatch(tabId) attaches the debugger persistently (state.dialogWatch in
 * lib/cdp.js holds the attach open, mirroring the network-capture hold) and
 * enables Page events, so Page.javascriptDialogOpening / Closed are seen even
 * though they fire outside any withDebugger call. A per-tab autoDismiss flag
 * accepts dialogs the moment they open; handle() blindly answers whatever
 * dialog is currently open (it works even if the opening event was missed).
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const U = NS.util;

  // tabId -> { autoDismiss: boolean, dialog: object|null }
  const watched = new Map();

  function send(tabId, method, params) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) reject(new Error(lastErr.message || 'CDP command failed'));
        else resolve(result);
      });
    });
  }

  chrome.debugger.onEvent.addListener((source, method, params) => {
    try {
      if (!source || typeof source.tabId !== 'number') return;
      const w = watched.get(source.tabId);
      if (!w) return;
      if (method === 'Page.javascriptDialogOpening') {
        w.dialog = {
          type: params.type || '',
          message: params.message || '',
          defaultValue: params.defaultPrompt || '',
          ts: Date.now()
        };
        if (w.autoDismiss) {
          // Fire-and-forget accept; javascriptDialogClosed clears the record.
          chrome.debugger.sendCommand(
            { tabId: source.tabId },
            'Page.handleJavaScriptDialog',
            { accept: true },
            () => { void chrome.runtime.lastError; }
          );
        }
      } else if (method === 'Page.javascriptDialogClosed') {
        w.dialog = null;
      }
    } catch (e) {
      /* event listeners must never throw */
    }
  });

  chrome.debugger.onDetach.addListener((source) => {
    if (source && typeof source.tabId === 'number') watched.delete(source.tabId);
  });

  chrome.tabs.onRemoved.addListener((tabId) => watched.delete(tabId));

  /**
   * Attach the debugger for the tab and keep it attached (Page events only
   * arrive while attached). Idempotent per tab.
   */
  async function ensureWatch(tabId) {
    let w = watched.get(tabId);
    if (w) return w;
    w = { autoDismiss: false, dialog: null };
    watched.set(tabId, w); // registered before Page.enable: no event gap
    try {
      await NS.cdp.withDebugger(tabId, async (command, state) => {
        await command('Page.enable', {});
        state.dialogWatch = true; // hold the attachment for dialog events
      });
    } catch (e) {
      watched.delete(tabId);
      throw U.err(
        `cannot watch dialogs in tab ${tabId} (${(e && e.message) || e})`,
        'EDEBUGGER'
      );
    }
    return w;
  }

  /**
   * Answer the currently open dialog. Returns {handled:true} on success and
   * {handled:false} when CDP reports that no dialog is open.
   */
  async function handleDialog(tabId, accept, promptText, autoDismiss) {
    const w = await ensureWatch(tabId);
    if (autoDismiss !== undefined && autoDismiss !== null) {
      w.autoDismiss = !!autoDismiss;
    }
    const params = { accept: accept !== false };
    if (promptText !== undefined && promptText !== null) {
      params.promptText = String(promptText);
    }
    let handled = true;
    try {
      await send(tabId, 'Page.handleJavaScriptDialog', params);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/no dialog/i.test(msg)) {
        handled = false;
      } else {
        throw U.err(`cannot handle dialog in tab ${tabId} (${msg})`, 'EDEBUGGER');
      }
    }
    if (handled) w.dialog = null; // javascriptDialogClosed confirms async
    return { handled, open: !!w.dialog, autoDismiss: !!w.autoDismiss };
  }

  NS.dialogs = { ensureWatch, handleDialog };
})(self);
