import { useSyncExternalStore } from 'react';
import en from './en.json';
import ta from './ta.json';
import hi from './hi.json';

/** Add a language: drop a JSON file here and register it. Missing keys fall back to English. */
export const LANGUAGES = [{ code: 'en', label: 'English' }, { code: 'ta', label: 'தமிழ்' }, { code: 'hi', label: 'हिन्दी' }] as const;
const dict: Record<string, Record<string, string>> = { en, ta, hi };
let lang = (() => { try { return localStorage.getItem('madix_lang') || navigator.language.slice(0, 2); } catch { return 'en'; } })();
if (!dict[lang]) lang = 'en';
const subs = new Set<() => void>();
export function setLang(l: string) { if (!dict[l]) return; lang = l; try { localStorage.setItem('madix_lang', l); } catch { /* ignore */ } document.documentElement.lang = l; subs.forEach((f) => f()); }
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = dict[lang]?.[key] ?? dict.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}
export function useI18n() {
  const l = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => lang);
  return { t, lang: l, setLang };
}
document.documentElement.lang = lang;
