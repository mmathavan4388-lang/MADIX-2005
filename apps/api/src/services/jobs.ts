import { pool, tx, one, Q } from '../db/pool.js';

export type JobType = 'image' | 'video' | 'promo' | 'photo_edit' | 'video_edit' | 'video_postprocess';

export async function enqueue(c: Q, type: JobType, userId: string | null, payload: Record<string, unknown>, maxAttempts = 3) {
  return (await one(c, `INSERT INTO jobs(type, user_id, payload, max_attempts) VALUES ($1,$2,$3,$4) RETURNING id`, [type, userId, payload, maxAttempts])).id as string;
}

export interface ClaimedJob { id: string; type: JobType; user_id: string | null; payload: any; attempts: number; max_attempts: number; external_id: string | null; cancel_requested: boolean; }

/** Claim one due job. SKIP LOCKED lets any number of workers pull concurrently without double-processing. */
export async function claim(types?: JobType[]): Promise<ClaimedJob | null> {
  return tx(async (c) => {
    const j = await one<ClaimedJob>(c, `SELECT id FROM jobs WHERE status='queued' AND run_at <= now() AND ($1::text[] IS NULL OR type = ANY($1))
      ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1`, [types ?? null]);
    if (!j) return null;
    return one<ClaimedJob>(c, `UPDATE jobs SET status='processing', locked_at=now(), attempts=attempts+1 WHERE id=$1 RETURNING *`, [j.id]);
  });
}
export const requeue = (id: string, delaySec: number, patch: { progress?: number; payload?: any; externalId?: string } = {}, countAttempt = false) =>
  pool.query(`UPDATE jobs SET status='queued', locked_at=NULL, run_at = now() + make_interval(secs => $2), progress = COALESCE($3, progress),
    payload = COALESCE($4, payload), external_id = COALESCE($5, external_id), attempts = attempts - $6 WHERE id=$1`,
    [id, delaySec, patch.progress ?? null, patch.payload ?? null, patch.externalId ?? null, countAttempt ? 0 : 1]);

/** Re-queue jobs whose worker died mid-flight. */
export async function recoverStuck() {
  const r = await pool.query(`UPDATE jobs SET status='queued', locked_at=NULL, run_at=now() WHERE status='processing' AND locked_at < now() - interval '10 minutes' AND attempts < max_attempts`);
  await pool.query(`UPDATE jobs SET status='failed', error='worker lost', finished_at=now() WHERE status='processing' AND locked_at < now() - interval '10 minutes' AND attempts >= max_attempts`);
  return r.rowCount;
}
export const backoffSec = (attempts: number) => Math.min(300, 5 * 2 ** attempts);
