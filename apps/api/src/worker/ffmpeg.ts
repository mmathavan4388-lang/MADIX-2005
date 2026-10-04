import { spawn } from 'node:child_process';
import type { z } from 'zod';
import type { videoEditSchema } from '../services/generate.js';

export type EDL = z.infer<typeof videoEditSchema>;
export interface ProbeInfo { duration: number; width: number; height: number; hasAudio: boolean }

export const FORMATS = { reel_9_16: [1080, 1920], square_1_1: [1080, 1080], landscape_16_9: [1920, 1080], portrait_4_5: [1080, 1350] } as const;
const FILTERS: Record<string, string> = {
  none: '', warm: 'colortemperature=temperature=7500', cool: 'colortemperature=temperature=4500', noir: 'hue=s=0,eq=contrast=1.2',
  vivid: 'eq=saturation=1.4:contrast=1.08', fade: 'eq=saturation=0.8:brightness=0.04:contrast=0.9', cinematic: 'eq=contrast=1.12:saturation=1.1,vignette=PI/5',
};
const FONT = process.env.MADIX_FONT_FILE ?? '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '’').replace(/%/g, '\\%').replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/,/g, '\\,').replace(/;/g, '\;');

/** Pure function: an edit-decision-list → ffmpeg argv. Inputs are local file paths in clip order, then optional audio. */
export function buildFfmpegArgs(edl: EDL, inputs: { path: string; probe: ProbeInfo }[], audioInput: { path: string } | null, out: string) {
  const [W, H] = FORMATS[edl.format];
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const i of inputs) args.push('-i', i.path);
  if (audioInput) args.push('-i', audioInput.path);
  const f: string[] = [];
  let total = 0;
  const durs: number[] = [];
  edl.clips.forEach((clip, i) => {
    const p = inputs[i].probe;
    const start = Math.min(clip.start, Math.max(0, p.duration - 0.1));
    const end = Math.min(clip.end ?? p.duration, p.duration);
    const len = Math.max(0.1, end - start);
    const outLen = len / clip.speed; durs.push(outLen); total += outLen;
    let v = `[${i}:v]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)/${clip.speed}`;
    if (clip.crop) v += `,crop=iw*${clip.crop.w}:ih*${clip.crop.h}:iw*${clip.crop.x}:ih*${clip.crop.y}`;
    v += `,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p`;
    if (edl.transition === 'fade') v += `,fade=t=in:st=0:d=0.3,fade=t=out:st=${Math.max(0, outLen - 0.3).toFixed(3)}:d=0.3`;
    f.push(`${v}[v${i}]`);
    if (p.hasAudio) {
      const tempo = atempoChain(clip.speed);
      f.push(`[${i}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS${tempo ? ',' + tempo : ''},volume=${clip.volume},aresample=44100,aformat=channel_layouts=stereo[a${i}]`);
    } else f.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${outLen.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
  });
  f.push(`${edl.clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${edl.clips.length}:v=1:a=1[vc][ac]`);

  // video post chain: filter → AI/auto enhance → text → captions
  let chain = '';
  const add = (s: string) => { if (s) chain += (chain ? ',' : '') + s; };
  add(FILTERS[edl.filter]);
  if (edl.aiEnhance) add('hqdn3d=1.5:1.5:6:6,unsharp=5:5:0.8:3:3:0.4,eq=contrast=1.05:saturation=1.08');
  for (const t of edl.texts) {
    add(`drawtext=fontfile='${FONT}':text='${esc(t.text)}':fontsize=${t.size}:fontcolor=${t.color}:x=(w-text_w)*${t.x}:y=(h-text_h)*${t.y}:enable='between(t,${t.start},${t.end})':shadowcolor=black@0.6:shadowx=2:shadowy=2`);
  }
  for (const c of edl.captions) {
    add(`drawtext=fontfile='${FONT}':text='${esc(c.text)}':fontsize=${Math.round(H / 34)}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=14:x=(w-text_w)/2:y=h-text_h-${Math.round(H * 0.1)}:enable='between(t,${c.start},${c.end})'`);
  }
  f.push(`[vc]${chain || 'null'}[vout]`);

  // audio: clip audio (+ optional music), optional loudness normalisation when enhancing
  const musicIdx = inputs.length;
  let aChain = '[ac]';
  if (audioInput) {
    f.push(`[${musicIdx}:a]atrim=start=${edl.audio!.start},asetpts=PTS-STARTPTS,volume=${edl.audio!.volume},aresample=44100,aformat=channel_layouts=stereo[music]`);
    f.push(`[ac][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amix]`);
    aChain = '[amix]';
  }
  f.push(`${aChain}${edl.aiEnhance ? 'loudnorm=I=-16:TP=-1.5:LRA=11' : 'anull'}[aout]`);

  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out);
  return { args, totalSec: total };
}
function atempoChain(speed: number) {
  if (speed === 1) return '';
  const parts: number[] = []; let s = speed;
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  parts.push(s);
  return parts.map((p) => `atempo=${p}`).join(',');
}

export function run(cmd: string, args: string[], opts: { onStderr?: (l: string) => void; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args); let out = '', err = '';
    const t = opts.timeoutMs ? setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, opts.timeoutMs) : null;
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => { err += d; opts.onStderr?.(String(d)); });
    p.on('error', reject);
    p.on('close', (code) => { if (t) clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`)); });
  });
}

export async function probe(path: string): Promise<ProbeInfo> {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path]));
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  return { duration: Number(j.format.duration ?? v?.duration ?? 0), width: v?.width ?? 0, height: v?.height ?? 0, hasAudio: j.streams.some((s: any) => s.codec_type === 'audio') };
}
