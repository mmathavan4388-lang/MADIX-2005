import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.js';
import { meRoutes } from './me.js';
import { publicRoutes } from './public.js';
import { fileRoutes } from './files.js';
import { aiRoutes } from './ai.js';
import { generationRoutes } from './generations.js';
import { billingRoutes } from './billing.js';
import { socialRoutes } from './social.js';
import { chatRoutes } from './chat.js';
import { adminRoutes } from './admin.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(publicRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(meRoutes);
  await app.register(fileRoutes, { prefix: '/files' });
  await app.register(aiRoutes, { prefix: '/ai' });
  await app.register(generationRoutes, { prefix: '/generations' });
  await app.register(billingRoutes, { prefix: '/billing' });
  await app.register(socialRoutes);
  await app.register(chatRoutes, { prefix: '/chat' });
  await app.register(adminRoutes, { prefix: '/admin' });
}
