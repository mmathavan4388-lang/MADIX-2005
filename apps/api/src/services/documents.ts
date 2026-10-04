import { pool, one } from '../db/pool.js';
import { storage } from '../storage/index.js';
import { badRequest } from '../lib/errors.js';
import type { ChatDoc, ChatImage } from '../ai/types.js';

const MAX_DOC_CHARS = 60_000;

/** Load a user's uploaded file for AI use: images → multimodal part, PDFs → native part + extracted text fallback, text/docx → text. */
export async function loadAttachment(userId: string, fileId: string): Promise<{ attachment?: ChatImage | ChatDoc; text?: string; name: string }> {
  const f = await one(pool, `SELECT * FROM files WHERE id=$1 AND owner_id=$2 AND status='ready'`, [fileId, userId]);
  if (!f) throw badRequest('Attachment not found.');
  const buf = await storage().get(f.storage_key);
  if (f.mime.startsWith('image/')) return { attachment: { type: 'image', mime: f.mime, base64: buf.toString('base64') }, name: 'image' };
  if (f.mime === 'application/pdf') {
    const text = await extractPdf(buf);
    return { attachment: { type: 'document', mime: f.mime, base64: buf.toString('base64') }, text, name: 'document.pdf' };
  }
  if (f.mime === 'text/plain' || f.mime === 'text/markdown') return { text: buf.toString('utf8').slice(0, MAX_DOC_CHARS), name: 'document.txt' };
  if (f.mime.includes('wordprocessingml')) {
    const mammoth = await import('mammoth');
    return { text: (await mammoth.extractRawText({ buffer: buf })).value.slice(0, MAX_DOC_CHARS), name: 'document.docx' };
  }
  throw badRequest('This file type cannot be analysed.');
}

async function extractPdf(buf: Buffer): Promise<string> {
  try {
    const pdf = (await import('pdf-parse/lib/pdf-parse.js' as string)).default;
    return ((await pdf(buf)).text as string).slice(0, MAX_DOC_CHARS);
  } catch { return ''; }
}
