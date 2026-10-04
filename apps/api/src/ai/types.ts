export type Capability = 'text' | 'image' | 'image_edit' | 'video' | 'voice' | 'embedding';

export interface ChatPart { type: 'text'; text: string }
export interface ChatImage { type: 'image'; mime: string; base64: string }
export interface ChatDoc { type: 'document'; mime: string; base64: string; name?: string }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; attachments?: (ChatImage | ChatDoc)[] }

export interface TextProvider {
  stream(req: { messages: ChatMessage[]; maxTokens?: number; temperature?: number; signal?: AbortSignal }): AsyncIterable<string>;
}
export interface ImageProvider {
  generate(req: { prompt: string; width: number; height: number; n: number; style?: string; sourceImage?: { mime: string; bytes: Buffer }; strength?: number; signal?: AbortSignal }): Promise<{ mime: string; bytes: Buffer }[]>;
}
export type ImageEditOp = 'remove_background' | 'replace_background' | 'remove_object' | 'enhance' | 'effect';
export interface ImageEditProvider {
  edit(req: { op: ImageEditOp; image: { mime: string; bytes: Buffer }; mask?: Buffer; prompt?: string; signal?: AbortSignal }): Promise<{ mime: string; bytes: Buffer }>;
}
export interface VideoProvider {
  submit(req: { prompt: string; durationSec: number; aspect: string; style?: string; image?: { mime: string; bytes: Buffer } }): Promise<{ externalId: string }>;
  poll(externalId: string): Promise<{ state: 'processing' | 'completed' | 'failed'; progress?: number; videoUrl?: string; error?: string }>;
}
export interface VoiceProvider {
  transcribe(req: { audio: Buffer; mime: string; language?: string }): Promise<string>;
  speak(req: { text: string; voice?: string }): Promise<{ mime: string; bytes: Buffer }>;
}
export interface EmbeddingProvider { embed(texts: string[]): Promise<number[][]>; }

export type AnyProvider = TextProvider | ImageProvider | ImageEditProvider | VideoProvider | VoiceProvider | EmbeddingProvider;

export interface ProviderRow {
  id: string; capability: Capability; name: string; adapter: string; model: string;
  base_url: string | null; api_key_env: string | null; config: Record<string, any>; priority: number;
}
export type AdapterFactory = (row: ProviderRow, apiKey: string | undefined) => AnyProvider;

export class ProviderError extends Error {
  constructor(message: string, public retryable = true, public status?: number) { super(message); }
}
