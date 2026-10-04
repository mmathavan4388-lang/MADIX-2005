import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadFile } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Btn, Empty, Field, Segmented } from '../components/ui';

type Adj = { brightness: number; contrast: number; saturate: number; grayscale: number; sepia: number; blur: number; hue: number };
const ADJ0: Adj = { brightness: 100, contrast: 100, saturate: 100, grayscale: 0, sepia: 0, blur: 0, hue: 0 };
const PRESETS: Record<string, Partial<Adj>> = { Original: {}, Vivid: { saturate: 150, contrast: 110 }, Noir: { grayscale: 100, contrast: 125 }, Warm: { sepia: 35, saturate: 120, brightness: 105 }, Cool: { hue: 190, saturate: 90 }, Fade: { contrast: 85, brightness: 110, saturate: 80 }, Dream: { blur: 1, brightness: 108, saturate: 125 } };
type TextLayer = { id: number; text: string; x: number; y: number; size: number; color: string };
const cssFilter = (a: Adj) => `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturate}%) grayscale(${a.grayscale}%) sepia(${a.sepia}%) blur(${a.blur}px) hue-rotate(${a.hue}deg)`;
const clone = (c: HTMLCanvasElement) => { const n = document.createElement('canvas'); n.width = c.width; n.height = c.height; n.getContext('2d')!.drawImage(c, 0, 0); return n; };
const toBlob = (c: HTMLCanvasElement, type = 'image/png', q = 0.92) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('export'))), type, q));
const loadImg = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; });

export default function PhotoEditor() {
  const { t } = useI18n(); const { handleError, refreshMe, toast, config } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null); const maskRef = useRef<HTMLCanvasElement | null>(null);
  const [hist, setHist] = useState<HTMLCanvasElement[]>([]); const [idx, setIdx] = useState(-1);
  const [adj, setAdj] = useState<Adj>(ADJ0); const [texts, setTexts] = useState<TextLayer[]>([]); const [tab, setTab] = useState<'adjust' | 'crop' | 'text' | 'ai'>('adjust');
  const [before, setBefore] = useState(false); const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [resizeW, setResizeW] = useState(0); const [busy, setBusy] = useState<string | null>(null); const [brush, setBrush] = useState(false); const [aiPrompt, setAiPrompt] = useState('');
  const base = hist[idx]; const orig = hist[0];

  const commit = useCallback((c: HTMLCanvasElement) => { setHist((h) => [...h.slice(0, idx + 1), c]); setIdx((i) => i + 1); setAdj(ADJ0); setTexts([]); setCrop(null); maskRef.current = null; }, [idx]);
  const open = async (f?: File) => {
    if (!f) return; const url = URL.createObjectURL(f);
    try { const img = await loadImg(url); const c = document.createElement('canvas'); const s = Math.min(1, 2400 / Math.max(img.width, img.height)); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height); setHist([c]); setIdx(0); setAdj(ADJ0); setTexts([]); setResizeW(c.width); } catch (e) { handleError(e); } finally { URL.revokeObjectURL(url); }
  };
  const render = useCallback((target: HTMLCanvasElement, src: HTMLCanvasElement, withLayers: boolean) => {
    target.width = src.width; target.height = src.height; const ctx = target.getContext('2d')!;
    ctx.filter = withLayers ? cssFilter(adj) : 'none'; ctx.drawImage(src, 0, 0); ctx.filter = 'none';
    if (withLayers) for (const l of texts) { ctx.font = `700 ${l.size}px Inter, sans-serif`; ctx.fillStyle = l.color; ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 6; ctx.textAlign = 'center'; ctx.fillText(l.text, l.x * src.width, l.y * src.height); ctx.shadowBlur = 0; }
  }, [adj, texts]);
  useEffect(() => {
    const cv = canvasRef.current; if (!cv || !base) return; render(cv, before && orig ? orig : base, !before);
    const ctx = cv.getContext('2d')!;
    if (tab === 'crop' && crop) { ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(base, crop.x, crop.y, crop.w, crop.h, crop.x, crop.y, crop.w, crop.h); ctx.strokeStyle = '#22D3EE'; ctx.lineWidth = Math.max(2, cv.width / 300); ctx.strokeRect(crop.x, crop.y, crop.w, crop.h); }
    if (maskRef.current && tab === 'ai') { ctx.globalAlpha = 0.5; ctx.drawImage(maskRef.current, 0, 0); ctx.globalAlpha = 1; }
  }, [base, orig, adj, texts, before, tab, crop, render]);

  const pos = (e: React.PointerEvent) => { const r = canvasRef.current!.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * canvasRef.current!.width, y: ((e.clientY - r.top) / r.height) * canvasRef.current!.height }; };
  const down = useRef<{ x: number; y: number } | null>(null);
  const onDown = (e: React.PointerEvent) => { if (!base) return; (e.target as Element).setPointerCapture(e.pointerId); const p = pos(e); down.current = p; if (tab === 'crop') setCrop({ x: p.x, y: p.y, w: 1, h: 1 }); };
  const onMove = (e: React.PointerEvent) => {
    if (!down.current || !base) return; const p = pos(e);
    if (tab === 'crop') setCrop({ x: Math.max(0, Math.min(down.current.x, p.x)), y: Math.max(0, Math.min(down.current.y, p.y)), w: Math.min(base.width, Math.abs(p.x - down.current.x)), h: Math.min(base.height, Math.abs(p.y - down.current.y)) });
    if (tab === 'ai' && brush) {
      if (!maskRef.current) { const m = document.createElement('canvas'); m.width = base.width; m.height = base.height; maskRef.current = m; }
      const c = maskRef.current.getContext('2d')!; c.fillStyle = '#F472B6'; c.beginPath(); c.arc(p.x, p.y, Math.max(8, base.width / 40), 0, 7); c.fill(); setAdj((a) => ({ ...a }));
    }
  };
  const onUp = () => { down.current = null; };

  const flatten = () => { const c = document.createElement('canvas'); render(c, base, true); return c; };
  const applyAdjust = () => commit(flatten());
  const applyCrop = () => { if (!crop || crop.w < 8 || crop.h < 8) return; const c = document.createElement('canvas'); c.width = Math.round(crop.w); c.height = Math.round(crop.h); c.getContext('2d')!.drawImage(base, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height); commit(c); setResizeW(c.width); };
  const applyResize = () => { if (!resizeW || resizeW < 16) return; const f = flatten(); const c = document.createElement('canvas'); c.width = Math.min(4096, Math.round(resizeW)); c.height = Math.round((f.height * c.width) / f.width); c.getContext('2d')!.drawImage(f, 0, 0, c.width, c.height); commit(c); };
  const addText = () => setTexts((l) => [...l, { id: Date.now(), text: 'Your text', x: 0.5, y: 0.5, size: Math.round((base?.width ?? 800) / 12), color: '#FFFFFF' }]);

  const aiOp = async (op: string) => {
    if (!base) return; setBusy(op);
    try {
      const flat = flatten(); const src = await uploadFile(await toBlob(flat), 'edit_source');
      let maskId: string | undefined;
      if (op === 'remove_object' && maskRef.current) {
        const m = document.createElement('canvas'); m.width = flat.width; m.height = flat.height; const mc = m.getContext('2d')!; mc.fillStyle = '#000'; mc.fillRect(0, 0, m.width, m.height); mc.globalCompositeOperation = 'destination-out'; mc.drawImage(maskRef.current, 0, 0);
        maskId = (await uploadFile(await toBlob(m), 'edit_source')).id;
      }
      const g = await api('/generations/photo-edit', { body: { op, sourceFileId: src.id, maskFileId: maskId, prompt: aiPrompt || undefined } }); void refreshMe();
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000)); const s = await api(`/generations/${g.id}`);
        if (s.status === 'completed') { const img = await loadImg(s.files[0].url); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d')!.drawImage(img, 0, 0); commit(c); toast('✓'); return; }
        if (s.status === 'failed' || s.status === 'cancelled') throw new Error('failed');
      }
      throw new Error('timeout');
    } catch (e) { handleError(e instanceof Error && e.message === 'failed' ? new Error('x') : e); } finally { setBusy(null); }
  };
  const exportAs = async (type: string, ext: string) => { const f = flatten(); const b = await toBlob(f, type); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `madix-edit.${ext}`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
  const publish = async () => { setBusy('publish'); try { const r = await uploadFile(await toBlob(flatten(), 'image/jpeg'), 'post'); await api('/posts', { body: { kind: 'image', body: '', fileId: r.id } }); toast('✓'); } catch (e) { handleError(e); } finally { setBusy(null); } };
  const aiCosts = useMemo(() => config.creditCosts.photo_edit_ai ?? 0, [config]);

  return (
    <div className="stack-lg">
      <header><h1 className="grad-text">{t('photo.title')}</h1><p className="muted">Crop · resize · filters · text · AI background & object tools · export</p></header>
      {!base ? (
        <Empty icon="🖼" title="Open a photo to start" action={<label className="btn primary" style={{ cursor: 'pointer' }}>{t('common.upload')}<input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => void open(e.target.files?.[0])} /></label>} />
      ) : (
        <div className="grid split" style={{ alignItems: 'start' }}>
          <div className="stack">
            <div className="toolbar"><Btn variant="soft" className="sm" disabled={idx <= 0} onClick={() => { setIdx(idx - 1); setAdj(ADJ0); setTexts([]); }}>↶ {t('common.undo')}</Btn><Btn variant="soft" className="sm" disabled={idx >= hist.length - 1} onClick={() => { setIdx(idx + 1); setAdj(ADJ0); setTexts([]); }}>↷ {t('common.redo')}</Btn>
              <Btn variant={before ? 'primary' : 'ghost'} className="sm" onPointerDown={() => setBefore(true)} onPointerUp={() => setBefore(false)} onPointerLeave={() => setBefore(false)} onKeyDown={(e) => e.key === ' ' && setBefore(true)} onKeyUp={() => setBefore(false)}>Before / After (hold)</Btn></div>
            <div className="canvas-wrap"><canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} style={{ cursor: tab === 'crop' || (tab === 'ai' && brush) ? 'crosshair' : 'default' }} aria-label="Photo canvas" /></div>
          </div>
          <div className="card stack">
            <Segmented label="Tools" value={tab} onChange={setTab} options={[{ value: 'adjust', label: 'Adjust' }, { value: 'crop', label: 'Crop/Size' }, { value: 'text', label: 'Text' }, { value: 'ai', label: 'AI' }]} />
            {tab === 'adjust' && (<>
              <div className="row wrap" style={{ gap: 6 }}>{Object.entries(PRESETS).map(([n, p]) => <button key={n} className="chip" style={{ cursor: 'pointer', border: 0 }} onClick={() => setAdj({ ...ADJ0, ...p })}>{n}</button>)}</div>
              {(['brightness', 'contrast', 'saturate', 'grayscale', 'sepia', 'blur', 'hue'] as const).map((k) => <Field key={k} label={`${k} (${adj[k]})`}><input type="range" min={k === 'blur' ? 0 : k === 'hue' ? 0 : 0} max={k === 'blur' ? 10 : k === 'hue' ? 360 : k === 'grayscale' || k === 'sepia' ? 100 : 200} value={adj[k]} onChange={(e) => setAdj({ ...adj, [k]: Number(e.target.value) })} /></Field>)}
              <Btn onClick={applyAdjust}>Apply adjustments</Btn></>)}
            {tab === 'crop' && (<><p className="muted" style={{ fontSize: '.85rem' }}>Drag on the photo to choose the crop area.</p><Btn onClick={applyCrop} disabled={!crop}>Apply crop</Btn>
              <Field label="Resize width (px)"><input type="number" min={16} max={4096} value={resizeW} onChange={(e) => setResizeW(Number(e.target.value))} /></Field><Btn variant="soft" onClick={applyResize}>Resize</Btn></>)}
            {tab === 'text' && (<><Btn variant="soft" onClick={addText}>+ Add text</Btn>{texts.map((l) => (
              <div key={l.id} className="card stack" style={{ padding: 10 }}><input value={l.text} onChange={(e) => setTexts(texts.map((x) => x.id === l.id ? { ...x, text: e.target.value } : x))} aria-label="Text" />
                <div className="grid g2"><Field label="X"><input type="range" min={0} max={1} step={0.01} value={l.x} onChange={(e) => setTexts(texts.map((x) => x.id === l.id ? { ...x, x: Number(e.target.value) } : x))} /></Field><Field label="Y"><input type="range" min={0} max={1} step={0.01} value={l.y} onChange={(e) => setTexts(texts.map((x) => x.id === l.id ? { ...x, y: Number(e.target.value) } : x))} /></Field></div>
                <div className="row gap"><input type="color" value={l.color} onChange={(e) => setTexts(texts.map((x) => x.id === l.id ? { ...x, color: e.target.value } : x))} aria-label="Colour" style={{ width: 56 }} /><input type="range" min={12} max={300} value={l.size} onChange={(e) => setTexts(texts.map((x) => x.id === l.id ? { ...x, size: Number(e.target.value) } : x))} aria-label="Size" /><Btn variant="ghost" className="sm" onClick={() => setTexts(texts.filter((x) => x.id !== l.id))}>✕</Btn></div></div>))}
              {texts.length > 0 && <Btn onClick={applyAdjust}>Apply text</Btn>}</>)}
            {tab === 'ai' && (<>
              <p className="muted" style={{ fontSize: '.85rem' }}>Each AI edit costs {aiCosts} {t('common.credits')}.</p>
              <Btn variant="soft" loading={busy === 'remove_background'} onClick={() => aiOp('remove_background')}>Remove background</Btn>
              <Field label="Prompt (background / effect)"><input value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="a sunny beach, golden hour" maxLength={500} /></Field>
              <Btn variant="soft" loading={busy === 'replace_background'} disabled={!aiPrompt.trim()} onClick={() => aiOp('replace_background')}>Replace background</Btn>
              <Btn variant="soft" loading={busy === 'effect'} disabled={!aiPrompt.trim()} onClick={() => aiOp('effect')}>Apply AI effect</Btn>
              <Btn variant="soft" loading={busy === 'enhance'} onClick={() => aiOp('enhance')}>Enhance photo</Btn>
              <div className="row gap"><Btn variant={brush ? 'primary' : 'ghost'} className="sm" onClick={() => setBrush(!brush)}>🖌 Paint object</Btn><Btn variant="ghost" className="sm" onClick={() => { maskRef.current = null; setAdj({ ...adj }); }}>Clear</Btn></div>
              <Btn variant="soft" loading={busy === 'remove_object'} disabled={!maskRef.current} onClick={() => aiOp('remove_object')}>Remove painted object</Btn></>)}
            <hr style={{ border: 0, borderTop: '1px solid var(--border)' }} />
            <div className="row wrap" style={{ gap: 6 }}><Btn className="sm" onClick={() => exportAs('image/png', 'png')}>PNG</Btn><Btn className="sm" variant="soft" onClick={() => exportAs('image/jpeg', 'jpg')}>JPG</Btn><Btn className="sm" variant="soft" onClick={() => exportAs('image/webp', 'webp')}>WebP</Btn><Btn className="sm" variant="ghost" loading={busy === 'publish'} onClick={publish}>{t('common.post')}</Btn></div>
          </div>
        </div>
      )}
    </div>
  );
}
