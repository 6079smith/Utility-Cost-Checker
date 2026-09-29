// Reads a meter photo with Claude, via the helper Worker (recommended: the key
// stays on the server) or directly with the user's own API key.

import { meterRequest, parseMeterResponse } from './meterPrompt.js';

const MAX_EDGE = 1568;

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

export async function readMeter({ image, fuel, previous, ai }) {
  if (ai.mode === 'helper') {
    const res = await fetch(ai.helperUrl.replace(/\/$/, '') + '/read-meter', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-code': ai.accessCode || '' },
      body: JSON.stringify({ imageBase64: image.base64, mediaType: image.mediaType, fuel, previous }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Meter reader returned ${res.status}`);
    return body;
  }
  if (ai.mode === 'own-key') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ai.apiKey, dangerouslyAllowBrowser: true });
    try {
      const response = await client.beta.messages.create(
        meterRequest({ imageBase64: image.base64, mediaType: image.mediaType, fuel, previous }),
      );
      return parseMeterResponse(response);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('Your Claude API key was rejected. Check it in Settings.');
      if (err instanceof Anthropic.RateLimitError) throw new Error('Too many requests. Wait a minute and try again.');
      if (err instanceof Anthropic.APIError) throw new Error(`Claude API error ${err.status ?? ''}: ${err.message}`);
      throw err;
    }
  }
  throw new Error('Photo reading isn’t set up. Enter the reading manually, or set it up in Settings.');
}
