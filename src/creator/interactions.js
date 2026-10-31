// 互动：评论、回复、点赞、待回复评论。
//
// 关于"通知"：抖音 Web 端已经没有可用的通知中心页面（/notice、/messages、/notification 全是
// 404，"页面不见啦"），创作者中心的互动入口也会被重定向回首页。与其假装能读，不如换成
// 运营真正要先处理的东西：**我的作品下还没回复的评论**——数据来自公开评论接口，稳定可测。
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
  // 先试页面 UI（Web 写接口目前会被风控拒掉，status_code=8）
  try {
    const ui = await publishCommentByUi(awemeId, text, replyCommentId);
    if (ui.ok) return ui;
    log.warn('评论区 UI 没走通，退回接口试试');
  } catch (err) {
    log.warn('评论区 UI 异常，退回接口', err.message);
  }
  const params = {
    aweme_id: String(awemeId),
    text: text.trim(),
    text_extra: '[]',
    aweme_type: '0',
    ...(replyCommentId ? { reply_id: String(replyCommentId), reply_to_reply_id: '0' } : {}),
  };
  try {
    const res = await apiPost(EP.commentPublish, params, null, { label: 'commentPublish' });
    const comment = res.comment || res.data?.comment;
    return {
      ok: res.status_code === 0,
      comment: comment ? normalizeComment(comment) : null,
      raw: { status_code: res.status_code, status_msg: res.status_msg },
    };
  } catch (err) {
    throw new Error(`评论发送失败：${err.message}`);
  }
}

/**
 * 给作品点赞 / 取消点赞。
 * 实测：Web 写接口 /aweme/v1/web/commit/item/digg/ 直接返回 status_code=4（服务器打瞌睡），
 * 但**在作品页点那颗心是能点的**，所以这里走 UI，点完读回数字校验。
 */
export async function digg(awemeId, { unlike = false } = {}) {
  await needLogin();
  const { getContext } = await import('../browser/manager.js');
  const ctx = await getContext();
  const page = await openVideoPage(ctx, awemeId, '[data-e2e="video-player-digg"]');
  try {
    const before = await page.evaluate(() => document.querySelector('[data-e2e="video-player-digg"]')?.innerText.trim() || null);
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('[data-e2e="video-player-digg"]');
      if (!el) return false;
      el.click();
      return true;
    });
    if (!clicked) throw new Error('点赞按钮点不动');
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => document.querySelector('[data-e2e="video-player-digg"]')?.innerText.trim() || null);
    return {
      ok: before !== after,
      changed: before !== after,
      before,
      after,
      note: before === after ? '点了但数字没变（可能已经点过赞了）' : '点赞状态已切换',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/** 打开作品页并等到指定元素出现（抖音偶发慢，允许重载一次） */
async function openVideoPage(ctx, awemeId, selector, { timeout = 30_000 } = {}) {
  const page = await ctx.newPage();
  try {
    let ready = null;
    for (let attempt = 0; attempt < 2 && !ready; attempt++) {
      if (attempt > 0) await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      else await page.goto(`https://www.douyin.com/video/${awemeId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      ready = await page.waitForSelector(selector, { timeout, state: 'attached' }).catch(() => null);
    }
    if (!ready) {
      await page.close().catch(() => {});
      throw new Error(`作品页 ${selector} 加载不出来（两次共 ${Math.round((timeout * 2) / 1000)}s 超时；抖音这会儿可能限流了，等几分钟再试）`);
    }
    await page.waitForTimeout(1500);
    return page;
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

/** 在作品页的评论区里发评论（UI 路径，签名/风控由页面自己处理） */
async function publishCommentByUi(awemeId, text, replyCommentId) {
  const { getContext } = await import('../browser/manager.js');
  const ctx = await getContext();
  const page = await openVideoPage(ctx, awemeId, '[data-e2e="feed-comment-icon"]');
  try {
    // 把评论区滚进视野，再点开
    await page.locator('[data-e2e="comment-list"], [data-e2e="feed-comment-icon"]').first().scrollIntoViewIfNeeded().catch(() => {});
    await page.evaluate(() => document.querySelector('[data-e2e="feed-comment-icon"]')?.click());
    await page.waitForTimeout(2000);

    if (replyCommentId) {
      // 点那条评论的「回复」
      await page.evaluate((cid) => {
        const nodes = [...document.querySelectorAll(`[data-comment-id="${cid}"], [id*="${cid}"]`)];
        const host = nodes[0]?.closest('[class*="comment"]') || nodes[0];
        const btn = [...(host?.querySelectorAll('*') || [])].find((e) => e.children.length === 0 && /回复/.test(e.textContent || ''));
        btn?.click();
      }, replyCommentId);
      await page.waitForTimeout(1500);
    }

    // 找输入框：评论区那句话是一个"假输入框"（div 里写着"留下你的精彩评论吧"），
    // 要先点它才会变成真正可编辑的区域，所以两种都试。
    let found = await page.evaluate(() => {
      const cands = [...document.querySelectorAll('[contenteditable="true"],textarea')];
      for (const el of cands) {
        const r = el.getBoundingClientRect();
        if (r.width < 60) continue;
        const ph = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '').toString();
        const txt = (el.innerText || '').trim();
        if (/评论|说点什么|善语/.test(ph) || /留下你的精彩评论/.test(txt)) {
          el.focus();
          return { ok: true, how: 'contenteditable', ph: ph || txt.slice(0, 20) };
        }
      }
      return { ok: false };
    });

    if (!found.ok) {
      // 点"留下你的精彩评论吧"把它激活
      const activated = await page.evaluate(() => {
        const el = [...document.querySelectorAll('*')].find(
          (e) => e.children.length === 0 && /留下你的精彩评论/.test((e.textContent || '').trim()),
        );
        if (!el) return false;
        (el.closest('[class*="comment"]') || el).click();
        el.click();
        return true;
      });
      if (activated) await page.waitForTimeout(1200);
      found = await page.evaluate(() => {
        const cands = [...document.querySelectorAll('[contenteditable="true"],textarea')];
        for (const el of cands) {
          const r = el.getBoundingClientRect();
          if (r.width < 60) continue;
          if (el.getAttribute('data-e2e') === 'searchbar-input') continue;
          el.focus();
          return { ok: true, how: 'activated', tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 30) };
        }
        return { ok: false };
      });
    }
    if (!found.ok) return { ok: false, reason: '没找到评论输入框（评论区结构可能变了）' };

    await page.keyboard.type(text, { delay: 25 });
    await page.waitForTimeout(800);
    const sent = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button,[class*="send"],[class*="submit"]')].find((b) => {
        const t = (b.innerText || '').trim();
        const r = b.getBoundingClientRect();
        return r.width > 0 && /发送|发布|评论/.test(t);
      });
      if (btn) {
        btn.click();
        return (btn.innerText || '').trim().slice(0, 6) || 'button';
      }
      return null;
    });
    if (!sent) await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
    const appeared = await page.evaluate(
      (t) => (document.body.innerText || '').includes(t.slice(0, 12)),
      text,
    );
    return { ok: appeared, via: 'ui', inputFound: found.ph, sentBy: sent || 'enter', note: appeared ? '评论已发（页面能看到）' : '点了发送但页面上没看到内容' };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * 待回复评论：扫我最近几条作品，找出别人发的、我没有回复过的评论。
 * @param {{limit?: number, works?: number}} opts
 */
export async function notifications({ limit = 20, works = 5 } = {}) {
  const state = await needLogin();
  const me = state.me || (await import('./login.js').then((m) => m.fetchSelf()));
  const { fetchUserPosts } = await import('../douyin/parse.js');

  const posts = await fetchUserPosts(me.secUid, { count: Math.max(1, works) });
  const pending = [];
  const perWork = [];

  for (const post of posts.items.slice(0, works)) {
    let comments;
    try {
      comments = await listComments(post.id, { count: 20 });
    } catch (err) {
      perWork.push({ awemeId: post.id, error: err.message });
      continue;
    }
    let pendingHere = 0;
    for (const c of comments.items) {
      const mine = c.user?.secUid && c.user.secUid === me.secUid;
      if (mine) continue;
      // 我在这条评论下回复过吗（接口会带回前几条二级回复）
      const repliedByMe = (c.replies || []).some((r) => r.user?.secUid === me.secUid);
      if (repliedByMe) continue;
      pendingHere += 1;
      pending.push({
        awemeId: post.id,
        awemeDesc: (post.desc || '').slice(0, 40),
        commentId: c.id,
        text: c.text,
        user: c.user?.nickname,
        ip: c.ipLabel,
        digg: c.diggCount,
        createdAt: c.createdAt,
      });
    }
    perWork.push({ awemeId: post.id, desc: (post.desc || '').slice(0, 30), total: comments.total, pending: pendingHere });
  }

  pending.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    ok: true,
    scannedWorks: posts.items.slice(0, works).length,
    pendingTotal: pending.length,
    pending: pending.slice(0, limit),
    perWork,
    note: '抖音 Web 没有通知中心页面（/notice 等接口 404），这里用"评论待回复"替代通知；回复用 douyin_comment_publish 传 commentId',
  };
}

/** 待回复评论数（按作品分组） */
export async function unreadCount({ works = 5 } = {}) {
  const res = await notifications({ limit: 1, works });
  return {
    ok: true,
    pendingTotal: res.pendingTotal,
    perWork: res.perWork,
    note: '数字 = 最近几条作品下别人发的、我没回复过的评论条数',
  };
}
