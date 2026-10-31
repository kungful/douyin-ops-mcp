// 页面操作脚手架：导航、风控/验证码识别、等待渲染、截图诊断。
import { CONFIG } from '../config.js';
import { logger } from '../log.js';
import { sleep } from '../util.js';
import { shot } from './manager.js';

const log = logger('page');

/** 抖音的几种"拦住你"的页面 */
export const BLOCK = {
  CAPTCHA: 'captcha', // 滑块/图形验证
  LOGIN: 'login', // 需要登录
  EMPTY: 'empty', // 空白壳页（JS 反爬 VM 页）
  RISK: 'risk', // 触发风控提示
};

const CAPTCHA_SELECTORS = [
  '#captcha_container',
  '.captcha_verify_container',
  '.captcha-verify-container',
  '[class*="captcha_verify"]',
  '#captcha-verify-image',
  'div[id^="captcha"]',
];

const RISK_TEXT = ['访问过于频繁', '操作频繁', '请稍后再试', '网络环境异常', '账号存在风险'];

/**
 * 判定当前页面是否被拦。
 * @returns {{block: string|null, detail?: string}}
 */
export async function detectBlock(page) {
  try {
    for (const sel of CAPTCHA_SELECTORS) {
      if (await page.locator(sel).first().count()) {
        return { block: BLOCK.CAPTCHA, detail: `命中验证码容器 ${sel}` };
      }
    }
    const text = (await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '')) || '';
    if (text.includes('请完成下列验证') || text.includes('拖动下方滑块')) {
      return { block: BLOCK.CAPTCHA, detail: '页面要求完成安全验证' };
    }
    if (text.includes('登录后查看') || text.includes('请先登录') || text.includes('登录抖音')) {
      return { block: BLOCK.LOGIN, detail: '页面要求登录' };
    }
    for (const t of RISK_TEXT) {
      if (text.includes(t)) return { block: BLOCK.RISK, detail: t };
    }
    const html = await page.content();
    if (html.length < 12_000 && html.includes('_$jsvmprt')) {
      return { block: BLOCK.EMPTY, detail: '拿到的是 JS 反爬虚拟机壳页' };
    }
    return { block: null };
  } catch (err) {
    return { block: null, detail: `检测失败: ${err.message}` };
  }
}

/**
 * 打开页面并等它稳下来；命中验证码时抛一个"可交给用户处理"的错误。
 */
export async function open(page, url, { wait = 2500, allowBlock = false, tag = 'open' } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT });
  await sleep(wait);
  const { block, detail } = await detectBlock(page);
  if (block && !allowBlock) {
    const file = await shot(page, `blocked-${tag}`);
    throw new BrowserBlockedError(block, detail, file, page.url());
  }
  return { block, detail };
}

export class BrowserBlockedError extends Error {
  constructor(block, detail, screenshot, url) {
    const hint =
      block === BLOCK.CAPTCHA
        ? '抖音要求人工完成滑块验证：请在弹出的 Chrome 窗口里手动过掉验证码，然后重试。'
        : block === BLOCK.LOGIN
          ? '需要登录：先调用 douyin_login_qrcode 扫码登录（登录态会保存在浏览器 profile 里，之后不用重复扫）。'
          : block === BLOCK.RISK
            ? '触发了风控限流：降低频率、隔几分钟再试，或换网络出口。'
            : '拿到的是反爬壳页：重试一次通常就好；仍失败请手动在该窗口里打开抖音。';
    super(`抖音拦截了这次访问（${block}${detail ? `：${detail}` : ''}）。${hint}`);
    this.block = block;
    this.screenshot = screenshot;
    this.url = url;
  }
}

/** 等页面上出现某个文本/选择器（任一命中即返回） */
export async function waitAny(page, candidates, timeout = 20_000, { poll = 300 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const c of candidates) {
      try {
        if (typeof c === 'string') {
          if (await page.locator(c).first().count()) return c;
        } else if (c.selector) {
          const loc = page.locator(c.selector).first();
          if ((await loc.count()) && (await loc.isVisible().catch(() => false))) return c.name || c.selector;
        } else if (c.text) {
          const loc = page.getByText(c.text, { exact: false }).first();
          if (await loc.count()) return c.text;
        }
      } catch {
        /* 继续尝试下一个 */
      }
    }
    await sleep(poll);
  }
  return null;
}

/** 点击候选里的第一个可见元素，返回命中的候选描述 */
export async function clickAny(page, candidates, { timeout = 10_000, force = false } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const c of candidates) {
      try {
        const loc = buildLocator(page, c);
        if (!loc) continue;
        const n = await loc.count();
        if (!n) continue;
        const first = loc.first();
        if (!(await first.isVisible().catch(() => false))) continue;
        await first.click({ timeout: 4000, force });
        return describeCandidate(c);
      } catch {
        /* 换下一个 */
      }
    }
    await sleep(300);
  }
  return null;
}

export async function fillAny(page, candidates, value, { timeout = 10_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const c of candidates) {
      try {
        const loc = buildLocator(page, c);
        if (!loc) continue;
        const first = loc.first();
        if (!(await first.count()) || !(await first.isVisible().catch(() => false))) continue;
        await first.click({ timeout: 4000 }).catch(() => {});
        const tag = await first.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
        if (tag === 'input' || tag === 'textarea') {
          await first.fill('');
          await first.type(String(value), { delay: 12 });
        } else {
          // contenteditable 简介区
          await first.evaluate((el) => {
            el.focus();
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
          });
          await page.keyboard.press('Backspace');
          await page.keyboard.type(String(value), { delay: 18 });
        }
        return describeCandidate(c);
      } catch {
        /* 换下一个 */
      }
    }
    await sleep(300);
  }
  return null;
}

function buildLocator(page, c) {
  if (!c) return null;
  if (typeof c === 'string') return page.locator(c);
  if (c.selector) return page.locator(c.selector);
  if (c.text) return page.getByText(c.text, { exact: Boolean(c.exact) });
  if (c.role) return page.getByRole(c.role, { name: c.name });
  if (c.placeholder) return page.getByPlaceholder(c.placeholder);
  return null;
}

function describeCandidate(c) {
  if (typeof c === 'string') return c;
  return c.name || c.selector || c.text || JSON.stringify(c).slice(0, 60);
}

/** 页面上有没有登录态（有 sessionid / sid_tt 这类关键 cookie 即认为已登录） */
export async function hasLoginCookie(ctx) {
  const cookies = await ctx.cookies('https://www.douyin.com');
  const names = new Set(cookies.map((c) => c.name));
  return names.has('sessionid') || names.has('sessionid_ss') || names.has('sid_tt');
}

export async function hasCreatorCookie(ctx) {
  const cookies = await ctx.cookies('https://creator.douyin.com');
  const names = new Set(cookies.map((c) => c.name));
  return names.has('sessionid') || names.has('sid_tt') || names.has('sessionid_ss');
}

/** 把页面上的可见文本拉下来（调试/兜底用） */
export async function visibleText(page, limit = 4000) {
  try {
    const t = await page.evaluate(() => document.body?.innerText || '');
    return t.slice(0, limit);
  } catch {
    return '';
  }
}

export { log };
