// 创作者中心的通用读取工具：表格抓取、指标数字解析。
// 创作者中心是 React + Semi Design，DOM 结构随版本变化，所以这里用"结构优先、
// 文本兜底"的两条路：能识别到表格就给结构化数据，识别不到就把可见文本原样带回去。
import { CONFIG } from '../config.js';
import { logger } from '../log.js';
import { sleep, parseCount } from '../util.js';
import { shot } from '../browser/manager.js';
import { detectBlock, BrowserBlockedError } from '../browser/pagekit.js';

const log = logger('scrape');

/** 打开页面并等到"内容出现"（任一候选选择器命中，或纯文本出现关键词） */
export async function openAndWait(page, url, { ready = [], textAny = [], timeout = 30_000 } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT });
  await sleep(2500);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of ready) {
      try {
        if (await page.locator(sel).first().count()) return true;
      } catch {
        /* ignore */
      }
    }
    if (textAny.length) {
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (textAny.some((t) => text.includes(t))) return true;
    }
    if (!ready.length && !textAny.length) return true;
    await sleep(600);
  }
  return false;
}

/** 页面被拦时报错（创作者中心也会弹验证码） */
export async function assertNotBlocked(page, tag) {
  const { block, detail } = await detectBlock(page);
  if (block === 'captcha' || block === 'risk') {
    const file = await shot(page, tag);
    throw new BrowserBlockedError(block, detail, file, page.url());
  }
  return block;
}

/**
 * 抓表格：优先 <tr>，其次 Semi 的 role=row，最后放弃结构化。
 * @returns {{headers: string[], rows: string[][]}}
 */
export async function scrapeTable(page) {
  const data = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // 1) 标准表格
    const tables = [...document.querySelectorAll('table')];
    for (const table of tables) {
      const trs = [...table.querySelectorAll('tr')];
      if (trs.length < 2) continue;
      const rows = trs.map((tr) =>
        [...tr.querySelectorAll('th,td')].map((td) => clean(td.innerText)),
      );
      const headerIdx = rows.findIndex((r) => r.length > 1);
      if (headerIdx < 0) continue;
      return { headers: rows[headerIdx], rows: rows.slice(headerIdx + 1).filter((r) => r.length > 1) };
    }
    // 2) role=row 的虚拟列表
    const roleRows = [...document.querySelectorAll('[role="row"]')];
    if (roleRows.length >= 2) {
      const rows = roleRows.map((r) => [...r.querySelectorAll('[role="gridcell"],[role="cell"]')].map((c) => clean(c.innerText)));
      const filled = rows.filter((r) => r.length > 1);
      if (filled.length >= 2) return { headers: filled[0], rows: filled.slice(1) };
    }
    // 3) 卡片式列表：找 class 里带 row/item/card 的兄弟节点
    const guess = [...document.querySelectorAll('div[class*="row"],div[class*="item"],div[class*="card"]')]
      .filter((el) => el.children.length >= 3 && clean(el.innerText).length > 20)
      .slice(0, 60);
    if (guess.length >= 2) {
      const rows = guess.map((el) => [...el.children].map((c) => clean(c.innerText)));
      return { headers: [], rows };
    }
    return { headers: [], rows: [] };
  });
  return data;
}

/** 把可见文本按行切开，用于兜底展示 */
export async function visibleLines(page, { max = 200 } = {}) {
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * 从一段文本里按标签找数字，例如 粉丝总数 1.2万 → 12000
 * @param {string} text
 * @param {string[]} labels
 */
export function numbersByLabel(text, labels) {
  const out = {};
  const lines = String(text || '').split('\n').map((l) => l.trim());
  for (const label of labels) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(label)) continue;
      // 同一行里出现数字
      const sameLine = line.replace(label, '').match(/[\d.,]+\s*[万wW亿]?/);
      if (sameLine && /\d/.test(sameLine[0])) {
        out[label] = parseCount(sameLine[0].trim());
        break;
      }
      // 下一行是数字（卡片常见的上下结构）
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const m = lines[j].match(/^[\d.,]+\s*[万wW亿]?$/);
        if (m) {
          out[label] = parseCount(lines[j]);
          break;
        }
      }
      if (out[label] != null) break;
    }
  }
  return out;
}

export { log };
