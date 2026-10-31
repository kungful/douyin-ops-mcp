// 本地 JSON 存储：发布队列、素材库、下载清单。
// 单进程多工具调用，用"读-改-写 + 原子替换"就够，不需要数据库。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return structuredClone(fallback);
    const txt = fs.readFileSync(file, 'utf8').trim();
    if (!txt) return structuredClone(fallback);
    return JSON.parse(txt);
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- 发布队列
export function loadQueue() {
  const q = readJson(CONFIG.QUEUE_FILE, { items: [] });
  if (!Array.isArray(q.items)) q.items = [];
  return q;
}

export function saveQueue(q) {
  writeJson(CONFIG.QUEUE_FILE, q);
}

export function addQueueItem(item) {
  const q = loadQueue();
  const id = item.id || `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const full = {
    id,
    status: 'pending', // pending | running | done | failed | canceled | needs_confirm
    createdAt: new Date().toISOString(),
    attempts: 0,
    ...item,
  };
  q.items.push(full);
  saveQueue(q);
  return full;
}

export function updateQueueItem(id, patch) {
  const q = loadQueue();
  const idx = q.items.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  q.items[idx] = { ...q.items[idx], ...patch, updatedAt: new Date().toISOString() };
  saveQueue(q);
  return q.items[idx];
}

export function dueQueueItems(now = Date.now()) {
  return loadQueue().items.filter(
    (it) =>
      it.status === 'pending' &&
      (!it.scheduleAt || new Date(it.scheduleAt).getTime() <= now + 30_000),
  );
}

// ---------------------------------------------------------------- 下载清单
export function loadManifest() {
  const m = readJson(CONFIG.MANIFEST_FILE, { items: {} });
  if (!m.items) m.items = {};
  return m;
}

export function saveManifest(m) {
  writeJson(CONFIG.MANIFEST_FILE, m);
}

export function manifestHas(key) {
  return Boolean(loadManifest().items[key]);
}

export function manifestPut(key, info) {
  const m = loadManifest();
  m.items[key] = { ...info, at: new Date().toISOString() };
  saveManifest(m);
}

// ---------------------------------------------------------------- 素材/内容库
export function loadLibrary() {
  const lib = readJson(CONFIG.LIBRARY_FILE, { items: [] });
  if (!Array.isArray(lib.items)) lib.items = [];
  return lib;
}

export function saveLibrary(lib) {
  writeJson(CONFIG.LIBRARY_FILE, lib);
}

export function libraryPut(item) {
  const lib = loadLibrary();
  const id = item.id || `m${Date.now().toString(36)}`;
  const idx = lib.items.findIndex((x) => x.id === id);
  const full = { id, ...item, updatedAt: new Date().toISOString() };
  if (idx >= 0) lib.items[idx] = { ...lib.items[idx], ...full };
  else lib.items.unshift({ createdAt: new Date().toISOString(), ...full });
  saveLibrary(lib);
  return full;
}
