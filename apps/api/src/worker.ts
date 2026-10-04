import { config } from './config.js';
import { pool, one } from './db/pool.js';
import { claim, requeue, recoverStuck, backoffSec, type ClaimedJob } from './services/jobs.js';
import { handlers, Cancelled } from './worker/handlers.js';
import { finishGeneration } from './services/generate.js';
import { ProviderError } from './ai/types.js';
import { sweepReferrals } from './services/referrals.js';
import { runMaintenance } from './worker/maintenance.js';

let running = 0, stopping = false;

export async function processJob(job: ClaimedJob) {
  try {
    await handlers[job.type](job);
  } catch (e: any) {
    const genId = job.payload?.generationId as string | undefined;
    if (e instanceof Cancelled) { if (genId) await finishGeneration(genId, { status: 'cancelled' }); return; }
    console.error(`[worker] job ${job.id} (${job.type}) attempt ${job.attempts} failed:`, e?.message);
    const retryable = !(e instanceof ProviderError) || e.retryable;
    if (retryable && job.attempts < job.max_attempts) { await requeue(job.id, backoffSec(job.attempts), {}, true); return; }
    if (genId) await finishGeneration(genId, { status: 'failed', error: 'The AI service could not complete this request.' });
    else await pool.query(`UPDATE jobs SET status='failed', error=$2, finished_at=now() WHERE id=$1`, [job.id, String(e?.message).slice(0, 300)]);
  }
}

async function loop() {
  while (!stopping) {
    if (running >= config.WORKER_CONCURRENCY) { await sleep(300); continue; }
    const job = await claim().catch((e) => { console.error('[worker] claim error', e); return null; });
    if (!job) { await sleep(1000); continue; }
    running++;
    void processJob(job).finally(() => running--);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  console.log(`MADIX worker started (concurrency ${config.WORKER_CONCURRENCY})`);
  setInterval(() => { recoverStuck().catch(console.error); sweepReferrals().catch(console.error); runMaintenance().catch(console.error); }, 60_000);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { stopping = true; while (running) await sleep(200); await pool.end(); process.exit(0); });
  void one; void loop();
}
