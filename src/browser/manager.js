// Chrome 实例管理：一个持久化 profile 全程复用（登录态 + 指纹 + 风控 cookie）。
// 关键决策：抖音对无头浏览器、无登录态、新 profile 的风控极严，
// 所以这里默认「有头 Chrome + 长期复用的用户目录」，让它看起来就是用户自己在用浏览器。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CONFIG, URLs } from '../config.js';
import { logger } from '../log.js';
import { sleep } from '../util.js';

const log = logger('browser');

let contextPromise = null;
let context = null;
let closedByUs = false;

const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=IsolateOrigins,site-per-process',
  '--lang=zh-CN',
];

/** 拿到（必要时启动）持久化浏览器上下文 */
export async function getContext() {
  if (closedByUs) {
    closedByUs = false;
    contextPromise = null;
  }
  if (contextPromise) {
    const ctx = await contextPromise;
    // Chrome 被用户手动关掉时，page 会全部失效，这里重连一次
    try {
      if (ctx.browser()?.isConnected() === false) throw new Error('disconnected');
      return ctx;
    } catch {
      log.warn('浏览器已断开，重新启动');
      contextPromise = null;
    }
  }
  if (!contextPromise) {
    contextPromise = launch();
  }
  context = await contextPromise;
  return context;
}

async function launch() {
  fs.mkdirSync(CONFIG.PROFILE_DIR, { recursive: true });
  const options = {
    headless: CONFIG.HEADLESS,
    viewport: CONFIG.VIEWPORT,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: LAUNCH_ARGS,
    ignoreDefaultArgs: ['--enable-automation'],
    acceptDownloads: true,
  };
  if (CONFIG.CHROME_EXECUTABLE) options.executablePath = CONFIG.CHROME_EXECUTABLE;
  else options.channel = CONFIG.CHROME_CHANNEL;

  log.info(`启动 Chrome（${options.channel || 'executablePath'}，headless=${options.headless}）profile=${CONFIG.PROFILE_DIR}`);
  const ctx = await chromium.launchPersistentContext(CONFIG.PROFILE_DIR, options);
  ctx.setDefaultTimeout(CONFIG.NAV_TIMEOUT);
  ctx.on('close', () => {
    log.warn('浏览器上下文已关闭');
    contextPromise = null;
  });
  await installStealth(ctx);
  return ctx;
}

/** 轻量反自动化探测（比真实指纹伪造弱，主要是去掉最明显的特征） */
async function installStealth(ctx) {
  const script = () => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      if (!window.chrome) window.chrome = { runtime: {} };
    } catch {
      /* ignore */
    }
  };
  try {
    await ctx.addInitScript(script);
  } catch {
    /* 旧版 API 差异，忽略 */
  }
}

/** 关闭浏览器（MCP 退出时调用） */
export async function closeBrowser() {
  closedByUs = true;
  const ctx = context;
  contextPromise = null;
  context = null;
  try {
    await ctx?.close();
  } catch {
    /* ignore */
  }
}

function alive(page) {
  try {
    return page && !page.isClosed();
  } catch {
    return false;
  }
}

/** 找一个已经停留在 douyin.com 的页面（接口调用必须在这个 origin 里做，签名由站点自己加） */
async function findPage(ctx, hostTest) {
  for (const p of ctx.pages()) {
    if (!alive(p)) continue;
    const url = p.url() || '';
    if (hostTest(url)) return p;
  }
  return null;
}

/**
 * 用于接口调用的页面：必须在 www.douyin.com origin 内，
 * 站点自己的 bdms.js 会给 /aweme/v1/web/* 的 fetch 自动补 a_bogus 与 msToken。
 */
export async function getApiPage() {
  const ctx = await getContext();
  let page = await findPage(ctx, (u) => /^https:\/\/(www|www-hj)\.douyin\.com\//.test(u));
  if (page) return page;
  page = await ctx.newPage();
  log.info('打开接口页 www.douyin.com/hot');
  await page.goto(URLs.hot, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT });
  await sleep(2500);
  return page;
}

/** 用于创作者中心操作的页面 */
export async function getCreatorPage() {
  const ctx = await getContext();
  let page = await findPage(ctx, (u) => /^https:\/\/creator\.douyin\.com\//.test(u));
  if (page) return page;
  page = await ctx.newPage();
  await page.goto(URLs.creator, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT });
  return page;
}

/** 当前所有页面摘要，方便 agent 知道浏览器在哪儿 */
export async function listPages() {
  const ctx = await getContext();
  return ctx.pages().map((p) => ({ url: safeUrl(p.url()), title: '' }));
}

function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.origin + url.pathname;
  } catch {
    return u;
  }
}

/** 统一导出 cookies（给 HTTP 兜底路径 / 诊断用） */
export async function getCookies(domain = 'https://www.douyin.com') {
  const ctx = await getContext();
  const cookies = await ctx.cookies(domain);
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    expires: c.expires,
  }));
}

export function screenshotPath(tag = 'shot') {
  const file = path.join(CONFIG.SHOT_DIR, `${tag}-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

export async function shot(page, tag) {
  try {
    const file = screenshotPath(tag);
    await page.screenshot({ path: file });
    return file;
  } catch {
    return null;
  }
}
