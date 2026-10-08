// Minimal CORS proxy for the Mosquito Alert API, as a Cloudflare Worker
// (free tier: 100k requests/day). Only GET requests to api.mosquitoalert.com
// are forwarded, so it can't be abused as an open proxy.
//
// Deploy: dash.cloudflare.com → Workers → Create → paste this file → Deploy.
// Then set the repo variable CORS_PROXY to  https://<name>.<you>.workers.dev/?url={url}
//
// Optionally restrict ALLOWED_ORIGINS to your Pages origin.

const UPSTREAM = 'https://api.mosquitoalert.com/';
const ALLOWED_ORIGINS = ['*']; // e.g. ['https://corneliusroemer.github.io', 'http://localhost:5173']
const CACHE_SECONDS = 60;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allow = ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : null;
    const cors = {
      'Access-Control-Allow-Origin': allow || 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' || !allow) return new Response('Forbidden', { status: 403, headers: cors });

    const target = new URL(request.url).searchParams.get('url') || '';
    if (!target.startsWith(UPSTREAM)) return new Response('Only api.mosquitoalert.com is proxied', { status: 400, headers: cors });

    const cache = caches.default;
    const key = new Request(target);
    let res = await cache.match(key);
    if (!res) {
      const up = await fetch(target, { headers: { Accept: 'application/json' } });
      res = new Response(up.body, up);
      res.headers.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
      if (up.ok) ctx.waitUntil(cache.put(key, res.clone()));
    }
    res = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};
