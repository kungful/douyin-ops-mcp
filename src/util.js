// 通用小工具：等待、重试、文本清洗、数字解析、文件名安全化。
import { setTimeout as sleepCb } from 'node:timers/promises';

export const sleep = (ms) => sleepCb(ms);

export function safeName(s, fallback = 'untitled', max = 60) {
  const cleaned = String(s ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[._ ]+|[._ ]+$/g, '')
    .slice(0, max);
  return cleaned || fallback;
}

/** "1.2万" / "3.4w" / "1,234" → 数字 */
export function parseCount(text) {
  if (text == null) return null;
  const s = String(text).trim().replace(/,/g, '');
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*([万wW亿亿]?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 1e4);
  if (unit === '亿') return Math.round(n * 1e8);
  return n;
}

export function dedupe(arr, keyFn = (x) => x) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (k == null || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export async function retry(fn, { tries = 3, delay = 800, label = 'op', onError } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      onError?.(err, i);
      if (i < tries) await sleep(delay * i);
    }
  }
  const e = new Error(`${label} 失败（${tries} 次）：${lastErr?.message || lastErr}`);
  e.cause = lastErr;
  throw e;
}

export function truncate(s, n = 200) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/** 从任意文本里抓第一个抖音链接 / 裸作品 id */
export function findDouyinTarget(text) {
  const s = String(text ?? '');
  const urlMatch = s.match(/https?:\/\/[^\s，。、"'）)】]+/);
  if (urlMatch) return { kind: 'url', value: urlMatch[0] };
  const idMatch = s.match(/\b(\d{19})\b/) || s.match(/\b(\d{18,20})\b/);
  if (idMatch) return { kind: 'aweme_id', value: idMatch[1] };
  const sec = s.match(/MS4wLjABAAAA[\w-]{20,}/);
  if (sec) return { kind: 'sec_uid', value: sec[0] };
  return null;
}

export function nowIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function jitter(min, max) {
  return min + Math.random() * (max - min);
}
