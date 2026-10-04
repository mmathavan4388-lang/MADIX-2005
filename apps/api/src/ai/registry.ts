import { many, pool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { builtinAdapters } from './adapters.js';
import { ProviderError, type AdapterFactory, type Capability, type ProviderRow, type AnyProvider } from './types.js';

const adapters = new Map<string, AdapterFactory>(Object.entries(builtinAdapters));
/** Plug in a new provider implementation without touching callers. */
export function registerAdapter(name: string, f: AdapterFactory) { adapters.set(name, f); }

let cache: { at: number; rows: ProviderRow[] } | null = null;
export const clearProviderCache = () => { cache = null; };

async function rows(): Promise<ProviderRow[]> {
  if (cache && Date.now() - cache.at < 10_000) return cache.rows;
  const r = await many<ProviderRow>(pool, `SELECT * FROM ai_providers WHERE enabled ORDER BY capability, priority, created_at`);
  cache = { at: Date.now(), rows: r };
  return r;
}

export async function providersFor<T extends AnyProvider>(cap: Capability): Promise<{ row: ProviderRow; impl: T }[]> {
  const out: { row: ProviderRow; impl: T }[] = [];
  for (const row of (await rows()).filter((r) => r.capability === cap)) {
    const f = adapters.get(row.adapter);
    if (!f) { console.error(`[ai] unknown adapter "${row.adapter}" for provider ${row.name}`); continue; }
    const apiKey = row.api_key_env ? process.env[row.api_key_env] : undefined;
    if (row.api_key_env && !apiKey) { console.error(`[ai] env ${row.api_key_env} not set for provider ${row.name}`); continue; }
    const impl = f(row, apiKey) as T | undefined;
    if (impl) out.push({ row, impl });
  }
  return out;
}
export const notConfigured = () => new AppError(503, 'ai_unavailable', 'This AI feature is not available right now. Please try again later.');

/** Run `fn` against providers in priority order; fail over on retryable errors. */
export async function withFailover<T extends AnyProvider, R>(cap: Capability, fn: (p: T, row: ProviderRow) => Promise<R>): Promise<R> {
  const list = await providersFor<T>(cap);
  if (!list.length) throw notConfigured();
  let last: unknown;
  for (const { impl, row } of list) {
    try { return await fn(impl, row); }
    catch (e) { last = e; if (!(e instanceof ProviderError) || !e.retryable) throw e; console.error(`[ai] ${row.name} failed, trying next`, (e as Error).message); }
  }
  throw last;
}
