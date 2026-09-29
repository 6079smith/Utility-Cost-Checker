// Cloudflare Worker that keeps your Claude API key off family phones.
//
//   POST /read-meter       photo → { registers: [{label, digits, value}], meter_kind, unit, confidence, notes }
//   GET  /octopus/v1/...   read-only pass-through to api.octopus.energy (CORS fallback)
//
// Secrets (set with `npx wrangler secret put NAME`):
//   ANTHROPIC_API_KEY  your Claude API key
//   ACCESS_CODE        any passphrase; the app sends it so strangers can't spend your credit
// Vars (wrangler.toml):
//   ALLOWED_ORIGIN     your GitHub Pages origin, e.g. https://you.github.io

import Anthropic from '@anthropic-ai/sdk';
import { meterRequest, parseMeterResponse } from '../../src/meterPrompt.js';

const MAX_IMAGE_BASE64 = 7_000_000; // ~5 MB decoded

export default {
  async fetch(request, env) {
    const cors = {
      'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-access-code',
      'access-control-max-age': '86400',
      vary: 'origin',
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname.startsWith('/octopus/v1/')) {
      const upstream = 'https://api.octopus.energy' + url.pathname.slice('/octopus'.length) + url.search;
      const res = await fetch(upstream, { cf: { cacheTtl: 3600, cacheEverything: true } });
      return new Response(res.body, {
        status: res.status,
        headers: { ...cors, 'content-type': res.headers.get('content-type') || 'application/json' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/read-meter') {
      if (env.ACCESS_CODE && request.headers.get('x-access-code') !== env.ACCESS_CODE) {
        return json({ error: 'Wrong access code. Check Settings → Photo reading.' }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid request.' }, 400);
      }
      const { imageBase64, mediaType, fuel, economy7, previous } = body;
      if (typeof imageBase64 !== 'string' || !imageBase64 || imageBase64.length > MAX_IMAGE_BASE64) {
        return json({ error: 'Photo missing or too large.' }, 400);
      }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaType) || !['electricity', 'gas'].includes(fuel)) {
        return json({ error: 'Invalid request.' }, 400);
      }

      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      try {
        const response = await client.beta.messages.create(
          meterRequest({
            imageBase64,
            mediaType,
            fuel,
            economy7: economy7 === true,
            // A short description such as "day 12345, night 6789".
            previous: typeof previous === 'string' ? previous.slice(0, 80) : typeof previous === 'number' ? String(previous) : null,
          }),
        );
        return json(parseMeterResponse(response));
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError) return json({ error: 'Busy right now. Try again in a minute.' }, 429);
        if (err instanceof Anthropic.AuthenticationError) return json({ error: 'The helper’s API key is invalid.' }, 502);
        if (err instanceof Anthropic.APIError) return json({ error: `Claude API error ${err.status ?? ''}` }, 502);
        return json({ error: err.message || 'Couldn’t read the meter.' }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};
