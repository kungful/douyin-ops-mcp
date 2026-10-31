// 发布：视频 / 图文，走 creator.douyin.com 的真实上传流程。
//
// 这里的每一步都可能因为平台改版而失效，所以：
//   · 每个动作都有多个候选选择器，命中哪个写进 steps 报告
//   · 每次填写都读回校验（标题读 inputValue，描述读编辑器 innerText）
//   · dryRun=true 时只到"发布按钮就在眼前"，截图给人看，不点
//   · 点完发布不等"页面跳转"就算完 —— 抖音会先提交再后台上传，
//     必须等到上传进度条消失，否则关掉浏览器就把上传掐断了
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, URLs } from '../config.js';
import { logger } from '../log.js';
import { sleep } from '../util.js';
import { getCreatorPage, shot } from '../browser/manager.js';
import { hasCreatorLogin } from './login.js';
import { probe, checkPublishable } from '../douyin/media.js';

const log = logger('publish');

const PUBLISH_URL_RE = /creator-micro\/content\/(post|publish)/;

/** 发布前置检查：素材存在、格式能过、定时参数合法、已登录创作者中心 */
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
 * @param {string} [opts.title] 作品标题（≤30 字）
 * @param {string} [opts.desc] 作品描述（≤1000 字）
 * @param {string[]} [opts.topics] 话题（不带 #）
 * @param {string} [opts.coverFile] 自定义封面
 * @param {string} [opts.scheduleAt] 'YYYY-MM-DD HH:mm'
 * @param {boolean} [opts.dryRun] 只填不点发布
 * @param {boolean} [opts.keepOpen] 停在页面上
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
    return { ok: false, stage: 'preflight', problems: pre.problems, hint: '先修掉这些素材/参数问题再发布', steps };
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
    note('打开上传页', true, page.url());

    // 2. 选中文件（等 React 挂载出上传控件）
    const acceptHint = kind === 'video' ? 'video' : 'image';
    const via = await uploadFiles(page, files, acceptHint);
    if (!via) {
      const file = await shot(page, 'publish-noinput');
      note('找到上传控件', false, `60 秒内没等到 input[type=file]（${kind}）`);
      return { ok: false, stage: 'upload-input', screenshot: file, steps, text: await pageText(page) };
    }
    note('选择文件', true, `${files.map((f) => path.basename(f)).join(', ')}（经 ${via}）`);

    // 3. 等进入发布编辑页
    const entered = await waitFor(() => PUBLISH_URL_RE.test(page.url()), { timeout: 60_000, poll: 700 });
    note('进入发布编辑页', entered, page.url());
    await sleep(2500);

    // 4. 等平台认为媒体就绪（发布按钮可用 + 预览视频有元数据）
    const uploaded = await waitForMediaReady(page, { timeout: kind === 'video' ? 20 * 60_000 : 5 * 60_000 });
    note('媒体就绪', uploaded, uploaded ? '' : '超时：文件可能太大或网络慢');
    if (!uploaded) {
      const file = await shot(page, 'publish-uploading');
      return { ok: false, stage: 'uploading', screenshot: file, steps, text: await pageText(page) };
    }

    // 5. 标题（读回校验）
    if (title) {
      const hit = await typeTitle(page, title, kind);
      note('填写标题', Boolean(hit), hit ? `命中 ${hit}` : '标题没写进去（找不到输入框或读回为空）');
    }

    // 6. 描述（鼠标点进编辑器 + insertText，读回校验）
    if (desc) {
      const hit = await typeDescription(page, desc);
      note('填写作品描述', Boolean(hit), hit ? `命中 ${hit}` : '描述没写进去（编辑器没聚焦）');
    }

    // 7. 话题（走页面自带的「#添加话题」，读回校验）
    if (topics.length) {
      const { added, verified } = await addTopics(page, topics);
      note('添加话题', verified >= topics.length, `${verified}/${topics.length}（点了 ${added} 次入口）`);
    }

    // 8. 封面（可选，失败不致命）
    if (coverFile && fs.existsSync(coverFile)) {
      const ok = await setCover(page, coverFile);
      note('设置封面', ok, ok ? path.basename(coverFile) : '自定义封面流程没走通（不致命，用平台自动封面）');
    }

    // 9. 定时发布
    if (scheduleAt) {
      const ok = await setSchedule(page, scheduleAt);
      note('设置定时发布', ok, ok ? scheduleAt : '没找到定时发布控件');
    }

    // 10. 预览模式
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
          ? '检查截图确认无误后，把 dryRun 设为 false 重跑就会真的发布'
          : '浏览器已停在发布页，可以手动点发布或继续补信息',
      };
    }

    // 11. 点发布
    const clicked = await clickPublish(page);
    note('点击发布', Boolean(clicked), clicked ? `按钮文案「${clicked}」` : '没找到发布按钮');
    if (!clicked) {
      const file = await shot(page, 'publish-nobutton');
      return { ok: false, stage: 'submit', screenshot: file, steps, text: await pageText(page) };
    }

    // 12. 等真正的结果：抖音先提交、再后台上传，进度条没走完不能收工
    const result = await waitUploadAndPublish(page, { timeout: 12 * 60_000 });
    note('发布结果', result.ok, result.detail);
    const file = await shot(page, 'publish-result');
    return {
      ok: result.ok,
      stage: result.ok ? 'published' : 'submit',
      detail: result.detail,
      screenshot: file,
      url: page.url(),
      steps,
      text: (await pageText(page)).slice(0, 600),
    };
  } catch (err) {
    const file = await shot(page, 'publish-error');
    return { ok: false, stage: 'exception', error: err.message, screenshot: file, steps, text: await pageText(page) };
  }
}

// ------------------------------------------------------------------ 子步骤

/**
 * 把文件交给上传控件。创作者中心是 React 应用，input 要等页面挂载完才出现（约 10s）。
 */
async function uploadFiles(page, files, acceptHint) {
  const sel = 'input[type="file"]';
  const appeared = await page.waitForSelector(sel, { state: 'attached', timeout: 60_000 }).catch(() => null);
  if (appeared) {
    const inputs = page.locator(sel);
    const total = await inputs.count();
    for (let i = 0; i < total; i++) {
      const el = inputs.nth(i);
      const accept = (await el.getAttribute('accept')) || '';
      if (accept.includes(acceptHint)) {
        await el.setInputFiles(files);
        return 'input[accept]';
      }
    }
    await inputs.first().setInputFiles(files);
    return 'input';
  }
  for (const t of ['上传视频', '上传图文', '点击上传', '上传作品']) {
    const loc = page.getByText(t, { exact: false }).first();
    if (!(await loc.count())) continue;
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }),
        loc.click({ timeout: 4000 }),
      ]);
      await chooser.setFiles(files);
      return `filechooser:${t}`;
    } catch {
      /* 下一个 */
    }
  }
  return null;
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

/** 平台自己的"可以发布了"信号：发布按钮可用 + 预览视频有 duration */
async function waitForMediaReady(page, { timeout }) {
  const deadline = Date.now() + timeout;
  let stable = 0;
  while (Date.now() < deadline) {
    const st = await page
      .evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) =>
          /^(发布|立即发布)$/.test((b.innerText || '').trim()),
        );
        const box = btn ? btn.getBoundingClientRect() : null;
        const v = document.querySelector('video');
        return {
          hasBtn: Boolean(btn),
          enabled: btn ? !(btn.disabled || btn.getAttribute('aria-disabled') === 'true') : false,
          visible: Boolean(box && box.width > 0 && box.height > 0),
          videoReady: v ? Number.isFinite(v.duration) && v.duration > 0 : null,
        };
      })
      .catch(() => ({ hasBtn: false, enabled: false, visible: false, videoReady: null }));
    const ok = st.hasBtn && st.enabled && st.visible && (st.videoReady === null || st.videoReady === true);
    stable = ok ? stable + 1 : 0;
    if (stable >= 3) return true;
    await sleep(2000);
  }
  return false;
}

/** 标题：填完读 inputValue 校验 */
async function typeTitle(page, title, kind) {
  const candidates = [
    { selector: 'input[placeholder*="填写作品标题"]', name: 'title-input' },
    { selector: 'input[placeholder*="标题"]', name: 'title-input-2' },
    { selector: 'textarea[placeholder*="标题"]', name: 'title-textarea' },
  ];
  const txt = kind === 'images' ? String(title).slice(0, 20) : String(title).slice(0, 30);
  for (const c of candidates) {
    const loc = page.locator(c.selector).first();
    if (!(await loc.count())) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.click({ timeout: 3000 }).catch(() => {});
    await loc.fill('').catch(() => {});
    await loc.type(txt, { delay: 25 });
    await sleep(400);
    const v = await loc.inputValue().catch(() => '');
    if (v && v.trim()) return c.name;
  }
  return null;
}

/** 描述：必须用鼠标点进富文本区域（点 locator 不一定聚焦），然后 insertText */
async function typeDescription(page, descText) {
  const candidates = ['div.zone-container', 'div[data-placeholder*="添加作品简介"]', 'div[contenteditable="true"]'];
  for (const sel of candidates) {
    const zone = page.locator(sel).first();
    if (!(await zone.count())) continue;
    const box = await zone.boundingBox().catch(() => null);
    if (!box) continue;
    await page.mouse.click(box.x + 16, box.y + Math.min(box.height / 2, 30));
    await sleep(300);
    await page.keyboard.insertText(String(descText).slice(0, 1000));
    await sleep(500);
    const inner = await zone.evaluate((el) => el.innerText || '').catch(() => '');
    if (inner.replace(/\s/g, '').includes(String(descText).slice(0, 8).replace(/\s/g, ''))) return sel;
  }
  return null;
}

/**
 * 话题：点「#添加话题」→ 编辑器里会出现一个 #，然后输入关键词等联想列表 → 点命中项。
 * 每个话题都读回校验（编辑器里能看到 #话题名 才算成功）。
 */
async function addTopics(page, topics) {
  let added = 0;
  let verified = 0;
  const zone = page.locator('div.zone-container').first();
  for (const raw of topics) {
    const tag = String(raw).replace(/^#/, '').trim();
    if (!tag) continue;
    try {
      const entry = page.getByText('#添加话题', { exact: true }).last();
      if (!(await entry.count())) break;
      await entry.click({ force: true, timeout: 4000 }).catch(() => {});
      added += 1;
      await sleep(600);
      await page.keyboard.type(tag, { delay: 45 });
      await sleep(1400); // 等联想

      // 优先点联想里含这个关键词的那一项，否则点第一项
      const hit = await clickSuggestion(page, tag);
      if (!hit) await page.keyboard.press('Enter');
      await sleep(700);

      const inner = await zone.evaluate((el) => el.innerText || '').catch(() => '');
      if (inner.includes(tag)) verified += 1;
    } catch (err) {
      log.warn(`加话题「${tag}」失败`, err.message);
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  return { added, verified };
}

async function clickSuggestion(page, tag) {
  const target = await page
    .evaluate((kw) => {
      const root =
        document.querySelector('.mention-suggest-mount-dom') ||
        document.querySelector('[class*="mention-suggest"]');
      if (!root) return null;
      const leaves = [...root.querySelectorAll('*')].filter(
        (el) => el.children.length === 0 && (el.textContent || '').includes('#' + kw),
      );
      const el = leaves[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.textContent.trim().slice(0, 30) };
    }, tag)
    .catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y);
  return target.text;
}

async function setCover(page, coverFile) {
  try {
    for (const t of ['选择封面', '设置封面', '编辑封面']) {
      const loc = page.getByText(t, { exact: false }).first();
      if (!(await loc.count())) continue;
      await loc.click({ timeout: 4000 }).catch(() => {});
      await sleep(1800);
      const up = page.getByText('上传封面', { exact: false }).first();
      if (await up.count()) await up.click({ timeout: 3000 }).catch(() => {});
      await sleep(1200);
      const inputs = page.locator('input[type="file"]');
      if (!(await inputs.count())) break;
      await inputs.last().setInputFiles(coverFile).catch(() => {});
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
      const v = await el.inputValue().catch(() => '');
      if (v) return true;
    }
  } catch (err) {
    log.warn('定时设置失败', err.message);
  }
  return false;
}

async function clickPublish(page) {
  const candidates = [
    { role: 'button', name: '发布', exact: true },
    { role: 'button', name: '立即发布', exact: true },
    { text: '发布', exact: true },
  ];
  for (const c of candidates) {
    try {
      const loc =
        c.role === 'button' ? page.getByRole('button', { name: c.name, exact: true }) : page.getByText(c.text, { exact: true });
      const first = loc.first();
      if (!(await first.count())) continue;
      if (!(await first.isVisible().catch(() => false))) continue;
      const disabled = await first
        .evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true')
        .catch(() => false);
      if (disabled) continue;
      await first.click({ timeout: 5000 });
      return c.name || c.text;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/**
 * 等"真的发出去了"：抖音点发布后先提交到服务端，再在页面上继续上传（右下角有百分比）。
 * 上传没走完就关浏览器 = 上传中断，作品不会发出去，所以这里必须等到进度条消失。
 */
async function waitUploadAndPublish(page, { timeout }) {
  const startedAt = Date.now();
  let sawProgress = false;
  let lastPct = null;
  while (Date.now() - startedAt < timeout) {
    const st = await page
      .evaluate(() => {
        const t = document.body?.innerText || '';
        const m = t.match(/(上传中|正在上传)[^\d%]{0,24}?(\d{1,3})\s*%/);
        return {
          pct: m ? Number(m[2]) : null,
          uploading: /上传中|正在上传/.test(t),
          success: /发布成功|已发布成功|作品发布成功/.test(t),
          failed: /发布失败|上传失败|审核不通过/.test(t),
          url: location.href,
        };
      })
      .catch(() => ({ pct: null, uploading: false, success: false, failed: false, url: '' }));

    if (st.failed) return { ok: false, detail: '页面提示发布失败' };
    if (st.pct != null) {
      if (st.pct !== lastPct) log.info(`后台上传 ${st.pct}%`);
      sawProgress = true;
      lastPct = st.pct;
    }
    // 见过进度条，且现在既没有百分比也没有"上传中" → 上传完成
    if (sawProgress && st.pct == null && !st.uploading) {
      return { ok: true, detail: `上传完成并已发布（最后一次进度 ${lastPct}%）` };
    }
    if (st.success && !st.uploading) return { ok: true, detail: '页面提示发布成功' };
    // 小文件可能根本没有进度条：跳到作品管理页且 15 秒无进度，视为已提交
    if (!sawProgress && /content\/manage/.test(st.url) && Date.now() - startedAt > 15_000 && !st.uploading) {
      return { ok: true, detail: '已提交（未见上传进度，按已发布处理）' };
    }
    await sleep(3000);
  }
  return { ok: false, detail: `等上传完成超时（最后进度 ${lastPct ?? '未知'}%），作品可能仍在后台上传/审核` };
}

async function pageText(page, limit = 2000) {
  try {
    return (await page.evaluate(() => document.body?.innerText || '')).slice(0, limit);
  } catch {
    return '';
  }
}
