// Reads meter photos and bills with Claude, via the helper Worker (recommended:
// the key stays on the server) or directly with the user's own API key.

import { meterRequest, billRequest, parseMeterResponse, createMeterMessage, friendlyApiError } from './meterPrompt.js';

const MAX_EDGE = 1568;
const MAX_PDF_BYTES = 5 * 1024 * 1024;

/** Downscale + re-encode to JPEG so uploads are small and fast on mobile data. */
export async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { dataUrl, base64: dataUrl.split(',')[1], mediaType: 'image/jpeg' };
}

export function aiAvailable(ai) {
  return (ai.mode === 'helper' && !!ai.helperUrl) || (ai.mode === 'own-key' && !!ai.apiKey);
}

/** Send one request via the helper (`path` + `body`) or, with an own key, `params` directly. */
async function ask(ai, path, body, params) {
  if (ai.mode === 'helper') {
    const res = await fetch(ai.helperUrl.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-code': ai.accessCode || '' },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (res.status === 404 && path === '/read-bill') {
      throw new Error('Your photo helper needs updating to read bills. Re-deploy it (see README), or type the prices in.');
    }
    if (!res.ok) throw new Error(out.error || `Helper returned ${res.status}`);
    return out;
  }
  if (ai.mode === 'own-key') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ai.apiKey, dangerouslyAllowBrowser: true });
    try {
      return parseMeterResponse(await createMeterMessage(client, params));
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw new Error(friendlyApiError(err));
      throw err;
    }
  }
  throw new Error('Photo reading isn’t set up. Enter it manually, or set it up in Settings.');
}

export function readMeter({ image, fuel, economy7 = false, previous, ai }) {
  const body = { imageBase64: image.base64, mediaType: image.mediaType, fuel, economy7, previous };
  return ask(ai, '/read-meter', body, meterRequest(body));
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Read tariff prices from a bill photo or PDF. */
export async function readBill({ file, ai }) {
  let body;
  if (file.type === 'application/pdf') {
    if (file.size > MAX_PDF_BYTES) throw new Error('That PDF is over 5 MB. Try a photo of the page with the prices instead.');
    body = { fileBase64: toBase64(await file.arrayBuffer()), mediaType: 'application/pdf' };
  } else {
    const image = await prepareImage(file);
    body = { fileBase64: image.base64, mediaType: image.mediaType };
  }
  return ask(ai, '/read-bill', body, billRequest(body));
}
