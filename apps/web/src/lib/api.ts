export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, any> = {}) { super(message); }
}

type Scope = 'user' | 'admin';
const store = (s: Scope) => (s === 'admin' ? sessionStorage : localStorage);
const K = (s: Scope) => (s === 'admin' ? 'madix_admin_tokens' : 'madix_tokens');

export interface Tokens { accessToken: string; refreshToken: string }
export function getTokens(s: Scope = 'user'): Tokens | null { try { return JSON.parse(store(s).getItem(K(s)) ?? 'null'); } catch { return null; } }
export function setTokens(t: Tokens | null, s: Scope = 'user') { try { t ? store(s).setItem(K(s), JSON.stringify(t)) : store(s).removeItem(K(s)); } catch { /* storage blocked */ } window.dispatchEvent(new Event('madix-auth')); }

const refreshing: Partial<Record<Scope, Promise<boolean>>> = {};
async function refresh(scope: Scope): Promise<boolean> {
  return (refreshing[scope] ??= (async () => {
    const t = getTokens(scope); if (!t) return false;
    try {
      const r = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refreshToken }) });
      if (!r.ok) { setTokens(null, scope); return false; }
      const j = await r.json(); setTokens({ accessToken: j.accessToken, refreshToken: j.refreshToken }, scope); return true;
    } catch { return false; } finally { setTimeout(() => delete refreshing[scope], 0); }
  })());
}

export interface Opts { method?: string; body?: unknown; scope?: Scope; signal?: AbortSignal; auth?: boolean }
export async function api<T = any>(path: string, o: Opts = {}): Promise<T> {
  const scope = o.scope ?? 'user';
  const run = async () => {
    const t = getTokens(scope);
    const headers: Record<string, string> = {};
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (t && o.auth !== false) headers.Authorization = `Bearer ${t.accessToken}`;
    return fetch(`/api/v1${path}`, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined, signal: o.signal });
  };
  let res: Response;
  try { res = await run(); } catch (e) { if ((e as Error).name === 'AbortError') throw e; throw new ApiError(0, 'network', 'network'); }
  if (res.status === 401 && o.auth !== false && getTokens(scope) && (await refresh(scope))) res = await run();
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new ApiError(res.status, j?.error?.code ?? 'error', j?.error?.message ?? 'Something went wrong.', j?.error ?? {});
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

/** Stream a server-sent-events POST (AI chat). Aborting the signal = "Stop generating". */
export async function streamPost(path: string, body: unknown, onEvent: (event: string, data: any) => void, signal: AbortSignal) {
  const doFetch = () => fetch(`/api/v1${path}`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getTokens()?.accessToken}` }, body: JSON.stringify(body ?? {}) });
  let res = await doFetch();
  if (res.status === 401 && (await refresh('user'))) res = await doFetch();
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new ApiError(res.status, j?.error?.code ?? 'error', j?.error?.message ?? 'Something went wrong.', j?.error ?? {}); }
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /event: (\w+)/.exec(chunk)?.[1]; const data = /data: (.*)/.exec(chunk)?.[1];
      if (ev && data) onEvent(ev, JSON.parse(data));
    }
  }
}

/** Direct-to-storage upload: init → PUT to signed URL → complete (server validates the bytes). */
export async function uploadFile(file: Blob & { name?: string }, purpose: string, scope: Scope = 'user', onProgress?: (p: number) => void) {
  const init = await api<{ fileId: string; upload: { url: string; method: string; headers: Record<string, string> } }>('/files/init', { body: { purpose, mime: file.type, size: file.size }, scope });
  await new Promise<void>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(init.upload.method, init.upload.url);
    for (const [k, v] of Object.entries(init.upload.headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? resolve() : reject(new ApiError(x.status, 'upload_failed', 'Upload failed. Please try again.')));
    x.onerror = () => reject(new ApiError(0, 'network', 'network'));
    x.send(file);
  });
  const done = await api<{ file: any }>(`/files/${init.fileId}/complete`, { method: 'POST', body: {}, scope });
  return { id: init.fileId, file: done.file };
}

export const fmtMoney = (minor: number, currency = 'INR') => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
export const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
export const timeAgo = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now'; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`; if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString();
};
