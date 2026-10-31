#!/usr/bin/env node
// 命令行直接调一个工具（不用经过 MCP，调试/自动化都方便）
// 用法：node scripts/tool.js douyin_login_status '{}'
//       node scripts/tool.js douyin_parse '{"target":"..."}'
import { callTool } from '../src/tools/index.js';
import { closeBrowser } from '../src/browser/manager.js';

const [, , name, argsJson = '{}'] = process.argv;
if (!name) {
  console.error('用法：node scripts/tool.js <工具名> [JSON参数]');
  process.exit(2);
}
let raw = argsJson;
if (raw.startsWith('@')) raw = (await import('node:fs')).readFileSync(raw.slice(1), 'utf8');
let args;
try {
  args = JSON.parse(raw);
} catch (err) {
  console.error('参数不是合法 JSON：', err.message);
  process.exit(2);
}
const out = await callTool(name, args);
console.log(JSON.stringify(out, null, 2));
await closeBrowser().catch(() => {});
process.exit(out.ok ? 0 : 1);
