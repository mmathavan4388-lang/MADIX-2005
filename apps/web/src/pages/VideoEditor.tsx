import { useRef, useState } from 'react';
import { api, uploadFile } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Btn, Empty, Field, Segmented } from '../components/ui';
import { CreationList, useCreations } from '../components/Gen';

interface Clip { key: number; fileId: string; url: string; name: string; duration: number; start: number; end: number; speed: number; volume: number; crop: string }
const CROPS: Record<string, { x: number; y: number; w: number; h: number } | undefined> = { none: undefined, 'square-center': { x: 0.21875, y: 0, w: 0.5625, h: 1 }, 'portrait-center': { x: 0.3, y: 0, w: 0.4, h: 1 }, 'wide-center': { x: 0, y: 0.2, w: 1, h: 0.6 } };
const FORMATS = [['reel_9_16', 'Reel 9:16'], ['square_1_1', 'Square 1:1'], ['portrait_4_5', 'Portrait 4:5'], ['landscape_16_9', 'Landscape 16:9']] as const;
let seq = 0;

export default function VideoEditor() {
  const { t } = useI18n(); const { handleError, refreshMe, config } = useApp(); const creations = useCreations('video_edit');
  const [clips, setClips] = useState<Clip[]>([]); const [sel, setSel] = useState<number | null>(null); const [busy, setBusy] = useState(false); const [pct, setPct] = useState(0);
  const [format, setFormat] = useState<(typeof FORMATS)[number][0]>('reel_9_16'); const [filter, setFilter] = useState('none'); const [transition, setTransition] = useState('none'); const [aiEnhance, setAi] = useState(false);
  const [texts, setTexts] = useState<{ text: string; start: number; end: number; y: number }[]>([]); const [caps, setCaps] = useState<{ text: string; start: number; end: number }[]>([]);
  const [music, setMusic] = useState<{ id: string; name: string } | null>(null); const [musicVol, setMusicVol] = useState(0.7); const vref = useRef<HTMLVideoElement>(null);
  const [undo, setUndo] = useState<Clip[][]>([]); const [redo, setRedo] = useState<Clip[][]>([]);
  const push = (next: Clip[]) => { setUndo((u) => [...u.slice(-30), clips]); setRedo([]); setClips(next); };
  const cur = clips.find((c) => c.key === sel) ?? null;
  const patch = (k: number, p: Partial<Clip>) => push(clips.map((c) => (c.key === k ? { ...c, ...p } : c)));
  const total = clips.reduce((s, c) => s + (c.end - c.start) / c.speed, 0);

  const addClips = async (files: FileList | null) => {
    if (!files) return; setBusy(true);
    try {
      const added: Clip[] = [];
      for (const f of Array.from(files)) {
        const r = await uploadFile(f, 'edit_source', 'user', setPct);
        const dur = await new Promise<number>((res) => { const v = document.createElement('video'); v.preload = 'metadata'; v.onloadedmetadata = () => res(v.duration || 1); v.onerror = () => res(1); v.src = r.file.url; });
        added.push({ key: ++seq, fileId: r.id, url: r.file.url, name: f.name, duration: dur, start: 0, end: Math.round(dur * 100) / 100, speed: 1, volume: 1, crop: 'none' });
      }
      push([...clips, ...added]); if (sel === null && added[0]) setSel(added[0].key);
    } catch (e) { handleError(e); } finally { setBusy(false); setPct(0); }
  };
  const split = () => {
    if (!cur || !vref.current) return; const at = Math.round((cur.start + vref.current.currentTime) * 100) / 100;
    if (at <= cur.start + 0.2 || at >= cur.end - 0.2) return handleError(new Error('x'));
    const i = clips.findIndex((c) => c.key === cur.key); const b: Clip = { ...cur, key: ++seq, start: at };
    push([...clips.slice(0, i), { ...cur, end: at }, b, ...clips.slice(i + 1)]);
  };
  const move = (k: number, d: -1 | 1) => { const i = clips.findIndex((c) => c.key === k), j = i + d; if (j < 0 || j >= clips.length) return; const n = [...clips]; [n[i], n[j]] = [n[j], n[i]]; push(n); };
  const addMusic = async (f?: File) => { if (!f) return; setBusy(true); try { const r = await uploadFile(f, 'edit_source'); setMusic({ id: r.id, name: f.name }); } catch (e) { handleError(e); } finally { setBusy(false); } };

  const exportVideo = async () => {
    setBusy(true);
    try {
      await api('/generations/video-edit', { body: {
        clips: clips.map((c) => ({ fileId: c.fileId, start: c.start, end: c.end, speed: c.speed, volume: c.volume, crop: CROPS[c.crop] })), format, filter, transition, aiEnhance,
        texts: texts.filter((x) => x.text).map((x) => ({ text: x.text, start: x.start, end: Math.max(x.end, x.start + 0.5), y: x.y })), captions: caps.filter((x) => x.text).map((x) => ({ text: x.text, start: x.start, end: Math.max(x.end, x.start + 0.5) })),
        audio: music ? { fileId: music.id, volume: musicVol } : undefined } });
      await creations.reload(); void refreshMe();
    } catch (e) { handleError(e); } finally { setBusy(false); }
  };
  const cost = (config.creditCosts.video_edit_basic ?? 0) + (aiEnhance ? config.creditCosts.video_edit_ai ?? 0 : 0);

  return (
    <div className="stack-lg">
      <header><h1 className="grad-text">{t('vedit.title')}</h1><p className="muted">Trim · split · merge · crop · speed · text · captions · music · filters · export for any social format</p></header>
      <div className="grid split" style={{ alignItems: 'start' }}>
        <div className="stack">
          {cur ? <video ref={vref} key={cur.key} src={cur.url} controls playsInline className="canvas-wrap" style={{ width: '100%', maxHeight: '50dvh' }} onLoadedMetadata={(e) => { (e.target as HTMLVideoElement).currentTime = 0; }} /> : <Empty icon="🎬" title="Add clips to begin" />}
          <div className="toolbar">
            <label className="btn primary sm" style={{ cursor: 'pointer' }}>{busy && pct ? `${Math.round(pct * 100)}%` : '+ Add clips'}<input type="file" hidden multiple accept="video/mp4,video/webm,video/quicktime" onChange={(e) => void addClips(e.target.files)} /></label>
            <Btn variant="soft" className="sm" disabled={!cur} onClick={split}>✂ Split at playhead</Btn>
            <Btn variant="ghost" className="sm" disabled={!undo.length} onClick={() => { setRedo([clips, ...redo]); setClips(undo.at(-1)!); setUndo(undo.slice(0, -1)); }}>↶ {t('common.undo')}</Btn>
            <Btn variant="ghost" className="sm" disabled={!redo.length} onClick={() => { setUndo([...undo, clips]); setClips(redo[0]); setRedo(redo.slice(1)); }}>↷ {t('common.redo')}</Btn>
          </div>
          <div className="timeline" aria-label="Timeline">{clips.map((c, i) => (
            <div key={c.key} className="clip" style={{ outline: c.key === sel ? '2px solid var(--secondary)' : undefined }} onClick={() => setSel(c.key)}>
              <video src={c.url} muted preload="metadata" /><div><b style={{ fontSize: '.85rem' }}>{i + 1}. {c.name.slice(0, 22)}</b><div className="muted" style={{ fontSize: '.78rem' }}>{c.start.toFixed(1)}s → {c.end.toFixed(1)}s · {c.speed}x</div></div>
              <div className="row" style={{ gap: 2 }}><button className="icon-btn" aria-label="Move up" onClick={(e) => { e.stopPropagation(); move(c.key, -1); }}>↑</button><button className="icon-btn" aria-label="Move down" onClick={(e) => { e.stopPropagation(); move(c.key, 1); }}>↓</button><button className="icon-btn" aria-label={t('common.delete')} onClick={(e) => { e.stopPropagation(); push(clips.filter((x) => x.key !== c.key)); if (sel === c.key) setSel(null); }}>✕</button></div>
            </div>))}</div>
          {cur && (<div className="card stack"><b>Clip settings</b>
            <div className="grid g2"><Field label={`Trim start (${cur.start.toFixed(1)}s)`}><input type="range" min={0} max={cur.end - 0.2} step={0.1} value={cur.start} onChange={(e) => patch(cur.key, { start: Number(e.target.value) })} /></Field><Field label={`Trim end (${cur.end.toFixed(1)}s)`}><input type="range" min={cur.start + 0.2} max={cur.duration} step={0.1} value={cur.end} onChange={(e) => patch(cur.key, { end: Number(e.target.value) })} /></Field></div>
            <div className="grid g2"><Field label={`Speed (${cur.speed}x)`}><input type="range" min={0.25} max={4} step={0.25} value={cur.speed} onChange={(e) => patch(cur.key, { speed: Number(e.target.value) })} /></Field><Field label={`Volume (${Math.round(cur.volume * 100)}%)`}><input type="range" min={0} max={2} step={0.1} value={cur.volume} onChange={(e) => patch(cur.key, { volume: Number(e.target.value) })} /></Field></div>
            <Field label="Crop"><select value={cur.crop} onChange={(e) => patch(cur.key, { crop: e.target.value })}>{Object.keys(CROPS).map((k) => <option key={k}>{k}</option>)}</select></Field></div>)}
        </div>
        <div className="card stack">
          <div className="field"><span>Export format</span><Segmented label="Format" value={format} onChange={setFormat} options={FORMATS.map(([v, l]) => ({ value: v, label: l }))} /></div>
          <Field label="Filter"><select value={filter} onChange={(e) => setFilter(e.target.value)}>{['none', 'warm', 'cool', 'noir', 'vivid', 'fade', 'cinematic'].map((f) => <option key={f}>{f}</option>)}</select></Field>
          <Field label="Transitions"><select value={transition} onChange={(e) => setTransition(e.target.value)}><option value="none">none</option><option value="fade">fade</option></select></Field>
          <div className="stack"><b>Text</b>{texts.map((x, i) => <div key={i} className="grid g2"><input value={x.text} placeholder="Text" onChange={(e) => setTexts(texts.map((y, j) => j === i ? { ...y, text: e.target.value } : y))} aria-label="Text" /><div className="row gap"><input type="number" min={0} step={0.5} value={x.start} onChange={(e) => setTexts(texts.map((y, j) => j === i ? { ...y, start: Number(e.target.value) } : y))} aria-label="Start" /><input type="number" min={0} step={0.5} value={x.end} onChange={(e) => setTexts(texts.map((y, j) => j === i ? { ...y, end: Number(e.target.value) } : y))} aria-label="End" /></div></div>)}
            <Btn variant="soft" className="sm" onClick={() => setTexts([...texts, { text: '', start: 0, end: Math.max(2, Math.min(total, 4)), y: 0.2 }])}>+ Text</Btn></div>
          <div className="stack"><b>Captions</b>{caps.map((x, i) => <div key={i} className="grid g2"><input value={x.text} placeholder="Caption" onChange={(e) => setCaps(caps.map((y, j) => j === i ? { ...y, text: e.target.value } : y))} aria-label="Caption" /><div className="row gap"><input type="number" min={0} step={0.5} value={x.start} onChange={(e) => setCaps(caps.map((y, j) => j === i ? { ...y, start: Number(e.target.value) } : y))} aria-label="Start" /><input type="number" min={0} step={0.5} value={x.end} onChange={(e) => setCaps(caps.map((y, j) => j === i ? { ...y, end: Number(e.target.value) } : y))} aria-label="End" /></div></div>)}
            <Btn variant="soft" className="sm" onClick={() => setCaps([...caps, { text: '', start: caps.at(-1)?.end ?? 0, end: (caps.at(-1)?.end ?? 0) + 2 }])}>+ Caption</Btn></div>
          <div className="stack"><b>Music / audio</b>{music ? <div className="row between"><span className="chip hot">♪ {music.name.slice(0, 24)}</span><Btn variant="ghost" className="sm" onClick={() => setMusic(null)}>✕</Btn></div> : <label className="btn ghost sm" style={{ cursor: 'pointer' }}>+ Add audio<input type="file" hidden accept="audio/mpeg,audio/mp4,audio/wav,audio/webm" onChange={(e) => void addMusic(e.target.files?.[0])} /></label>}
            {music && <Field label={`Music volume (${Math.round(musicVol * 100)}%)`}><input type="range" min={0} max={2} step={0.1} value={musicVol} onChange={(e) => setMusicVol(Number(e.target.value))} /></Field>}</div>
          <label className="row gap"><input type="checkbox" checked={aiEnhance} onChange={(e) => setAi(e.target.checked)} /> Auto-enhance (denoise, sharpen, balance loudness) +{config.creditCosts.video_edit_ai ?? 0}</label>
          <p className="muted" style={{ fontSize: '.85rem' }}>Duration ≈ {total.toFixed(1)}s</p>
          <Btn loading={busy && !pct} disabled={!clips.length || clips.length > 20} onClick={exportVideo}>Export · {cost} {t('common.credits')}</Btn>
        </div>
      </div>
      <section className="stack"><h2>Exports</h2><CreationList kind="video_edit" creations={creations} /></section>
    </div>
  );
}
