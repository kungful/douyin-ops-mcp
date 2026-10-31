// 互动：评论、回复、点赞、通知。写操作都走页面内 POST（签名由站点自己补），
// 失败时把抖音返回的 status_msg 原样给出去，方便判断是"没登录"还是"被限流"。
import { logger } from '../log.js';
import { apiGet, apiPost } from '../douyin/client.js';
import { EP, P } from '../douyin/params.js';
import { normalizeComment } from '../douyin/normalize.js';
import { getLoginState } from './login.js';

const log = logger('interact');

async function needLogin() {
  const state = await getLoginState({ withProfile: false });
  if (!state.wwwLoggedIn && !state.creatorLoggedIn) {
    const err = new Error('需要登录后才能互动：先调用 douyin_login_qrcode 扫码登录');
    err.code = 'NEED_LOGIN';
    throw err;
  }
  return state;
}

/** 评论区列表（任意作品） */
export async function listComments(awemeId, { count = 20, cursor = '0' } = {}) {
  const payload = await apiGet(EP.comments, P.comments(awemeId, { count, cursor }), { label: 'comments' });
  return {
    total: payload.total ?? null,
    hasMore: Boolean(payload.has_more),
    cursor: String(payload.cursor ?? '0'),
    items: (payload.comments || []).map(normalizeComment).filter(Boolean),
  };
}

/** 一条评论下的回复 */
export async function listReplies(awemeId, commentId, { count = 20, cursor = '0' } = {}) {
  const payload = await apiGet(EP.commentReplies, P.commentReplies(awemeId, commentId, { count, cursor }), {
    label: 'replies',
  });
  return {
    hasMore: Boolean(payload.has_more),
    cursor: String(payload.cursor ?? '0'),
    items: (payload.comments || []).map(normalizeComment).filter(Boolean),
  };
}

/**
 * 发评论 / 回复评论。
 * @param {string} awemeId
 * @param {string} text
 * @param {string} [replyCommentId] 填了就是在该评论下回复
 */
export async function publishComment(awemeId, text, replyCommentId) {
  await needLogin();
  if (!text || !text.trim()) throw new Error('评论内容不能为空');
  const params = {
    aweme_id: String(awemeId),
    text: text.trim(),
    text_extra: '[]',
    aweme_type: '0',
    ...(replyCommentId ? { reply_id: String(replyCommentId), reply_to_reply_id: '0' } : {}),
  };
  try {
    const res = await apiPost(EP.commentPublish, params, null, { label: 'commentPublish', allowCodes: [] });
    const comment = res.comment || res.data?.comment;
    return {
      ok: Boolean(res.status_code === 0),
      comment: comment ? normalizeComment(comment) : null,
      raw: { status_code: res.status_code, status_msg: res.status_msg },
    };
  } catch (err) {
    throw new Error(`评论发送失败：${err.message}`);
  }
}

/** 给作品点赞 / 取消点赞 */
export async function digg(awemeId, { unlike = false } = {}) {
  await needLogin();
  const params = { aweme_id: String(awemeId), type: unlike ? '0' : '1' };
  const res = await apiPost(EP.digg, params, null, { label: 'digg' });
  return { ok: res.status_code === 0, diggCount: res.digg_count ?? null };
}

/**
 * 通知：评论和@ / 赞 / 新增关注 的未读数。
 * 走 www 的接口；只要登录就能读，不依赖创作者中心。
 */
export async function unreadCount() {
  await needLogin();
  // 这个接口抖音没有公开稳定文档，失败就明确告诉调用方
  try {
    const res = await apiGet(
      '/aweme/v1/web/notification/unread/count/',
      { device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1', version_code: '290100', version_name: '29.1.0', platform: 'PC' },
      { allowCodes: [8, 2154, 2], label: 'unread' },
    );
    return { ok: true, raw: res };
  } catch (err) {
    return { ok: false, error: err.message, hint: '读未读数失败时，可以改用 douyin_notifications 从消息页读取' };
  }
}

/** 从 www 消息页读通知列表（DOM 兜底） */
export async function notifications({ limit = 20 } = {}) {
  await needLogin();
  const { getContext } = await import('../browser/manager.js');
  const { sleep } = await import('../util.js');
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto('https://www.douyin.com/notice', { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    const items = await page.evaluate((max) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const nodes = [...document.querySelectorAll('div[class*="notice"],div[class*="message"],li')]
        .filter((el) => clean(el.innerText).length > 8 && clean(el.innerText).length < 300)
        .filter((el) => el.querySelector('img'));
      const seen = new Set();
      const out = [];
      for (const el of nodes) {
        const t = clean(el.innerText);
        if (seen.has(t)) continue;
        seen.add(t);
        out.push({ text: t, avatar: el.querySelector('img')?.src || null });
        if (out.length >= max) break;
      }
      return out;
    }, limit);
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
    return { ok: items.length > 0, items, textFallback: items.length ? undefined : text };
  } finally {
    await page.close().catch(() => {});
  }
}
