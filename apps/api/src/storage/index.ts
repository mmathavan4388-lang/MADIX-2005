import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { hmacHex, safeEqualHex } from '../lib/crypto.js';

export interface Storage {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  uploadTarget(key: string, mime: string, expiresSec?: number): Promise<{ url: string; method: 'PUT'; headers: Record<string, string> }>;
  readUrl(key: string, isPublic: boolean, expiresSec?: number): Promise<string>;
}

class S3Storage implements Storage {
  private s3 = new S3Client({
    region: config.S3_REGION, endpoint: config.S3_ENDPOINT, forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: config.S3_ACCESS_KEY_ID ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY! } : undefined,
  });
  private Bucket = config.S3_BUCKET!;
  async put(Key: string, Body: Buffer, ContentType: string) { await this.s3.send(new PutObjectCommand({ Bucket: this.Bucket, Key, Body, ContentType })); }
  async get(Key: string) { const r = await this.s3.send(new GetObjectCommand({ Bucket: this.Bucket, Key })); return Buffer.from(await r.Body!.transformToByteArray()); }
  async head(Key: string) { try { const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.Bucket, Key })); return { size: Number(r.ContentLength ?? 0) }; } catch { return null; } }
  async delete(Key: string) { await this.s3.send(new DeleteObjectCommand({ Bucket: this.Bucket, Key })); }
  async uploadTarget(Key: string, mime: string, expiresSec = 900) {
    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.Bucket, Key, ContentType: mime }), { expiresIn: expiresSec });
    return { url, method: 'PUT' as const, headers: { 'Content-Type': mime } };
  }
  async readUrl(Key: string, isPublic: boolean, expiresSec = 3600) {
    if (isPublic && config.CDN_BASE_URL) return `${config.CDN_BASE_URL.replace(/\/$/, '')}/${Key}`;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.Bucket, Key }), { expiresIn: expiresSec });
  }
}

// Development driver only. Same interface; files under LOCAL_UPLOAD_DIR, served by the API with HMAC-signed URLs.
class LocalStorage implements Storage {
  root = path.resolve(config.LOCAL_UPLOAD_DIR);
  private p(key: string) { const f = path.resolve(this.root, key); if (!f.startsWith(this.root + path.sep)) throw new Error('bad key'); return f; }
  async put(key: string, body: Buffer) { const f = this.p(key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
  async get(key: string) { return fs.readFileSync(this.p(key)); }
  async head(key: string) { try { return { size: fs.statSync(this.p(key)).size }; } catch { return null; } }
  async delete(key: string) { fs.rmSync(this.p(key), { force: true }); }
  sign(key: string, mode: 'r' | 'w', exp: number) { return hmacHex(config.JWT_SECRET, `${mode}:${key}:${exp}`); }
  verify(key: string, mode: 'r' | 'w', exp: number, sig: string) { return exp > Date.now() / 1000 && safeEqualHex(this.sign(key, mode, exp), sig); }
  async uploadTarget(key: string, mime: string, expiresSec = 900) {
    const exp = Math.floor(Date.now() / 1000) + expiresSec;
    return { url: `${config.PUBLIC_API_URL}/media/${encodeURI(key)}?mode=w&exp=${exp}&sig=${this.sign(key, 'w', exp)}`, method: 'PUT' as const, headers: { 'Content-Type': mime } };
  }
  async readUrl(key: string, _pub: boolean, expiresSec = 3600) {
    const exp = Math.floor(Date.now() / 1000) + expiresSec;
    return `${config.PUBLIC_API_URL}/media/${encodeURI(key)}?mode=r&exp=${exp}&sig=${this.sign(key, 'r', exp)}`;
  }
}

let instance: Storage | null = null;
export function storage(): Storage {
  if (instance) return instance;
  if (config.STORAGE_DRIVER === 's3') {
    if (!config.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
    instance = new S3Storage();
  } else instance = new LocalStorage();
  return instance;
}
export const localStorageDriver = () => (storage() instanceof LocalStorage ? (storage() as LocalStorage) : null);
export const newKey = (purpose: string, ext: string) => `${purpose}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
