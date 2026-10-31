// 登录：扫码一次，登录态留在浏览器 profile 里，之后所有工具复用。
//
// 入口选择：www.douyin.com 的登录弹窗（扫码登录）——它是所有域的统一入口，
// 二维码以 data:image/png;base64 的形式直接躺在 DOM 里，可以整张取出来给用户扫。
// 扫完之后再访问一次 creator.douyin.com，把创作者中心的会话一并建好。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, URLs } from '../config.js';
import { logger } from '../log.js';
import { sleep } from '../util.js';
import { getContext, shot } from '../browser/manager.js';
import { detectBlock, BrowserBlockedError, visibleText } from '../browser/pagekit.js';
import { apiGet } from '../douyin/client.js';
import { EP, P, baseParams } from '../douyin/params.js';
import { normalizeUser } from '../douyin/normalize.js';

const log = logger('login');

// 登录 cookie 的判定名（不同登录方式留下的不太一样，认其中任一即可）
const LOGIN_COOKIES = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss'];

async function cookieNames(ctx, domain) {
  const cookies = await ctx.cookies(domain);
  return new Set(cookies.map((c) => c.name));
}

export async function hasWwwLogin(ctx) {
  const names = await cookieNames(ctx, 'https://www.douyin.com');
  return LOGIN_COOKIES.some((n) => names.has(n));
}

export async function hasCreatorLogin(ctx) {
  const names = await cookieNames(ctx, 'https://creator.douyin.com');
  return LOGIN_COOKIES.some((n) => names.has(n));
}

/** 当前登录状态（两个域分别判断 + 能拿到的话顺手带回昵称） */
export async function getLoginState({ withProfile = true } = {}) {
  const ctx = await getContext();
  const [www, creator] = await Promise.all([hasWwwLogin(ctx), hasCreatorLogin(ctx)]);
  const state = { wwwLoggedIn: www, creatorLoggedIn: creator, loggedIn: www || creator };
  if (withProfile && www) {
    try {
      state.me = await fetchSelf();
    } catch (err) {
      state.profileError = err.message;
    }
  }
  return state;
}

/** 通过 www 的会话接口拿"我是谁" */
export async function fetchSelf() {
  // 1) query/user 只告诉我们"这是谁"，返回体里的 uid 在顶层 user_uid
  const session = await apiGet(EP.queryUser, baseParams(), { allowCodes: [8, 2154], label: 'queryUser' });
  const uid = session.user_uid || session.user?.uid;
  if (session.user) return normalizeUser(session.user);
  if (!uid) throw new Error('会话接口没有返回 user_uid（登录态可能不完整）');

  // 2) 拿 uid 换完整资料
  try {
    const payload = await apiGet(EP.selfProfile, { ...baseParams(), uid: String(uid) }, { allowCodes: [8, 2], label: 'selfProfile' });
    const user = payload.user || payload.user_info || payload.data?.user;
    if (user) return normalizeUser(user);
  } catch {
    /* 退到下一步 */
  }

  // 3) 兜底：打开"我的主页"，从站点自己发的请求里挖出我的 sec_uid，再正式查资料
  const secUid = await discoverSelfSecUid();
  if (!secUid) throw new Error(`拿不到自己的资料（uid=${uid}，也没等到主页请求）`);
  const profile = await apiGet(EP.userProfile, P.userProfile(secUid), { label: 'selfProfile' });
  if (!profile.user) throw new Error(`拿不到自己的资料（sec_uid=${secUid}）`);
  return normalizeUser(profile.user);
}

/** 打开 /user/self，从站点自己的请求 URL 里挖出当前账号的 sec_uid（最稳的一条路） */
export async function discoverSelfSecUid({ timeout = 20_000 } = {}) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  let secUid = null;
  const onReq = (req) => {
    if (secUid) return;
    const m = req.url().match(/sec_user_id=(MS4wLjABAAAA[\w-]+)/);
    if (m) secUid = m[1];
  };
  ctx.on('request', onReq);
  try {
    await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && !secUid) await sleep(500);
    return secUid;
  } finally {
    ctx.off('request', onReq);
    await page.close().catch(() => {});
  }
}

/**
 * 打开 www.douyin.com 的登录弹窗，把二维码抓出来。
 * @returns {Promise<{qrFile?:string, qrBase64?:string, screenshot?:string, url:string, text?:string}>}
 */
export async function openLoginPage() {
  const ctx = await getContext();
  // 用新标签页，避免把用户正在用的页面搞乱
  const page = await ctx.newPage();
  await page.goto(URLs.home, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT }).catch(() => {});
  await sleep(3000);

  // 点右上角"登录"
  let clicked = false;
  for (const attempt of [
    () => page.getByRole('button', { name: '登录', exact: true }).first().click({ timeout: 5000 }),
    () => page.getByText('登录', { exact: true }).first().click({ timeout: 5000 }),
  ]) {
    try {
      await attempt();
      clicked = true;
      break;
    } catch {
      /* 试下一个 */
    }
  }
  await sleep(2500);

  // 切到"扫码登录"（默认就是，个别版本会记住上次的选择）
  for (const t of ['扫码登录', '二维码登录']) {
    try {
      const loc = page.getByText(t, { exact: false }).first();
      if (await loc.count()) {
        await loc.click({ timeout: 1500 }).catch(() => {});
        await sleep(1200);
        break;
      }
    } catch {
      /* ignore */
    }
  }

  // 二维码：等一张 140px 以上的 base64 图片出现（那才是码，不是 logo）
  let qrBase64 = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !qrBase64) {
    qrBase64 = await page
      .evaluate(() => {
        for (const img of document.querySelectorAll('img')) {
          const src = img.getAttribute('src') || '';
          if (!src.startsWith('data:image/png;base64,')) continue;
          const r = img.getBoundingClientRect();
          if (r.width < 140 || r.width > 400) continue;
          if (Math.abs(r.width - r.height) > 20) continue;
          return src;
        }
        return null;
      })
      .catch(() => null);
    if (!qrBase64) await sleep(1000);
  }

  let qrFile = null;
  if (qrBase64) {
    qrFile = path.join(CONFIG.SHOT_DIR, `login-qr-${Date.now()}.png`);
    fs.writeFileSync(qrFile, Buffer.from(qrBase64.split(',')[1], 'base64'));
  }

  const full = await shot(page, 'login-page');
  const text = await visibleText(page, 400);
  return { qrFile, qrBase64, screenshot: full, url: page.url(), clicked, text };
}

/**
 * 等扫码完成。返回 true 表示登录成功（并把创作者中心会话一起建立好）。
 */
export async function waitForLogin({ timeoutSec = 180, pollMs = 2000 } = {}) {
  const ctx = await getContext();
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (await hasWwwLogin(ctx)) {
      await sleep(1500);
      // 登录成功后去创作者中心走一趟，把那边的会话建起来
      await warmCreator(ctx);
      return true;
    }
    await sleep(pollMs);
  }
  return false;
}

async function warmCreator(ctx) {
  try {
    const page = await ctx.newPage();
    await page.goto(URLs.creator, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await sleep(3000);
    const { block, detail } = await detectBlock(page);
    if (block === 'captcha') log.warn('创作者中心要求验证码，需要人工过一下', detail);
    if (!/creator-micro/.test(page.url())) {
      // 落地页也 OK，cookie 一般已经下发
      log.info(`创作者中心落地在 ${page.url()}（会话已建立）`);
    }
    await page.close().catch(() => {});
  } catch (err) {
    log.warn('预热创作者中心失败（不影响 www 已登录状态）', err.message);
  }
}

/** 清掉登录态 */
export async function clearLogin() {
  const ctx = await getContext();
  await ctx.clearCookies();
  for (const p of ctx.pages()) {
    if (/douyin\.com/.test(p.url())) await p.goto('about:blank').catch(() => {});
  }
  return true;
}

export { BrowserBlockedError, detectBlock };
