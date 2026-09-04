/**
 * WebMCP Tools — screenshot pipeline.
 *
 * Visible-tab capture via chrome.tabs.captureVisibleTab, full-page via CDP
 * (see cdp.js). Both go through the same post-processing: downscale to
 * maxWidth, convert format, and keep the base64 payload under ~6MB by
 * lowering quality (jpeg) and/or resolution iteratively. Returns
 * { format, width, height, dataBase64 } with the data: prefix stripped.
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const U = NS.util;

  const MAX_BASE64_CHARS = Math.floor(6 * 1024 * 1024 * 0.95); // ~6MB guard

  function stripDataUrlPrefix(dataUrl) {
    const comma = dataUrl.indexOf(',');
    return dataUrl.slice(0, 5) === 'data:' && comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl;
  }

  async function base64ToBitmap(base64, format) {
    const bytes = U.base64ToBytes(base64);
    const blob = new Blob([bytes], { type: `image/${format}` });
    return createImageBitmap(blob);
  }

  async function encodeBitmap(bitmap, format, quality, scale) {
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (format === 'jpeg') {
      // JPEG has no alpha; flatten onto white to avoid black backgrounds.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({
      type: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      quality: format === 'jpeg' ? quality : undefined
    });
    return { base64: await U.blobToBase64(blob), width: w, height: h };
  }

  /**
   * Shared post-processing. Input: { dataUrl } or { base64 } (raw, no prefix).
   */
  async function postProcess(input, format, quality, maxWidth) {
    const base64 = input.dataUrl ? stripDataUrlPrefix(input.dataUrl) : input.base64;
    const bitmap = await base64ToBitmap(base64, format);
    let scale = bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
    let q = quality;
    let out = await encodeBitmap(bitmap, format, q, scale);
    let guard = 0;
    while (out.base64.length > MAX_BASE64_CHARS && guard < 8) {
      guard++;
      if (format === 'jpeg' && q > 15) q = Math.max(10, Math.round(q * 0.75));
      const nextScale = Math.max(0.1, scale * 0.8);
      if (nextScale === scale) break; // cannot shrink further
      scale = nextScale;
      out = await encodeBitmap(bitmap, format, q, scale);
    }
    try { bitmap.close(); } catch (e) { /* noop */ }
    return { format, width: out.width, height: out.height, dataBase64: out.base64 };
  }

  /**
   * screenshot(tab, { format?, quality?, fullPage?, maxWidth? })
   */
  async function screenshot(tab, params) {
    const format = params.format === 'jpeg' ? 'jpeg' : 'png';
    const quality = Math.min(100, Math.max(1, U.optInt(params, 'quality', 80)));
    const maxWidth = Math.max(64, U.optInt(params, 'maxWidth', 1600));
    const fullPage = U.optBool(params, 'fullPage', false);

    if (fullPage) {
      const shot = await NS.cdp.captureFullPage(tab.id, { format, quality });
      return postProcess({ base64: shot.dataBase64 }, format, quality, maxWidth);
    }

    const options = { format };
    if (format === 'jpeg') options.quality = quality;
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, options);
    } catch (e) {
      void chrome.runtime.lastError;
      throw U.err(
        `captureVisibleTab failed for window ${tab.windowId} (` +
        `${(e && e.message) || e}); the tab must be visible`,
        'EEXECUTION'
      );
    }
    return postProcess({ dataUrl }, format, quality, maxWidth);
  }

  NS.screenshot = { screenshot };
})(self);
