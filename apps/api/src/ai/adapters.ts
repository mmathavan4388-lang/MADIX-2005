import type { AdapterFactory, ChatMessage, ProviderRow, TextProvider, ImageProvider, ImageEditProvider, VideoProvider, VoiceProvider, EmbeddingProvider } from './types.js';
import { ProviderError } from './types.js';

async function check(res: Response) {
  if (res.ok) return res;
  const body = await res.text().catch(() => '');
  console.error(`[ai] provider HTTP ${res.status}: ${body.slice(0, 300)}`); // logged server-side only; never surfaced to users
  throw new ProviderError(`provider error ${res.status}`, res.status >= 500 || res.status === 429, res.status);
}
const base = (r: ProviderRow) => (r.base_url ?? '').replace(/\/$/, '');
const authHeaders = (key: string | undefined, extra: Record<string, string> = {}) => ({ ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra });

async function* sse(res: Response): AsyncIterable<string> {
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of ev.split('\n')) if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

// ───────── OpenAI-compatible (OpenAI, Azure-style gateways, Together, Groq, vLLM, Ollama, OpenRouter, …) ─────────
const openaiCompatible: AdapterFactory = (row, key) => {
  const toMsg = (m: ChatMessage) => {
    if (!m.attachments?.length) return { role: m.role, content: m.content };
    const parts: any[] = [{ type: 'text', text: m.content }];
    for (const a of m.attachments) if (a.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.base64}` } });
    return { role: m.role, content: parts };
  };
  const text: TextProvider = {
    async *stream({ messages, maxTokens, temperature, signal }) {
      const res = await check(await fetch(`${base(row)}/chat/completions`, {
        method: 'POST', signal, headers: authHeaders(key, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ model: row.model, stream: true, max_tokens: maxTokens, temperature, messages: messages.map(toMsg), ...row.config.extraBody }),
      }));
      for await (const d of sse(res)) {
        if (d === '[DONE]') return;
        try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) yield t; } catch { /* keep-alive */ }
      }
    },
  };
  const image: ImageProvider = {
    async generate({ prompt, width, height, n, style, sourceImage, signal }) {
      const size = `${width}x${height}`;
      const full = style ? `${prompt}\n\nStyle: ${style}` : prompt;
      let res: Response;
      if (sourceImage) {
        const fd = new FormData();
        fd.set('model', row.model); fd.set('prompt', full); fd.set('n', String(n)); fd.set('size', size);
        fd.set('image', new Blob([new Uint8Array(sourceImage.bytes)], { type: sourceImage.mime }), 'source.png');
        res = await check(await fetch(`${base(row)}/images/edits`, { method: 'POST', signal, headers: authHeaders(key), body: fd }));
      } else {
        res = await check(await fetch(`${base(row)}/images/generations`, {
          method: 'POST', signal, headers: authHeaders(key, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ model: row.model, prompt: full, n, size, ...row.config.extraBody }),
        }));
      }
      return decodeImages(await res.json(), signal);
    },
  };
  const imageEdit: ImageEditProvider = {
    async edit({ op, image: img, mask, prompt, signal }) {
      const instruction: Record<string, string> = {
        remove_background: 'Remove the background completely, keep the main subject, output with a transparent background.',
        replace_background: `Replace the background with: ${prompt ?? 'a clean studio backdrop'}. Keep the subject unchanged.`,
        remove_object: `Remove the masked object and fill the area naturally. ${prompt ?? ''}`,
        enhance: 'Enhance this photo: improve lighting, colour, sharpness and detail without changing content.',
        effect: `Apply this creative effect while preserving the subject: ${prompt ?? 'cinematic'}`,
      };
      const fd = new FormData();
      fd.set('model', row.model); fd.set('prompt', instruction[op]); fd.set('n', '1');
      fd.set('image', new Blob([new Uint8Array(img.bytes)], { type: img.mime }), 'image.png');
      if (mask) fd.set('mask', new Blob([new Uint8Array(mask)], { type: 'image/png' }), 'mask.png');
      const res = await check(await fetch(`${base(row)}/images/edits`, { method: 'POST', signal, headers: authHeaders(key), body: fd }));
      return (await decodeImages(await res.json(), signal))[0];
    },
  };
  const voice: VoiceProvider = {
    async transcribe({ audio, mime, language }) {
      const fd = new FormData(); fd.set('model', row.model); if (language) fd.set('language', language);
      fd.set('file', new Blob([new Uint8Array(audio)], { type: mime }), 'audio');
      const res = await check(await fetch(`${base(row)}/audio/transcriptions`, { method: 'POST', headers: authHeaders(key), body: fd }));
      return (await res.json()).text as string;
    },
    async speak({ text, voice: v }) {
      const res = await check(await fetch(`${base(row)}/audio/speech`, { method: 'POST', headers: authHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify({ model: row.model, input: text, voice: v ?? row.config.voice ?? 'alloy' }) }));
      return { mime: 'audio/mpeg', bytes: Buffer.from(await res.arrayBuffer()) };
    },
  };
  const embedding: EmbeddingProvider = {
    async embed(texts) {
      const res = await check(await fetch(`${base(row)}/embeddings`, { method: 'POST', headers: authHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify({ model: row.model, input: texts }) }));
      return ((await res.json()).data as any[]).map((d) => d.embedding);
    },
  };
  return { text, image, image_edit: imageEdit, voice, embedding, video: undefined }[row.capability] as any;
};

async function decodeImages(json: any, signal?: AbortSignal) {
  const out: { mime: string; bytes: Buffer }[] = [];
  for (const d of json.data ?? []) {
    if (d.b64_json) out.push({ mime: 'image/png', bytes: Buffer.from(d.b64_json, 'base64') });
    else if (d.url) { const r = await check(await fetch(d.url, { signal })); out.push({ mime: r.headers.get('content-type')?.split(';')[0] ?? 'image/png', bytes: Buffer.from(await r.arrayBuffer()) }); }
  }
  if (!out.length) throw new ProviderError('provider returned no images', true);
  return out;
}

// ───────── Anthropic Messages API ─────────
const anthropic: AdapterFactory = (row, key) => {
  const text: TextProvider = {
    async *stream({ messages, maxTokens, temperature, signal }) {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const msgs = messages.filter((m) => m.role !== 'system').map((m) => {
        if (!m.attachments?.length) return { role: m.role, content: m.content };
        const parts: any[] = [];
        for (const a of m.attachments) {
          if (a.type === 'image') parts.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.base64 } });
          else if (a.mime === 'application/pdf') parts.push({ type: 'document', source: { type: 'base64', media_type: a.mime, data: a.base64 } });
        }
        parts.push({ type: 'text', text: m.content });
        return { role: m.role, content: parts };
      });
      const res = await check(await fetch(`${base(row) || 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST', signal,
        headers: { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: row.model, max_tokens: maxTokens ?? 2048, temperature, system: system || undefined, messages: msgs, stream: true }),
      }));
      for await (const d of sse(res)) {
        try { const j = JSON.parse(d); if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') yield j.delta.text; } catch { /* ping */ }
      }
    },
  };
  return text;
};

// ───────── Generic async video API (submit → poll). Endpoint shapes are configured per provider row. ─────────
const httpAsyncVideo: AdapterFactory = (row, key) => {
  const c = row.config;
  const get = (o: any, path: string) => path.split('.').reduce((a, k) => a?.[k], o);
  const v: VideoProvider = {
    async submit({ prompt, durationSec, aspect, style, image }) {
      const body: any = { model: row.model, prompt: style ? `${prompt}. Style: ${style}` : prompt, [c.durationField ?? 'duration']: durationSec, [c.aspectField ?? 'aspect_ratio']: aspect, ...c.extraBody };
      if (image) body[c.imageField ?? 'image'] = `data:${image.mime};base64,${image.bytes.toString('base64')}`;
      const res = await check(await fetch(`${base(row)}${c.submitPath ?? '/videos'}`, { method: 'POST', headers: authHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) }));
      const id = get(await res.json(), c.idField ?? 'id');
      if (!id) throw new ProviderError('provider did not return a job id', true);
      return { externalId: String(id) };
    },
    async poll(id) {
      const res = await check(await fetch(`${base(row)}${(c.statusPath ?? '/videos/{id}').replace('{id}', encodeURIComponent(id))}`, { headers: authHeaders(key) }));
      const j = await res.json();
      const st = String(get(j, c.statusField ?? 'status')).toLowerCase();
      if ((c.doneValues ?? ['completed', 'succeeded', 'done']).includes(st)) {
        const url = get(j, c.urlField ?? 'video_url');
        if (!url) throw new ProviderError('completed without video url', false);
        return { state: 'completed', videoUrl: url, progress: 100 };
      }
      if ((c.failValues ?? ['failed', 'error', 'cancelled']).includes(st)) return { state: 'failed', error: String(get(j, c.errorField ?? 'error') ?? 'generation failed') };
      const p = get(j, c.progressField ?? 'progress');
      return { state: 'processing', progress: typeof p === 'number' ? Math.min(99, p) : undefined };
    },
  };
  return v;
};

export const builtinAdapters: Record<string, AdapterFactory> = { 'openai-compatible': openaiCompatible, anthropic, 'http-async-video': httpAsyncVideo };
