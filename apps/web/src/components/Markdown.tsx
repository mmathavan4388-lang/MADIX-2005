import { useMemo, useState } from 'react';
import { t } from '../i18n';

/** Small, dependency-free, XSS-safe Markdown renderer: everything is escaped first; only whitelisted constructs are produced. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(s: string) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>');
}
type Block = { t: 'code'; lang: string; code: string } | { t: 'html'; html: string };
function parse(src: string): Block[] {
  const out: Block[] = []; const lines = src.split('\n'); let i = 0;
  const para: string[] = [];
  const flush = () => { if (para.length) { out.push({ t: 'html', html: `<p>${inline(para.join('\n')).replace(/\n/g, '<br/>')}</p>` }); para.length = 0; } };
  while (i < lines.length) {
    const l = lines[i];
    const fence = /^```(\w*)/.exec(l);
    if (fence) { flush(); const code: string[] = []; i++; while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]); i++; out.push({ t: 'code', lang: fence[1], code: code.join('\n') }); continue; }
    const h = /^(#{1,3})\s+(.*)/.exec(l);
    if (h) { flush(); out.push({ t: 'html', html: `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>` }); i++; continue; }
    if (/^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l)) {
      flush(); const ordered = /^\s*\d+\./.test(l); const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))}</li>`);
      out.push({ t: 'html', html: `<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>` }); continue;
    }
    if (l.startsWith('> ')) { flush(); out.push({ t: 'html', html: `<blockquote>${inline(l.slice(2))}</blockquote>` }); i++; continue; }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l); i++;
  }
  flush(); return out;
}
function Code({ lang, code }: { lang: string; code: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="codeblock">
      <header><span>{lang || 'code'}</span><button className="btn ghost sm" onClick={() => { void navigator.clipboard?.writeText(code); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? t('common.copied') : t('common.copy')}</button></header>
      <pre><code>{code}</code></pre>
    </div>
  );
}
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parse(text), [text]);
  return <div className="md">{blocks.map((b, i) => (b.t === 'code' ? <Code key={i} lang={b.lang} code={b.code} /> : <div key={i} dangerouslySetInnerHTML={{ __html: b.html }} />))}</div>;
}
