// 账号数据：我的作品列表 + 单条数据 + 账号概览（都从创作者中心读，那是唯一的真实数据源；
// 公开接口的 play_count 对别人永远是 0，只有创作者中心给真实播放量）。
import { URLs } from '../config.js';
import { logger } from '../log.js';
import { sleep, parseCount } from '../util.js';
import { getCreatorPage, shot } from '../browser/manager.js';
import { hasCreatorLogin } from './login.js';
import { openAndWait, assertNotBlocked, scrapeTable, visibleLines, numbersByLabel } from './scrape.js';

const log = logger('stats');

async function ensureCreatorPage() {
  const page = await getCreatorPage();
  if (!(await hasCreatorLogin(page.context()))) {
    const err = new Error('创作者中心未登录：先调用 douyin_login_qrcode 扫码');
    err.code = 'NEED_LOGIN';
    throw err;
  }
  return page;
}

/**
 * 我的作品列表（含每条的播放/点赞/评论/分享与状态）
 * @param {{limit?: number, tab?: 'all'|'published'|'draft'|'reviewing'}} opts
 */
export async function myVideos({ limit = 20 } = {}) {
  const page = await ensureCreatorPage();
  await openAndWait(page, URLs.creatorManage, {
    ready: [],
    textAny: ['内容管理', '作品'],
    timeout: 40_000,
  });
  await assertNotBlocked(page, 'stats-manage');
  // 作品管理是异步加载的：等"加载中…"消失并且真的出现行
  const { sleep: wait } = await import('../util.js');
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const done = await page
      .evaluate(() => {
        const text = document.body?.innerText || '';
        if (/加载中/.test(text)) return false;
        const rows = document.querySelectorAll('table tbody tr, [role="row"], [class*="table-row"]');
        return rows.length >= 2;
      })
      .catch(() => false);
    if (done) break;
    await wait(1000);
  }
  await sleep(1200);

  const table = await scrapeTable(page);
  const rows = table.rows.slice(0, limit).map((cells) => {
    const joined = cells.join(' | ');
    return {
      cells,
      summary: joined.slice(0, 300),
      metrics: guessMetrics(cells),
    };
  });

  const text = (await visibleLines(page)).slice(0, 80);
  return {
    ok: rows.length > 0,
    headers: table.headers,
    rows,
    textFallback: rows.length ? undefined : text,
    note: rows.length
      ? '数值来自创作者中心作品管理页；cells 是原始单元格文本'
      : '没能解析出表格：页面可能改版或需要滚动加载。textFallback 是页面可见文本，可用它人工定位。',
    screenshot: rows.length ? undefined : await shot(page, 'stats-manage-empty'),
  };
}

function guessMetrics(cells) {
  const numbers = cells.map((c) => parseCount(c)).filter((n) => n != null);
  const named = {};
  const keys = ['播放', '点赞', '评论', '分享', '收藏', '主页访问', '粉丝增量'];
  cells.forEach((c) => {
    for (const k of keys) {
      if (c.includes(k)) {
        const m = c.match(/[\d.,]+\s*[万wW亿]?/);
        if (m) named[k] = parseCount(m[0]);
      }
    }
  });
  return { positional: numbers, named };
}

/** 账号概览：粉丝、作品数、近 7/30 天播放与互动（数据中心首页） */
export async function accountOverview() {
  const page = await ensureCreatorPage();
  const tries = [URLs.creatorHome, URLs.creatorDataOverview];
  for (const url of tries) {
    await openAndWait(page, url, { textAny: ['粉丝', '播放'], timeout: 30_000 });
    await assertNotBlocked(page, 'stats-overview');
    await sleep(2000);
    const text = (await page.evaluate(() => document.body?.innerText || '')).replace(/\u00a0/g, ' ');
    const metrics = numbersByLabel(text, [
      '粉丝总数',
      '总粉丝数',
      '粉丝',
      '新增粉丝',
      '获赞',
      '播放量',
      '主页访问',
      '作品数',
      '投稿',
      '评论量',
      '分享量',
      '完播率',
      '平均播放时长',
    ]);
    if (Object.keys(metrics).length) {
      return {
        ok: true,
        url,
        metrics,
        rawText: text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 120),
        note: 'metrics 是从页面标签 + 数字猜出来的，rawText 是原文，可交叉验证',
      };
    }
  }
  const file = await shot(page, 'stats-overview-empty');
  return {
    ok: false,
    screenshot: file,
    note: '没能从概览页读到指标。创作者中心可能改版或需要先选时间范围。',
  };
}

/**
 * 单条作品的数据（先按作品 id 在作品管理里找，找不到就退回公开接口）
 */
export async function videoStats(awemeId) {
  const page = await ensureCreatorPage();
  await openAndWait(page, URLs.creatorManage, { textAny: ['作品', '播放'], timeout: 40_000 });
  await assertNotBlocked(page, 'stats-video');
  await sleep(1200);
  const found = await page.evaluate((id) => {
    const links = [...document.querySelectorAll(`a[href*="${id}"]`)];
    if (!links.length) return null;
    let node = links[0];
    for (let i = 0; i < 6 && node; i++) {
      const txt = node.innerText || '';
      if (txt.length > 40) return txt.replace(/\s+/g, ' ').slice(0, 800);
      node = node.parentElement;
    }
    return (links[0].parentElement?.innerText || '').replace(/\s+/g, ' ').slice(0, 800);
  }, String(awemeId));

  if (!found) {
    const { fetchAweme } = await import('../douyin/parse.js');
    const pub = await fetchAweme(awemeId);
    return {
      ok: false,
      note: '创作者中心里没找到这条作品（可能不在第一页）。这里给的是公开数据，播放量对非本人不公开。',
      publicData: pub,
    };
  }
  const nums = (found.match(/[\d.,]+\s*[万wW亿]?/g) || []).map((s) => parseCount(s));
  return { ok: true, row: found, numbers: nums };
}
