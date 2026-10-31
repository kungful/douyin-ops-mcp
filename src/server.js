#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kungful
//
// 使用边界：本程序只能用于运营使用者本人拥有或已获授权的账号，以及发布其拥有权利的内容。
// 禁止用于刷量、批量养号、规避平台安全机制、大规模抓取或转售数据等用途。
// 本项目与抖音/字节跳动无任何关联、未获其授权。完整条款见仓库根目录 DISCLAIMER.md。
//
// MCP 服务器（stdio）。不依赖 SDK：MCP 的 stdio 传输就是"一行一个 JSON-RPC 2.0 消息"，
// 手写反而更可控、启动更快、少一个依赖。
//
// 支持的方法：initialize / notifications/* / ping / tools/list / tools/call / resources/list / prompts/list
import { CONFIG } from './config.js';
import { logger } from './log.js';
import { TOOLS, callTool, toolManifest, findTool } from './tools/index.js';
import { closeBrowser } from './browser/manager.js';

const log = logger('mcp');
const SERVER_INFO = { name: 'douyin-ops-mcp', version: '0.1.0' };
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

let buffer = '';
let negotiated = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

function textResult(data, isError = false) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }], isError };
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      negotiated = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
      log.info(`initialize：client=${params?.clientInfo?.name || '?'} version=${negotiated}`);
      return reply(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          '抖音运营工具箱（个人自用工具，与抖音官方无关联；仅限运营使用者本人拥有或已获授权的账号与内容，禁止刷量/批量养号/绕过风控/大规模抓取，详见 DISCLAIMER.md）。' +
          '免登录就能用：douyin_parse / douyin_download / douyin_transcribe / douyin_trending / douyin_user_profile / douyin_comments。' +
          '发布与搜索需要登录：先 douyin_login_qrcode 扫码（登录态持久保存）。**发布前一律先用 dryRun=true 出预览截图给用户确认**，' +
          '内容是否合规、是否侵权由使用者负责。',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'initialized':
      return; // 通知不需要回应

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, { tools: toolManifest() });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      const tool = findTool(name);
      if (!tool) return replyError(id, -32602, `没有这个工具：${name}`);
      const started = Date.now();
      log.info(`调用 ${name} ${JSON.stringify(args).slice(0, 300)}`);
      try {
        const out = await callTool(name, args);
        const ms = Date.now() - started;
        log.info(`${name} 完成 ${ms}ms ${out.ok ? '' : '（失败）'}`);
        if (!out.ok) {
          return reply(id, textResult({ ok: false, ...out.error, tool: name, ms }, true));
        }
        return reply(id, textResult({ ok: true, tool: name, ms, ...out.data }));
      } catch (err) {
        log.error(`${name} 异常：${err.stack || err.message}`);
        return reply(id, textResult({ ok: false, tool: name, error: err.message }, true));
      }
    }

    case 'resources/list':
      return reply(id, { resources: [] });
    case 'prompts/list':
      return reply(id, { prompts: [] });
    case 'resources/templates/list':
      return reply(id, { resourceTemplates: [] });

    default:
      if (isNotification) return;
      log.warn('未支持的方法', method);
      return replyError(id, -32601, `未支持的方法：${method}`);
  }
}

function onLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    log.error('JSON 解析失败', err.message);
    return replyError(null, -32700, 'JSON 解析失败');
  }
  const batch = Array.isArray(msg) ? msg : [msg];
  for (const m of batch) {
    handle(m).catch((err) => {
      log.error('处理消息异常', err.stack || err.message);
      if (m && m.id != null) replyError(m.id, -32603, err.message);
    });
  }
}

function main() {
  log.info(`douyin-ops-mcp 启动（${TOOLS.length} 个工具，headless=${CONFIG.HEADLESS}，profile=${CONFIG.PROFILE_DIR}）`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      onLine(line);
    }
  });
  process.stdin.on('end', () => shutdown('stdin 关闭'));

  const shutdown = async (why) => {
    log.info(`退出：${why}`);
    await closeBrowser().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => log.error('未捕获异常', err.stack || err.message));
  process.on('unhandledRejection', (err) => log.error('未处理的 rejection', err?.stack || String(err)));
}

main();
