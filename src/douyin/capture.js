// 兜底采集：直接打开页面，抓站点自己发出去的接口响应。
// 用途：某些接口号段在页面内 fetch 会被拒（风控抽样），但页面渲染用的那条请求是通的。
import { CONFIG } from '../config.js';
import { logger } from '../log.js';
import { getContext } from '../browser/manager.js';
import { detectBlock, BrowserBlockedError } from '../browser/pagekit.js';
import { lenientJson } from './json.js';

const log = logger('capture');

/**
 * 打开一个新标签页访问 url，等待匹配的接口响应并返回其 JSON。
 * @param {string} url 要访问的页面
 * @param {RegExp} matcher 接口 URL 匹配规则，例如 /aweme\/detail/
 * @param {{timeout?: number, wait?: number}} opts
 */
export async function captureJson(url, matcher, { timeout = 25_000, wait = 3_000 } = {}) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  let resolved = null;
  const handler = async (res) => {
    if (resolved) return;
    if (!matcher.test(res.url())) return;
    try {
      const text = await res.text();
      const json = lenientJson(text);
      if (json) resolved = { json, url: res.url() };
    } catch {
      /* ignore */
    }
  };
  page.on('response', handler);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT }).catch(() => {});
    const deadline = Date.now() + timeout;
    let checked = false;
    while (Date.now() < deadline && !resolved) {
      await page.waitForTimeout(400);
      if (!checked && Date.now() > deadline - timeout + wait) {
        checked = true;
        const { block, detail } = await detectBlock(page);
        if (block === 'captcha') throw new BrowserBlockedError(block, detail, null, url);
      }
    }
    if (!resolved) {
      const { block, detail } = await detectBlock(page);
      if (block) throw new BrowserBlockedError(block, detail, null, url);
    }
    return resolved;
  } finally {
    page.off('response', handler);
    // 用完即关，别让页面堆积
    await page.close().catch(() => {});
  }
}

export { log };
