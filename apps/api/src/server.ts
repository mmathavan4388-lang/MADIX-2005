import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startEventBus } from './services/events.js';

const app = await buildApp();
if (config.NODE_ENV !== 'production') await migrate(app.log.info.bind(app.log));
await startEventBus();
await app.listen({ port: config.PORT, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); await pool.end(); process.exit(0); });
