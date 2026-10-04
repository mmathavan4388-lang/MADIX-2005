import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { resetDb, makeApp, signup, drain, bal } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { clearProviderCache } from '../src/ai/registry.js';

// A tiny fake of the OpenAI-compatible and Anthropic wire protocols, so the REAL adapters are exercised end-to-end.
let server: http.Server; let base = ''; const seen: { path: string; auth?: string; body: any }[] = [];
let app: FastifyInstance; let png: Buffer;

beforeAll(async () => {
  png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#22D3EE' } }).png().toBuffer();
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks); const isJson = (req.headers['content-type'] ?? '').includes('json'); const body = isJson && raw.length ? JSON.parse(raw.toString()) : {};
      seen.push({ path: req.url!, auth: (req.headers.authorization ?? req.headers['x-api-key']) as string | undefined, body });
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const t of ['Open', 'AI', ' style']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else if (req.url === '/v1/messages') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const t of ['Claude', ' style']) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })}\n\n`);
        res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      } else if (req.url === '/v1/images/generations') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: Array.from({ length: body.n }, () => ({ b64_json: png.toString('base64') })) }));
      } else if (req.url === '/v1/videos') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'job-77' })); }
      else if (req.url === '/v1/videos/job-77') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'processing', progress: 40 })); }
      else if (req.url === '/v1/fail/chat/completions') { res.writeHead(500); res.end('secret internal failure details'); }
      else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((r) => server.listen(0, r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  await resetDb(); app = await makeApp();
  process.env.TEST_TEXT_KEY = 'sk-test-text'; process.env.TEST_IMG_KEY = 'sk-test-img'; process.env.TEST_ANTH_KEY = 'sk-ant-test';
});
afterAll(async () => { server.close(); await app.close(); });

describe('real provider adapters against a protocol fake', () => {
  it('openai-compatible: streams chat, sends the key from env (never from DB), generates images stored in cloud storage', async () => {
    await pool.query(`INSERT INTO ai_providers(capability,name,adapter,model,base_url,api_key_env) VALUES ('text','oa-text','openai-compatible','gpt-test',$1,'TEST_TEXT_KEY'),('image','oa-img','openai-compatible','img-test',$1,'TEST_IMG_KEY')`, [base]);
    clearProviderCache();
    const u = await signup(app);
    const conv = (await app.inject({ method: 'POST', url: '/api/v1/ai/conversations', headers: u.auth, payload: {} })).json();
    const res = await app.inject({ method: 'POST', url: `/api/v1/ai/conversations/${conv.id}/messages`, headers: u.auth, payload: { content: 'hi there' } });
    expect(res.body).toContain('Open'); expect(res.body).toContain('event: done');
    const chatCall = seen.find((s) => s.path === '/v1/chat/completions')!;
    expect(chatCall.auth).toBe('Bearer sk-test-text'); expect(chatCall.body.model).toBe('gpt-test'); expect(chatCall.body.stream).toBe(true);
    expect(chatCall.body.messages[0].role).toBe('system'); expect(chatCall.body.messages.at(-1).content).toBe('hi there');
    const stored = (await pool.query(`SELECT content, provider FROM ai_messages WHERE role='assistant'`)).rows[0]; expect(stored).toEqual({ content: 'OpenAI style', provider: 'oa-text' });

    const g = await app.inject({ method: 'POST', url: '/api/v1/generations/image', headers: u.auth, payload: { prompt: 'a cyan square', variations: 2, aspect: '16:9' } });
    expect(g.statusCode).toBe(202); await drain();
    const imgCall = seen.find((s) => s.path === '/v1/images/generations')!; expect(imgCall.body).toMatchObject({ n: 2, size: '1536x864', model: 'img-test' }); expect(imgCall.auth).toBe('Bearer sk-test-img');
    const done = (await app.inject({ method: 'GET', url: `/api/v1/generations/${g.json().id}`, headers: u.auth })).json();
    expect(done.status).toBe('completed'); expect(done.files).toHaveLength(2);
  });
  it('anthropic adapter speaks the Messages streaming protocol', async () => {
    await pool.query(`UPDATE ai_providers SET enabled=false WHERE capability='text'`);
    await pool.query(`INSERT INTO ai_providers(capability,name,adapter,model,base_url,api_key_env) VALUES ('text','anth','anthropic','claude-test',$1,'TEST_ANTH_KEY')`, [base.replace('/v1', '')]); clearProviderCache();
    const u = await signup(app); const conv = (await app.inject({ method: 'POST', url: '/api/v1/ai/conversations', headers: u.auth, payload: {} })).json();
    const res = await app.inject({ method: 'POST', url: `/api/v1/ai/conversations/${conv.id}/messages`, headers: u.auth, payload: { content: 'hello' } });
    expect(res.body).toContain('Claude'); const call = seen.filter((s) => s.path === '/v1/messages').at(-1)!;
    expect(call.auth).toBe('sk-ant-test'); expect(call.body.system).toContain('MADIX AI'); expect(call.body.messages.every((m: any) => m.role !== 'system')).toBe(true);
  });
  it('fails over to the next provider when the first errors (retryable), without leaking provider internals', async () => {
    await pool.query(`UPDATE ai_providers SET enabled=false WHERE capability='text'`);
    await pool.query(`INSERT INTO ai_providers(capability,name,adapter,model,base_url,api_key_env,priority) VALUES ('text','broken','openai-compatible','m',$1,'TEST_TEXT_KEY',10),('text','backup','openai-compatible','m2',$2,'TEST_TEXT_KEY',20)`, [base.replace('/v1', '/v1x'), base]); clearProviderCache();
    await pool.query(`UPDATE ai_providers SET base_url=$1 WHERE name='broken'`, [base + '/fail']); clearProviderCache();
    const u = await signup(app); const conv = (await app.inject({ method: 'POST', url: '/api/v1/ai/conversations', headers: u.auth, payload: {} })).json();
    const res = await app.inject({ method: 'POST', url: `/api/v1/ai/conversations/${conv.id}/messages`, headers: u.auth, payload: { content: 'failover please' } });
    expect(res.statusCode).toBe(200); expect(res.body).not.toContain('secret internal'); expect(res.body).toContain('Open'); void bal;
    expect((await pool.query(`SELECT provider FROM ai_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1`)).rows[0].provider).toBe('backup');
  });
  it('http-async-video adapter submits and polls using configurable endpoint shapes', async () => {
    await pool.query(`INSERT INTO ai_providers(capability,name,adapter,model,base_url,api_key_env,config) VALUES ('video','vid','http-async-video','v1',$1,'TEST_IMG_KEY','{"submitPath":"/videos","statusPath":"/videos/{id}"}')`, [base]); clearProviderCache();
    const { providersFor } = await import('../src/ai/registry.js');
    const [{ impl }] = await providersFor<any>('video');
    const { externalId } = await impl.submit({ prompt: 'x', durationSec: 5, aspect: '16:9' });
    expect(externalId).toBe('job-77'); expect(await impl.poll(externalId)).toEqual({ state: 'processing', progress: 40 });
    expect(seen.find((s) => s.path === '/v1/videos')!.body).toMatchObject({ model: 'v1', duration: 5, aspect_ratio: '16:9' });
  });
});
