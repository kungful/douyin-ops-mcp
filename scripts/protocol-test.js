#!/usr/bin/env node
// MCP 协议自测：像真实客户端那样起进程、握手、列工具、调一个免登录工具。
// 用法：node scripts/protocol-test.js
import { spawn } from 'node:child_process';
import path from 'node:path';

const serverPath = path.join(import.meta.dirname, '..', 'src', 'server.js');
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('[非 JSON 输出]', line.slice(0, 200));
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 180_000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? '✅' : '❌'} ${name}${info ? ` — ${info}` : ''}`);
}

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'protocol-test', version: '1.0.0' },
});
check('initialize', Boolean(init.result?.protocolVersion), `protocolVersion=${init.result?.protocolVersion}`);
notify('notifications/initialized');

const list = await rpc('tools/list', {});
const tools = list.result?.tools || [];
check('tools/list', tools.length >= 20, `${tools.length} 个工具`);
const noSchema = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== 'object');
check('每个工具有 object 类型的 inputSchema', noSchema.length === 0, noSchema.map((t) => t.name).join(','));

const trend = await rpc('tools/call', { name: 'douyin_trending', arguments: { board: 'hot' } });
const trendText = trend.result?.content?.[0]?.text || '';
let trendJson = null;
try {
  trendJson = JSON.parse(trendText);
} catch {
  /* ignore */
}
check('调用 douyin_trending', Boolean(trendJson?.ok), `热榜 ${trendJson?.list?.length ?? 0} 条`);

const parse = await rpc('tools/call', { name: 'douyin_parse', arguments: { target: '7701992027797359915' } });
const parseJson = JSON.parse(parse.result?.content?.[0]?.text || '{}');
check('调用 douyin_parse', Boolean(parseJson.ok), `作者 ${parseJson.author?.nickname}，播放 ${parseJson.stats?.play ?? '不公开'}`);

const bad = await rpc('tools/call', { name: 'douyin_parse', arguments: { target: '这不是链接' } });
const badJson = JSON.parse(bad.result?.content?.[0]?.text || '{}');
check('错误被结构化返回', bad.result?.isError === true && !badJson.ok, badJson.error?.message?.slice(0, 40));

const ping = await rpc('ping', {});
check('ping', ping.result !== undefined);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
child.stdin.end();
process.exit(failed ? 1 : 0);
