import { DEFAULT_PROXIES } from '../config';

const STORE_KEY = 'ma-proxy-ok';
const TIMEOUT_MS = 15000;

function overrides(): string[] {
  const out: string[] = [];
  try {
    const q = new URLSearchParams(location.search).get('proxy');
    if (q) out.push(q);
  } catch { /* ignore */ }
  const env = import.meta.env.VITE_CORS_PROXY as string | undefined;
  if (env) out.push(...env.split(',').map(s => s.trim()).filter(Boolean));
  return out;
}

export const PROXIES: string[] = [...new Set([...overrides(), ...DEFAULT_PROXIES])];

let working: number | null = (() => {
  try {
    const v = sessionStorage.getItem(STORE_KEY);
    return v != null && PROXIES[+v] ? +v : null;
  } catch { return null; }
})();

export function proxied(template: string, url: string) {
  return template.replace('{url}', encodeURIComponent(url)).replace('{raw}', url);
}

export function proxyHost(): string | null {
  if (working == null) return null;
  try { return new URL(proxied(PROXIES[working], 'https://x/')).host; } catch { return null; }
}

async function tryOne(template: string, url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const host = (() => { try { return new URL(proxied(template, url)).host; } catch { return template; } })();
  try {
    const r = await fetch(proxied(template, url), { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`${host}: HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`${host}: timeout`);
    throw (e as Error).message.startsWith(host) ? e : new Error(`${host}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function remember(i: number) {
  if (working === i) return;
  working = i;
  try { sessionStorage.setItem(STORE_KEY, String(i)); } catch { /* ignore */ }
}

/**
 * GET a Mosquito Alert API URL through a CORS proxy. Uses the proxy that worked
 * last; otherwise races all of them and remembers the fastest that answers.
 */
export async function apiGet<T>(url: string, validate: (j: unknown) => boolean = () => true): Promise<T> {
  url = url.replace(/^http:\/\//, 'https://');
  const attempt = async (i: number) => {
    const j = await tryOne(PROXIES[i], url);
    if (!validate(j)) throw new Error(`unexpected response from ${PROXIES[i]}`);
    return { i, j: j as T };
  };
  if (working != null) {
    try {
      return (await attempt(working)).j;
    } catch {
      working = null;
    }
  }
  try {
    const { i, j } = await Promise.any(PROXIES.map((_, i) => attempt(i)));
    remember(i);
    return j;
  } catch (e) {
    const errs = e instanceof AggregateError ? e.errors : [e];
    throw new Error(`all CORS proxies failed (${errs.map(x => (x as Error).message).join('; ')})`);
  }
}
