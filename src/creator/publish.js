// 发布：视频 / 图文，走 creator.douyin.com 的真实上传流程。
//
// 这里的每一步都可能因为平台改版而失效，所以：
//   · 每个动作都有多个候选选择器，命中哪个写进 steps 报告
//   · dryRun=true 时只到"发布按钮就在眼前"，截图给人看，不点
//   · 任何一步失败都截图，把页面可见文本一起带回去，方便立刻定位
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, URLs } from '../config.js';
import { logger } from '../log.js';
import { sleep } from '../util.js';
import { getCreatorPage, shot } from '../browser/manager.js';
import { hasCreatorLogin } from './login.js';
import { probe, checkPublishable } from '../douyin/media.js';

const log = logger('publish');

const PUBLISH_URL_RE = /creator-micro\/content\/publish/;

/** 发布前置检查：素材存在、格式能过、已登录创作者中心 */
export async function preflight({ files = [], kind = 'video', scheduleAt = null }) {
  const problems = [];
  const items = [];
  for (const f of files) {
    if (!fs.existsSync(f)) {
      problems.push(`文件不存在：${f}`);
      continue;
    }
    const stat = fs.statSync(f);
    const meta = kind === 'video' ? await probe(f) : null;
    items.push({ file: f, bytes: stat.size, meta });
    if (kind === 'video') problems.push(...checkPublishable(meta));
  }
  if (kind === 'images' && files.length === 0) problems.push('图文发布至少要 1 张图片');
  if (kind === 'images' && files.length > 35) problems.push('图文最多 35 张图');
  if (scheduleAt) {
    const t = new Date(scheduleAt.replace(/\//g, '-').replace(' ', 'T'));
    if (Number.isNaN(t.getTime())) problems.push(`定时时间看不懂：${scheduleAt}（要 YYYY-MM-DD HH:mm）`);
    else if (t.getTime() < Date.now() + 60_000) problems.push('定时时间要至少比现在晚 1 分钟');
    else if (t.getTime() > Date.now() + 14 * 24 * 3600 * 1000) problems.push('定时最多提前 14 天');
  }
  return { problems, items };
}

/**
 * 把素材上传到创作者中心并发布。
 * @param {object} opts
 * @param {'video'|'images'} opts.kind
 * @param {string[]} opts.files 本地绝对路径
 * @param {string} [opts.title] 作品标题（视频 ≤30 字，图文 ≤20 字）
 * @param {string} [opts.desc] 正文/简介，可含 #话题
 * @param {string[]} [opts.topics] 额外话题（不带 #）
 * @param {string} [opts.coverFile] 自定义封面图
 * @param {string} [opts.scheduleAt] 'YYYY-MM-DD HH:mm'
 * @param {boolean} [opts.dryRun] 只填不点发布
 * @param {boolean} [opts.keepOpen] 停在页面上，等人接手
 */
export async function publish(opts) {
  const {
    kind = 'video',
    files = [],
    title = '',
    desc = '',
    topics = [],
    coverFile = '',
    scheduleAt = '',
    dryRun = false,
    keepOpen = false,
  } = opts;

  const steps = [];
  const note = (step, ok, info) => {
    steps.push({ step, ok, info });
    log[ok ? 'info' : 'warn'](`[${ok ? 'ok' : 'fail'}] ${step}${info ? `：${info}` : ''}`);
  };

  const pre = await preflight({ files, kind, scheduleAt });
  if (pre.problems.length) {
    return {
      ok: false,
      stage: 'preflight',
      problems: pre.problems,
      hint: '先修掉这些素材/参数问题再发布',
      steps,
    };
  }

  const page = await getCreatorPage();
  if (!(await hasCreatorLogin(page.context()))) {
    return {
      ok: false,
      stage: 'login',
      problems: ['创作者中心未登录'],
      hint: '先调用 douyin_login_qrcode 扫码登录（登录态会持久保存）',
      steps,
    };
  }

  try {
    // 1. 打开上传页
    await page.goto(URLs.creatorUpload, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT });
    await sleep(2000);
    note('打开上传页', true, page.url());

    // 2. 选中文件
    const acceptHint = kind === 'video' ? 'video' : 'image';
    const input = await pickFileInput(page, acceptHint);
    if (!input) {
      const file = await shot(page, 'publish-noinput');
      note('找到上传控件', false, `没有 input[type=file]（${kind}）`);
      return { ok: false, stage: 'upload-input', screenshot: file, steps, text: await pageText(page) };
    }
    await input.setInputFiles(files);
    note('选择文件', true, files.map((f) => path.basename(f)).join(', '));

    // 3. 等进入发布编辑页
    const entered = await waitFor(() => PUBLISH_URL_RE.test(page.url()), { timeout: 60_000, poll: 700 });
    note('进入发布编辑页', entered, page.url());
    await sleep(2500);

    // 4. 等上传完成（发布按钮可用 && 没有"上传中"）
    const uploaded = await waitForUploaded(page, { timeout: kind === 'video' ? 20 * 60_000 : 5 * 60_000 });
    note('媒体上传完成', uploaded, uploaded ? '' : '超时：文件可能太大或网络慢');
    if (!uploaded) {
      const file = await shot(page, 'publish-uploading');
      return { ok: false, stage: 'uploading', screenshot: file, steps, text: await pageText(page) };
    }

    // 5. 标题
    if (title) {
      const hit = await typeTitle(page, title, kind);
      note('填写标题', Boolean(hit), hit ? `命中 ${hit}` : '没找到标题输入框（可能平台改版）');
    }

    // 6. 简介 + 话题
    const descText = [desc, ...topics.map((t) => (String(t).startsWith('#') ? t : `#${t}`))].filter(Boolean).join(' ');
    if (descText) {
      const hit = await typeDescription(page, descText, topics);
      note('填写简介/话题', Boolean(hit), hit ? `命中 ${hit}` : '没找到简介编辑区');
    }

    // 7. 封面（可选，失败不算致命）
    if (coverFile && fs.existsSync(coverFile)) {
      const ok = await setCover(page, coverFile);
      note('设置封面', ok, ok ? path.basename(coverFile) : '自动封面流程没走通（不致命）');
    }

    // 8. 定时发布
    if (scheduleAt) {
      const ok = await setSchedule(page, scheduleAt);
      note('设置定时发布', ok, ok ? scheduleAt : '没找到定时发布控件');
    }

    // 9. 停在这里等人看
    if (dryRun || keepOpen) {
      const file = await shot(page, 'publish-preview');
      note('停在预览页（未点发布）', true, file || '');
      return {
        ok: true,
        stage: 'preview',
        dryRun: Boolean(dryRun),
        screenshot: file,
        url: page.url(),
        steps,
        text: await pageText(page),
        hint: dryRun
          ? '检查截图确认无误后，再次调用并把 dryRun 设为 false 就会真的发布'
          : '浏览器已停在发布页，你可以手动点发布或补充信息',
      };
    }

    // 10. 点发布
    const clicked = await clickPublish(page);
    note('点击发布', clicked, clicked ? `按钮文案「${clicked}」` : '没找到发布按钮');
    if (!clicked) {
      const file = await shot(page, 'publish-nobutton');
      return { ok: false, stage: 'submit', screenshot: file, steps, text: await pageText(page) };
    }

    // 11. 等结果
    const result = await waitPublishResult(page, { timeout: 120_000 });
    note('发布结果', result.ok, result.detail);
    const file = await shot(page, 'publish-result');
    return {
      ok: result.ok,
      stage: result.ok ? 'published' : 'submit',
      detail: result.detail,
      screenshot: file,
      url: page.url(),
      steps,
      text: await pageText(page),
    };
  } catch (err) {
    const file = await shot(page, 'publish-error');
    return { ok: false, stage: 'exception', error: err.message, screenshot: file, steps, text: await pageText(page) };
  }
}

// ------------------------------------------------------------------ 子步骤实现

async function pickFileInput(page, acceptHint) {
  const inputs = page.locator('input[type="file"]');
  const n = await inputs.count();
  if (!n) {
    // 有些版本要先点一下上传区域才渲染 input
    for (const t of ['上传视频', '上传图文', '点击上传', '发布视频']) {
      const loc = page.getByText(t, { exact: false }).first();
      if (await loc.count()) {
        await loc.click({ timeout: 2000 }).catch(() => {});
        await sleep(1200);
        if (await inputs.count()) break;
      }
    }
  }
  const total = await inputs.count();
  for (let i = 0; i < total; i++) {
    const el = inputs.nth(i);
    const accept = (await el.getAttribute('accept')) || '';
    if (accept.includes(acceptHint)) return el;
  }
  return total ? inputs.first() : null;
}

async function waitFor(fn, { timeout = 20_000, poll = 500 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      /* ignore */
    }
    await sleep(poll);
  }
  return false;
}

async function waitForUploaded(page, { timeout }) {
  const deadline = Date.now() + timeout;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => {
        const text = document.body?.innerText || '';
        const uploading = /上传中|正在上传|处理中|转码中|%\)/.test(text);
        const btn = [...document.querySelectorAll('button')].find((b) =>
          /^(发布|立即发布)$/.test((b.innerText || '').trim()),
        );
        return { uploading, hasBtn: Boolean(btn), disabled: btn ? btn.disabled || btn.getAttribute('aria-disabled') === 'true' : null };
      })
      .catch(() => ({ uploading: true, hasBtn: false }));
    if (state.hasBtn && !state.disabled && !state.uploading) {
      stableCount += 1;
      if (stableCount >= 3) return true;
    } else {
      stableCount = 0;
    }
    await sleep(2000);
  }
  return false;
}

async function typeTitle(page, title, kind) {
  const candidates = [
    { selector: 'input[placeholder*="标题"]', name: 'title-input' },
    { selector: 'input[placeholder*="作品"]', name: 'title-input-2' },
    { selector: '.semi-input[placeholder]', name: 'semi-input' },
    { selector: 'textarea[placeholder*="标题"]', name: 'title-textarea' },
  ];
  for (const c of candidates) {
    const loc = page.locator(c.selector).first();
    if (!(await loc.count())) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.click({ timeout: 3000 }).catch(() => {});
    await loc.fill('').catch(() => {});
    const txt = kind === 'images' ? String(title).slice(0, 20) : String(title).slice(0, 30);
    await loc.type(txt, { delay: 15 });
    return c.name;
  }
  return null;
}

async function typeDescription(page, descText, topics) {
  const candidates = [
    { selector: 'div[data-placeholder*="简介"]', name: 'desc-ce' },
    { selector: 'div[data-placeholder*="作品"]', name: 'desc-ce-2' },
    { selector: '.zone-container', name: 'zone-container' },
    { selector: 'div[contenteditable="true"]', name: 'contenteditable' },
  ];
  for (const c of candidates) {
    const loc = page.locator(c.selector).first();
    if (!(await loc.count())) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.click({ timeout: 3000 }).catch(() => {});
    await sleep(300);
    // 逐段输入，话题在末尾一个个加，给足联想框反应时间
    const plain = topics.length ? descText.replace(/#[^\s#]+/g, '').trim() : descText;
    if (plain) await page.keyboard.type(plain, { delay: 20 });
    for (const t of topics) {
      const tag = String(t).replace(/^#/, '');
      await page.keyboard.type(` #${tag}`, { delay: 40 });
      await sleep(700); // 等联想下拉
      await page.keyboard.press('Space'); // 空格确认成话题
      await sleep(250);
    }
    return c.name;
  }
  return null;
}

async function setCover(page, coverFile) {
  try {
    const openers = ['选择封面', '编辑封面', '设置封面'];
    for (const t of openers) {
      const loc = page.getByText(t, { exact: false }).first();
      if (!(await loc.count())) continue;
      await loc.click({ timeout: 3000 }).catch(() => {});
      await sleep(1800);
      // 弹窗里"上传封面"
      const up = page.getByText('上传封面', { exact: false }).first();
      if (await up.count()) await up.click({ timeout: 3000 }).catch(() => {});
      await sleep(1200);
      const inputs = page.locator('input[type="file"]');
      const n = await inputs.count();
      if (!n) break;
      const target = inputs.last();
      await target.setInputFiles(coverFile).catch(() => {});
      await sleep(2500);
      for (const c of ['完成', '确认', '确定']) {
        const btn = page.getByText(c, { exact: true }).first();
        if (await btn.count()) {
          await btn.click({ timeout: 3000 }).catch(() => {});
          await sleep(1200);
          break;
        }
      }
      return true;
    }
  } catch (err) {
    log.warn('封面设置失败', err.message);
  }
  return false;
}

async function setSchedule(page, scheduleAt) {
  try {
    const radio = page.getByText('定时发布', { exact: false }).first();
    if (!(await radio.count())) return false;
    await radio.click({ timeout: 3000 }).catch(() => {});
    await sleep(1200);
    const when = scheduleAt.replace(/\//g, '-');
    const inputs = page.locator('input[placeholder*="时间"], input[placeholder*="日期"], .semi-input[placeholder]');
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const el = inputs.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 2000 }).catch(() => {});
      await el.fill('').catch(() => {});
      await el.type(when, { delay: 30 });
      await page.keyboard.press('Enter').catch(() => {});
      await sleep(800);
      return true;
    }
    // 有些版本要手动点日历
    for (const c of ['确定', '确认']) {
      const btn = page.getByText(c, { exact: true }).first();
      if (await btn.count()) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        return true;
      }
    }
  } catch (err) {
    log.warn('定时设置失败', err.message);
  }
  return false;
}

async function clickPublish(page) {
  const candidates = [
    { role: 'button', name: '发布' },
    { role: 'button', name: '立即发布' },
    { text: '发布' },
  ];
  for (const c of candidates) {
    try {
      const loc =
        c.role === 'button' ? page.getByRole('button', { name: c.name, exact: true }) : page.getByText(c.text, { exact: true });
      const first = loc.first();
      if (!(await first.count())) continue;
      if (!(await first.isVisible().catch(() => false))) continue;
      const disabled = await first.evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true').catch(() => false);
      if (disabled) continue;
      await first.click({ timeout: 5000 });
      return c.name || c.text;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

async function waitPublishResult(page, { timeout }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => ({ text: document.body?.innerText || '', url: location.href }))
      .catch(() => ({ text: '', url: '' }));
    if (/发布成功|已发布|作品已发布/.test(state.text)) return { ok: true, detail: '页面提示发布成功' };
    if (/发布失败|上传失败|审核不通过|网络错误/.test(state.text)) {
      const m = state.text.match(/(发布失败|上传失败|审核不通过)[^\n]{0,40}/);
      return { ok: false, detail: m ? m[0] : '页面提示失败' };
    }
    if (/creator-micro\/content\/manage/.test(state.url)) return { ok: true, detail: '已跳转到作品管理页' };
    if (/验证|滑块/.test(state.text)) return { ok: false, detail: '发布时被要求安全验证，请手动完成' };
    await sleep(2000);
  }
  return { ok: false, detail: '等不到明确的发布结果（可能仍在审核/上传），请人工确认' };
}

async function pageText(page, limit = 2000) {
  try {
    return (await page.evaluate(() => document.body?.innerText || '')).slice(0, limit);
  } catch {
    return '';
  }
}
