// 极简日志：全部走 stderr（stdout 是 MCP 的 JSON-RPC 通道，绝不能污染）。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.DOUYIN_LOG_LEVEL || 'info'] || 20;

let stream = null;
function fileStream() {
  if (stream) return stream;
  try {
    const file = path.join(CONFIG.LOG_DIR, `douyin-mcp-${new Date().toISOString().slice(0, 10)}.log`);
    stream = fs.createWriteStream(file, { flags: 'a' });
  } catch {
    stream = null;
  }
  return stream;
}

function emit(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const line =
    `[${new Date().toISOString().slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${scope} ` +
    args
      .map((a) => (typeof a === 'string' ? a : safeJson(a)))
      .join(' ');
  process.stderr.write(line + '\n');
  try {
    fileStream()?.write(line + '\n');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function safeJson(v) {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  } catch {
    return String(v);
  }
}

export function logger(scope) {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
  };
}
