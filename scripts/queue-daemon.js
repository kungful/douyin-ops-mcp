#!/usr/bin/env node
// 定时发布守护进程：每 30 秒看一次队列，到点就发。
// 用法：node scripts/queue-daemon.js [--once] [--force]
// Windows 上可以用 start-queue.cmd 常驻，或者丢进系统计划任务。
import { CONFIG } from '../src/config.js';
import { logger } from '../src/log.js';
import { sleep } from '../src/util.js';
import { loadQueue, updateQueueItem } from '../src/store.js';
import { publish } from '../src/creator/publish.js';
import { closeBrowser } from '../src/browser/manager.js';

const log = logger('queue');
const args = process.argv.slice(2);
const once = args.includes('--once');
const force = args.includes('--force');

function isDue(item, now) {
  if (item.status !== 'pending') return false;
  if (force) return true;
  if (!item.scheduleAt) return true;
  const t = new Date(item.scheduleAt.replace(/\//g, '-').replace(' ', 'T')).getTime();
  return Number.isFinite(t) && t <= now + 60_000; // 提前 1 分钟预热浏览器
}

async function tick() {
  const now = Date.now();
  const due = loadQueue().items.filter((i) => isDue(i, now));
  if (!due.length) return 0;
  log.info(`到期任务 ${due.length} 条`);
  for (const item of due) {
    log.info(`发布 ${item.id}：${item.kind} ${item.title || ''} @ ${item.scheduleAt || '立即'}`);
    updateQueueItem(item.id, { status: 'running', attempts: (item.attempts || 0) + 1, startedAt: new Date().toISOString() });
    try {
      const res = await publish({
        kind: item.kind,
        files: item.files,
        title: item.title,
        desc: item.desc,
        topics: item.topics || [],
        coverFile: item.cover || '',
        scheduleAt: item.scheduleAt || '',
        dryRun: Boolean(item.dryRun) || !CONFIG.QUEUE_ALLOW_SUBMIT,
      });
      updateQueueItem(item.id, {
        status: res.ok ? (res.dryRun ? 'needs_confirm' : 'done') : 'failed',
        result: { stage: res.stage, detail: res.detail, screenshot: res.screenshot, problems: res.problems, error: res.error, steps: res.steps },
      });
      log[res.ok ? 'info' : 'warn'](`${item.id} → ${res.stage} ${res.detail || res.error || ''}`);
    } catch (err) {
      updateQueueItem(item.id, { status: 'failed', result: { error: err.message } });
      log.error(`${item.id} 发布异常：${err.message}`);
    }
    await sleep(5000);
  }
  return due.length;
}

async function main() {
  log.info(`队列守护启动（间隔 ${CONFIG.QUEUE_INTERVAL_MS}ms，自动点发布=${CONFIG.QUEUE_ALLOW_SUBMIT}）`);
  if (once) {
    const n = await tick();
    log.info(n ? `跑完 ${n} 条` : '没有到期任务');
    await closeBrowser().catch(() => {});
    return;
  }
  let stopping = false;
  const stop = async () => {
    stopping = true;
    await closeBrowser().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      log.error('tick 异常', err.message);
    }
    await sleep(CONFIG.QUEUE_INTERVAL_MS);
  }
}

main().catch((err) => {
  log.error('守护进程崩溃', err.stack || err.message);
  process.exit(1);
});
