// 把用户/agent 给的各种输入（分享文案、短链、长链、裸 aweme_id、sec_uid）
// 解析成确定的对象，再拉结构化数据。
import { logger } from '../log.js';
import { findDouyinTarget, retry, sleep } from '../util.js';
import { apiGet, DouyinApiError } from './client.js';
import { EP, P } from './params.js';
import { normalizeAweme, normalizeUser } from './normalize.js';
import { captureJson } from './capture.js';

const log = logger('parse');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * 把一个链接追到最终的规范地址（跟随 v.douyin.com 短链跳转）。
 * 不依赖浏览器，纯 HTTP 就够。
 */
export async function resolveRedirect(url, { hops = 6 } = {}) {
  let current = url;
  for (let i = 0; i < hops; i++) {
    let res;
    try {
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      });
    } catch {
      break;
    }
    const loc = res.headers.get('location');
    if (!loc) break;
    current = new URL(loc, current).toString();
    if (!/v\.douyin\.com|douyin\.com\/share/.test(current)) break;
  }
  return current;
}

/** 从任意 URL 里抠出对象 */
export function parseTargetFromUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const path = url.pathname;
  const modal = url.searchParams.get('modal_id') || url.searchParams.get('aweme_id');
  if (modal && /^\d{15,25}$/.test(modal)) return { kind: 'aweme', awemeId: modal, url: rawUrl };
  const m = path.match(/\/(video|note|share\/video|share\/note)\/(\d{15,25})/);
  if (m) return { kind: 'aweme', awemeId: m[2], isNote: m[1].includes('note'), url: rawUrl };
  const u = path.match(/\/user\/(MS4wLjABAAAA[\w-]+)/);
  if (u) return { kind: 'user', secUid: u[1], url: rawUrl };
  const mix = url.searchParams.get('mix_id') || path.match(/\/collection\/(\d+)/)?.[1];
  if (mix) return { kind: 'mix', mixId: mix, url: rawUrl };
  const music = path.match(/\/music\/(\d+)/);
  if (music) return { kind: 'music', musicId: music[1], url: rawUrl };
  return null;
}

/**
 * 统一定位：接受分享文案 / 链接 / 裸 id / sec_uid。
 * @returns {Promise<{kind:'aweme'|'user'|'mix'|'music', awemeId?:string, secUid?:string, mixId?:string, musicId?:string, url?:string}>}
 */
export async function locate(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('没有给出链接或 ID');

  // "我的主页"：/user/self 没有 sec_uid，用浏览器跑一趟换出来
  if (/douyin\.com\/user\/self/.test(text)) {
    const { discoverSelfSecUid } = await import('../creator/login.js');
    const secUid = await discoverSelfSecUid();
    if (secUid) return { kind: 'user', secUid, url: text };
    throw new Error('没能识别出当前登录账号的 sec_uid（可能未登录）');
  }

  // 已经是一个明确的 URL
  if (/^https?:\/\//.test(text)) {
    const direct = parseTargetFromUrl(text);
    if (direct) {
      if (direct.kind === 'aweme' || direct.kind === 'user') return direct;
      return direct;
    }
    const resolved = await resolveRedirect(text);
    const t = parseTargetFromUrl(resolved);
    if (t) return t;
    throw new Error(`无法从这个链接里认出作品/用户：${resolved.slice(0, 120)}`);
  }

  // 分享文案里夹着链接
  const found = findDouyinTarget(text);
  if (found) {
    if (found.kind === 'url') return locate(found.value);
    if (found.kind === 'sec_uid') return { kind: 'user', secUid: found.value };
    return { kind: 'aweme', awemeId: found.value };
  }
  const sec = text.match(/MS4wLjABAAAA[\w-]{10,}/);
  if (sec) return { kind: 'user', secUid: sec[0] };
  if (/^\d{15,25}$/.test(text)) return { kind: 'aweme', awemeId: text };
  throw new Error('没能识别出抖音作品/用户：请粘贴完整的分享链接或文案');
}

/** 拉单个作品详情（含图集），带一次兜底采集 */
export async function fetchAweme(awemeId, { raw = false } = {}) {
  try {
    const payload = await retry(() => apiGet(EP.detail, P.detail(awemeId), { label: 'detail' }), {
      tries: 2,
      label: '拉取作品详情',
    });
    const aweme = payload.aweme_detail || payload.aweme_details?.[0];
    if (aweme) return normalizeAweme(aweme, { includeRaw: raw });
  } catch (err) {
    log.warn('detail 接口失败，转兜底采集:', err.message);
  }
  // 兜底：打开作品页，抓站点自己的请求
  const captured = await captureJson(`https://www.douyin.com/video/${awemeId}`, /aweme\/v1\/web\/aweme\/detail/);
  const aweme = captured?.json?.aweme_detail;
  if (!aweme) throw new DouyinApiError(EP.detail, 5, { status_msg: '作品详情拿不到（可能已删除或仅粉丝可见）' });
  return normalizeAweme(aweme, { includeRaw: raw });
}

/** 拉用户资料 */
export async function fetchUser(secUid, { raw = false } = {}) {
  const payload = await apiGet(EP.userProfile, P.userProfile(secUid), { label: 'user' });
  const user = payload.user;
  if (!user) throw new DouyinApiError(EP.userProfile, payload.status_code, payload);
  return normalizeUser(user, { includeRaw: raw });
}

/** 拉用户作品（游标分页） */
export async function fetchUserPosts(secUid, { count = 20, cursor = '0' } = {}) {
  const payload = await apiGet(EP.post, P.post(secUid, { count, cursor }), { label: 'post' });
  const list = payload.aweme_list || [];
  return {
    items: list.map((a) => normalizeAweme(a)),
    hasMore: Boolean(payload.has_more),
    cursor: String(payload.max_cursor ?? '0'),
  };
}

/** 拉评论 */
export async function fetchComments(awemeId, { count = 20, cursor = '0' } = {}) {
  const payload = await apiGet(EP.comments, P.comments(awemeId, { count, cursor }), { label: 'comments' });
  const { normalizeComment } = await import('./normalize.js');
  return {
    total: payload.total ?? null,
    items: (payload.comments || []).map(normalizeComment).filter(Boolean),
    hasMore: Boolean(payload.has_more),
    cursor: String(payload.cursor ?? '0'),
  };
}

/** 关键词搜索视频（需要登录） */
export async function searchVideos(keyword, { count = 10, offset = 0, sort = '0' } = {}) {
  const payload = await apiGet(EP.searchVideo, P.searchVideo(keyword, { count, offset: String(offset), sort_type: sort }), {
    label: 'search',
  });
  const list = payload.data || [];
  return list
    .map((d) => {
      const a = d.aweme_info || d.aweme_mix_info?.aweme_list?.[0];
      return a ? normalizeAweme(a) : null;
    })
    .filter(Boolean);
}

/** 关键词搜索用户（需要登录） */
export async function searchUsers(keyword, { count = 10, offset = 0 } = {}) {
  const payload = await apiGet(EP.searchUser, P.searchUser(keyword, { count, offset: String(offset) }), { label: 'searchUser' });
  const list = payload.user_list || payload.data || [];
  return list
    .map((d) => d.user_info?.user || d.user)
    .filter(Boolean)
    .map((u) => normalizeUser(u));
}

/** 热点视频流（不需要登录，直接给一整屏作品） */
export async function fetchHotSpotVideos({ count = 20, tagId = '', cursor = '0' } = {}) {
  const payload = await apiGet(EP.hotSpot, P.hotSpot({ count, tag_id: tagId, cursor }), { label: 'hotspot' });
  const list = payload.aweme_list || payload.data || [];
  const items = Array.isArray(list) ? list.map((a) => normalizeAweme(a.aweme_info || a)).filter(Boolean) : [];
  return { items, cursor: String(payload.cursor ?? '0'), hasMore: Boolean(payload.has_more) };
}

export { sleep };
