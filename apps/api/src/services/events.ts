import pg from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

type Sink = (event: string, data: unknown) => void;
const clients = new Map<string, Set<Sink>>();

export function subscribe(userId: string, sink: Sink) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(sink);
  return () => { clients.get(userId)?.delete(sink); if (!clients.get(userId)?.size) clients.delete(userId); };
}
/** Fan-out across API instances via Postgres NOTIFY. Payload kept tiny (clients re-fetch details). */
export async function emit(userIds: string[], event: string, data: Record<string, unknown> = {}) {
  const payload = JSON.stringify({ u: userIds, e: event, d: data });
  if (payload.length > 7000) return;
  await pool.query(`SELECT pg_notify('madix_events', $1)`, [payload]).catch(() => {});
}
export async function startEventBus() {
  const c = new pg.Client({ connectionString: config.DATABASE_URL });
  await c.connect();
  await c.query('LISTEN madix_events');
  c.on('notification', (m) => {
    try { const { u, e, d } = JSON.parse(m.payload!); for (const id of u) clients.get(id)?.forEach((s) => s(e, d)); } catch { /* ignore */ }
  });
  c.on('error', (e) => { console.error('event bus error', e); setTimeout(() => startEventBus().catch(() => {}), 2000); });
}
