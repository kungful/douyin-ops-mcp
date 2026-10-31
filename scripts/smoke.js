#!/usr/bin/env node
// 自检：不需要登录，把免登录能力全跑一遍（会真的开一次 Chrome 窗口）。
// 用法：npm run smoke  [-- --full]   加上 --full 会额外下 1 条视频并转写
import path from 'node:path';
import fs from 'node:fs';
import { CONFIG } from '../src/config.js';
import { logger } from '../src/log.js';
import { TOOLS, callTool } from '../src/tools/index.js';
import { closeBrowser } from '../src/browser/manager.js';

const log = logger('smoke');
const full = process.argv.includes('--full');
const SAMPLE_ID = process.env.SMOKE_AWEME_ID || '7701992027797359915'; // 热榜里随机一条，可能会失效

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - t0;
    results.push({ name, ok: true, ms, sample: summarize(out) });
    log.info(`✅ ${name} ${ms}ms`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: err.message });
    log.error(`❌ ${name}：${err.message}`);
  }
}

function summarize(out) {
  if (out == null) return null;
  const s = JSON.stringify(out);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

async function main() {
  log.info(`工具总数 ${TOOLS.length}：${TOOLS.map((t) => t.name).join(', ')}`);
  log.info(`数据目录 ${CONFIG.DATA_DIR}`);

  await step('热榜 douyin_trending', async () => {
    const r = await callTool('douyin_trending', { board: 'hot' });
    if (!r.ok) throw new Error(r.error.message);
    return { top3: r.data.list.slice(0, 3).map((x) => `${x.rank}. ${x.word} (${x.hotValue})`) };
  });

  await step('解析作品 douyin_parse', async () => {
    const r = await callTool('douyin_parse', { target: SAMPLE_ID });
    if (!r.ok) throw new Error(r.error.message);
    return {
      id: r.data.id,
      type: r.data.type,
      author: r.data.author?.nickname,
      stats: r.data.stats,
      hasNoWmUrl: Boolean(r.data.video?.noWatermarkUrl),
      topics: r.data.topics?.map((t) => t.name),
      duration: r.data.duration,
    };
  });

  await step('作品链接解析（含作者→主页）', async () => {
    const r = await callTool('douyin_user_profile', { target: SAMPLE_ID, posts: 3 });
    if (!r.ok) throw new Error(r.error.message);
    return { user: r.data.user?.nickname, followers: r.data.user?.followerCount, posts: r.data.posts?.map((p) => p.desc?.slice(0, 20)) };
  });

  await step('评论 douyin_comments', async () => {
    const r = await callTool('douyin_comments', { target: SAMPLE_ID, count: 5 });
    if (!r.ok) throw new Error(r.error.message);
    return { total: r.data.total, first: r.data.items?.[0]?.text?.slice(0, 40) };
  });

  await step('登录状态', async () => {
    const r = await callTool('douyin_login_status', {});
    if (!r.ok) throw new Error(r.error.message);
    return { wwwLoggedIn: r.data.wwwLoggedIn, creatorLoggedIn: r.data.creatorLoggedIn, me: r.data.me?.nickname };
  });

  await step('队列读取 douyin_queue_list', async () => {
    const r = await callTool('douyin_queue_list', {});
    if (!r.ok) throw new Error(r.error.message);
    return { total: r.data.total, pending: r.data.pending };
  });

  if (full) {
    await step('下载无水印视频', async () => {
      const dir = path.join(CONFIG.DATA_DIR, 'downloads', 'smoke');
      const r = await callTool('douyin_download', { target: SAMPLE_ID, dir });
      if (!r.ok) throw new Error(r.error.message);
      const files = [...(r.data.files || []), ...(r.data.skipped || [])];
      return { files: files.map((f) => path.basename(f)), size: files[0] && fs.statSync(files[0]).size, meta: r.data.meta };
    });

    await step('转写 douyin_transcribe', async () => {
      const dir = path.join(CONFIG.DATA_DIR, 'downloads', 'smoke');
      const r = await callTool('douyin_transcribe', { target: SAMPLE_ID, saveDir: dir, engine: process.env.SMOKE_ASR_ENGINE || 'auto' });
      if (!r.ok) throw new Error(r.error.message);
      return { engine: r.data.engine, model: r.data.model, chars: r.data.chars, head: r.data.text?.slice(0, 60) };
    });
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 自检结果 =====');
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? ` ${r.ms}ms` : ` — ${r.error}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  await closeBrowser().catch(() => {});
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  log.error('自检崩溃', err.stack || err.message);
  await closeBrowser().catch(() => {});
  process.exit(1);
});
