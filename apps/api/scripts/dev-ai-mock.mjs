#!/usr/bin/env node
// DEVELOPMENT ONLY. A local OpenAI-compatible stand-in so the UI can be exercised without paid provider keys.
//   node scripts/dev-ai-mock.mjs            # listens on :4010
// Register it in the Admin → AI providers screen (adapter "openai-compatible", base URL http://localhost:4010/v1).
// It is never seeded, and production deployments must use real providers.
import http from 'node:http';
import sharp from 'sharp';

const port = Number(process.env.PORT ?? 4010);
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks); const json = (req.headers['content-type'] ?? '').includes('json') && raw.length ? JSON.parse(raw.toString()) : {};
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url?.endsWith('/chat/completions')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const last = json.messages?.at(-1)?.content; const text = typeof last === 'string' ? last : 'your message';
    if (/advertising copywriter/.test(text)) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ headline: 'Fresh. Bold. Yours.', subline: 'Made for people who create', adCopy: 'Meet your new favourite. Crafted with care, made to be shared.', caption: 'New drop is here ✨', hashtags: ['new', 'madix'], videoConcept: 'Slow push-in on the product, then a bright reveal.', imagePrompt: 'studio product photo', videoPrompt: 'product reveal' }) } }] })}\n\n`); res.end('data: [DONE]\n\n'); return; }
    const reply = `**Dev mock reply.** You said: "${text.slice(0, 80)}"\n\n- Streaming works\n- Markdown renders\n\n\`\`\`js\nconsole.log("hello MADIX");\n\`\`\``;
    for (const w of reply.split(/(\s+)/)) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`); await new Promise((r) => setTimeout(r, 25)); }
    res.end('data: [DONE]\n\n'); return;
  }
  if (req.url?.endsWith('/images/generations') || req.url?.endsWith('/images/edits')) {
    const hue = Math.floor(Math.random() * 360);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},80%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 80) % 360},80%,45%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" fill="#fff" font-size="48" text-anchor="middle" font-family="sans-serif">DEV MOCK IMAGE</text></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); return;
  }
  res.writeHead(404); res.end();
});
server.listen(port, () => console.log(`dev AI mock on http://localhost:${port}/v1`));
