import { pool, Q } from '../db/pool.js';

export async function audit(actorId: string | null, action: string, target?: string, meta: Record<string, unknown> = {}, ipHash?: string, q: Q = pool) {
  await q.query('INSERT INTO audit_logs(actor_id, action, target, meta, ip_hash) VALUES ($1,$2,$3,$4,$5)', [actorId, action, target ?? null, meta, ipHash ?? null]);
}
export async function track(userId: string | null, name: string, props: Record<string, unknown> = {}) {
  await pool.query('INSERT INTO analytics_events(user_id, name, props) VALUES ($1,$2,$3)', [userId, name, props]).catch(() => {});
}
