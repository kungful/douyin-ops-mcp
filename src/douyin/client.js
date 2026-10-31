// 接口调用层：所有抖音 Web API 都在页面内用 fetch 发。
//
// 为什么不在 Node 里直接 HTTP：抖音给每个 /aweme/v1/web/* 请求都要求 a_bogus 签名
// （由站点的 bdms.js 注入，算法在字节码 VM 里）。在页面上下文里发请求，站点自己会把
// a_bogus / msToken / 指纹 cookie 全部补齐——签名规则变了我们也不用跟。
// 代价是必须有真实浏览器；而这本来就是"运营账号"的必要条件（发布、看数据都得登录）。
import { CONFIG } from '../config.js';
import { logger } from '../log.js';
import { getApiPage, shot } from '../browser/manager.js';
import { detectBlock, BrowserBlockedError } from '../browser/pagekit.js';
import { lenientJson } from './json.js';

const log = logger('api');

let chain = Promise.resolve();
/** 同一页面上的 evaluate 串行执行，避免并发互相踩 */
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** 接口层错误，带抖音返回的 status_code，方便上层给出"要登录/参数错"的提示 */
export class DouyinApiError extends Error {
  constructor(path, status, payload) {
    const code = payload?.status_code;
    const msg = payload?.status_msg || payload?._raw || '';
    const hint = HINTS[code] || '';
    super(`抖音接口 ${path} 返回异常（status_code=${code ?? '?'}）${msg ? `：${String(msg).slice(0, 120)}` : ''}${hint ? `。${hint}` : ''}`);
    this.path = path;
    this.code = code;
    this.payload = payload;
    this.hint = hint;
  }
}

const HINTS = {
  2483: '这个能力要求登录：先 douyin_login_qrcode 扫码',
  8: '请求被风控拒绝，稍后重试或先登录',
  2: '参数不合法（检查 sec_uid / aweme_id 是否正确）',
  5: '该内容不可见（可能已删除、仅自己可见或需要登录）',
  2154: '需要登录态或更完整的 cookie',
  10011: '参数不被接受',
  10020: '这条内容对当前身份不可见',
};

/**
 * 在抖音页面里发一个 GET 请求。
 * @param {string} path 例如 /aweme/v1/web/aweme/detail/
 * @param {Record<string,string>} params
 * @returns {Promise<any>} 解析后的 JSON
 */
export async function apiGet(path, params, { page, allowCodes = [], label = '', timeout, retries = 1 } = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://www.douyin.com${path}?${qs}`;
  return withRetry(
    () => callInPage(path, url, { page, allowCodes, label, method: 'GET', timeout }),
    { retries, label: label || path },
  );
}

/** 抖音偶尔会把某个请求拖到超时（风控抽样），换一次页面重试通常就好 */
async function withRetry(fn, { retries = 1, label = 'api' } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      const retryable = /abort|timeout|超时|signal is aborted|net::ERR/i.test(String(err?.message || ''));
      if (!retryable || i === retries) break;
      log.warn(`${label} 超时/中断，重试第 ${i + 1} 次`);
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw lastErr;
}

/**
 * 在抖音页面里发一个 POST（评论、点赞等写操作）。
 */
export async function apiPost(path, params, body, { page, allowCodes = [], label = '' } = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://www.douyin.com${path}?${qs}`;
  return callInPage(path, url, { page, allowCodes, label, method: 'POST', body });
}

async function callInPage(path, url, { page: givenPage, allowCodes = [], label = '', method = 'GET', body, timeout } = {}) {
  return serialize(async () => {
    const page = givenPage || (await getApiPage());
    const started = Date.now();
    const raw = await page.evaluate(
      async ({ u, method, body, timeout }) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeout);
        try {
          const init = {
            credentials: 'include',
            signal: ctl.signal,
            method,
            headers: { referer: 'https://www.douyin.com/', ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
          };
          if (body) init.body = typeof body === 'string' ? body : new URLSearchParams(body).toString();
          const res = await fetch(u, init);
          const text = await res.text();
          return { status: res.status, text };
        } catch (err) {
          return { status: 0, text: '', error: String(err) };
        } finally {
          clearTimeout(timer);
        }
      },
      { u: url, method, body: body ?? null, timeout: timeout || CONFIG.API_TIMEOUT },
    );

    if (raw.status === 0) {
      const err = new Error(`抖音接口请求失败（${path}）：${raw.error || '网络错误'}`);
      err.retryable = /abort|timeout/i.test(String(raw.error));
      throw err;
    }
    if (raw.status === 403 || raw.status === 401) {
      const file = await shot(page, 'api-403');
      const { block } = await detectBlock(page);
      if (block) throw new BrowserBlockedError(block, `接口 ${path} 403`, file, page.url());
      throw new Error(`抖音接口 ${path} 返回 HTTP ${raw.status}（cookie/签名可能已失效，试试重新登录）。诊断截图：${file || '无'}`);
    }

    const payload = lenientJson(raw.text);
    if (payload == null) {
      // 不是 JSON：多半拿到了验证码/壳页
      const { block, detail } = await detectBlock(page);
      const file = await shot(page, 'api-nonjson');
      if (block) throw new BrowserBlockedError(block, detail, file, page.url());
      throw new Error(`抖音接口 ${path} 返回了非 JSON 内容（HTTP ${raw.status}，${raw.text.length} 字节）：${raw.text.slice(0, 160)}`);
    }

    const code = payload.status_code ?? 0;
    log.debug(`${label || path} status_code=${code} ${Date.now() - started}ms`);
    if (code !== 0 && !allowCodes.includes(code)) {
      throw new DouyinApiError(path, payload.status_code, payload);
    }
    return payload;
  });
}
