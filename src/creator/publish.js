// SPDX-License-Identifier: MIT
// 发布：视频 / 图文，走 creator.douyin.com 的真实上传流程。
//
// 合规提醒：本模块会代替使用者点击"发布"。发布内容的合法性、真实性、是否侵权、
// 是否符合平台规则，全部由使用者承担；请先用 dryRun 预览再决定是否真发。
// 只应发布使用者拥有权利的内容，不得用于刷量、搬运侵权、发布违法违规信息。
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

    // 2. 图文要先点"发布图文"切模式（上传页默认是视频入口，input 只收 video/* 且不接受多选）
    if (kind === 'images') {
      const switched = await enterPublishMode(page, '图文');
      note('切换到图文模式', switched, switched ? '' : '没找到「发布图文」入口，继续按默认流程试');
    }

    // 3. 选中文件（等 React 挂载出上传控件）
    const acceptHint = kind === 'video' ? 'video' : 'image';
    const via = await uploadFiles(page, files, acceptHint, files.length > 1);
    if (!via) {
      const file = await shot(page, 'publish-noinput');
      note('找到上传控件', false, `60 秒内没等到 input[type=file]（${kind}）`);
      return { ok: false, stage: 'upload-input', screenshot: file, steps, text: await pageText(page) };
    }
    note('选择文件', true, `${files.map((f) => path.basename(f)).join(', ')}（经 ${via}）`);

    // 4. 等进入发布编辑页
    const entered = await waitFor(() => PUBLISH_URL_RE.test(page.url()), { timeout: 60_000, poll: 700 });
    note('进入发布编辑页', entered, page.url());
    await sleep(2500);

    // 5. 等平台认为媒体就绪（发布按钮可用 + 预览视频有元数据）
    const uploaded = await waitForMediaReady(page, { timeout: kind === 'video' ? 20 * 60_000 : 5 * 60_000 });
    note('媒体就绪', uploaded, uploaded ? '' : '超时：文件可能太大或网络慢');
    if (!uploaded) {
      const file = await shot(page, 'publish-uploading');
      return { ok: false, stage: 'uploading', screenshot: file, steps, text: await pageText(page) };
    }

    // 6. 定时发布（放最前面：时间选择器的输入框不好定位，万一填错位置，后面的标题/描述会覆盖回来）
    if (scheduleAt) {
      const ok = await setSchedule(page, scheduleAt);
      note('设置定时发布', ok, ok ? scheduleAt : '没找到定时发布控件（时间输入框没识别出来）');
    }

    // 7. 标题（读回校验）
    if (title) {
      const hit = await typeTitle(page, title, kind);
      note('填写标题', Boolean(hit), hit ? `命中 ${hit}` : '标题没写进去（找不到输入框或读回为空）');
    }

    // 8. 描述（鼠标点进编辑器 + insertText，读回校验）
    if (desc) {
      const hit = await typeDescription(page, desc);
      note('填写作品描述', Boolean(hit), hit ? `命中 ${hit}` : '描述没写进去（编辑器没聚焦）');
    }

    // 9. 话题（走页面自带的「#添加话题」，读回校验）
    if (topics.length) {
      const { added, verified } = await addTopics(page, topics);
      note('添加话题', verified >= topics.length, `${verified}/${topics.length}（点了 ${added} 次入口）`);
    }

    // 10. 封面（可选，失败不致命，但必须确认弹窗关掉）
    if (coverFile && fs.existsSync(coverFile)) {
      const ok = await setCover(page, coverFile);
      note('设置封面', ok, ok ? path.basename(coverFile) : '自定义封面没生效（平台封面弹窗要人工裁切/确认），已自动关掉弹窗，用平台自动封面');
    }
    const dialogLeft = await closeDialogs(page);
    if (dialogLeft) note('关闭遗留弹窗', false, '还有弹窗没关掉，可能影响点发布');

    // 11. 预览模式
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

    // 12. 点发布
    const clicked = await clickPublish(page);
    note('点击发布', Boolean(clicked), clicked ? `按钮文案「${clicked}」` : '没找到发布按钮');
    if (!clicked) {
      const file = await shot(page, 'publish-nobutton');
      return { ok: false, stage: 'submit', screenshot: file, steps, text: await pageText(page) };
    }

    // 13. 等真正的结果：抖音先提交、再后台上传，进度条没走完不能收工
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
async function uploadFiles(page, files, acceptHint, needMultiple = false) {
  const sel = 'input[type="file"]';
  const appeared = await page.waitForSelector(sel, { state: 'attached', timeout: 60_000 }).catch(() => null);
  if (appeared) {
    const inputs = page.locator(sel);
    const total = await inputs.count();
    let fallback = null;
    for (let i = 0; i < total; i++) {
      const el = inputs.nth(i);
      const accept = (await el.getAttribute('accept')) || '';
      const multiple = (await el.getAttribute('multiple')) != null;
      if (!accept.includes(acceptHint)) continue;
      if (needMultiple && !multiple) {
        fallback = fallback || el;
        continue;
      }
      await el.setInputFiles(files);
      return multiple ? 'input[accept,multiple]' : 'input[accept]';
    }
    if (fallback) {
      throw new Error(
        `只找到单文件上传框（accept=${acceptHint}），多图需要平台的多选入口。请确认已切到「发布图文」模式。`,
      );
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

/** 上传页顶部的模式入口：发布视频 / 发布图文 / 发布全景视频 / 发布文章 */
async function enterPublishMode(page, label) {
  // 等页面挂载完
  await waitFor(
    () => page.evaluate(() => /发布视频|发布图文/.test(document.body?.innerText || '')),
    { timeout: 45_000, poll: 700 },
  );
  for (const t of [`发布${label}`, label]) {
    const loc = page.getByText(t, { exact: true }).first();
    if (!(await loc.count())) continue;
    await loc.click({ timeout: 5000 }).catch(() => {});
    await sleep(1800);
    return true;
  }
  return false;
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
    // 1) 打开封面弹窗
    const opened = await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === '选择封面',
      );
      if (!el) return false;
      el.click();
      return true;
    });
    if (!opened) return false;
    await sleep(2500);

    // 2) 点画布中间那颗黑色「上传封面」大按钮（面积最大那个），用 filechooser 接管
    const box = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('*')].filter(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === '上传封面',
      );
      let best = null;
      for (const n of nodes) {
        const host = n.closest('button,[class*="btn"],[class*="upload"]') || n;
        const r = host.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (!best || r.width * r.height > best.area) best = { x: r.x + r.width / 2, y: r.y + r.height / 2, area: r.width * r.height };
      }
      return best;
    });
    let uploaded = false;
    if (box) {
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 8000 }),
          page.mouse.click(box.x, box.y),
        ]);
        await chooser.setFiles(coverFile);
        uploaded = true;
      } catch {
        /* 退到 input */
      }
    }
    if (!uploaded) {
      const inputs = page.locator('input[type="file"]');
      const total = await inputs.count();
      for (let i = 0; i < total; i++) {
        const el = inputs.nth(i);
        const accept = (await el.getAttribute('accept')) || '';
        if (!accept.includes('image')) continue;
        await el.setInputFiles(coverFile).catch(() => {});
        uploaded = true;
        break;
      }
    }
    if (!uploaded) {
      await closeDialogs(page);
      return false;
    }

    // 3) 等「完成」变可点（裁切预览处理完才会亮）
    const doneEnabled = await waitFor(
      () =>
        page.evaluate(() => {
          const el = [...document.querySelectorAll('button,[class*="btn"]')].find(
            (b) => (b.innerText || '').trim() === '完成',
          );
          if (!el) return false;
          const cls = (el.className || '').toString();
          const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || /disabled/.test(cls);
          return !disabled && el.getBoundingClientRect().width > 0;
        }),
      { timeout: 40_000, poll: 1500 },
    );
    if (!doneEnabled) {
      log.warn('「完成」按钮一直不可用，放弃自定义封面');
      await closeDialogs(page);
      return false;
    }

    // 注意：不要去点「设置竖封面」——它会再开一层竖封面编辑流程，同样要人工裁切，
    // 点了只会多一层关不掉的弹窗。直接点「完成」，不成再关弹窗放弃自定义封面。

    // 4) 点完成，并确认弹窗关闭（平台要求先裁切/设竖封面时，这里会关不掉）
    for (let i = 0; i < 3; i++) {
      const clickedDone = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')].filter(
          (b) => (b.innerText || '').trim() === '完成' && b.getBoundingClientRect().width > 0,
        );
        if (!btns.length) return false;
        btns[0].click();
        return true;
      });
      log.info(`点「完成」${clickedDone ? '已点' : '没找到按钮'}`);
      await sleep(1500);
      if (!(await coverDialogOpen(page))) {
        log.info('自定义封面已生效');
        return true;
      }
    }
    // 关不掉的弹窗必须收掉，否则后面点发布会点不到
    const stillOpen = await closeDialogs(page);
    log.warn(stillOpen ? '封面弹窗关不掉（会影响后面的发布）' : '封面没设成功，已关掉弹窗继续');
    return false;
  } catch (err) {
    log.warn('封面设置失败', err.message);
    await closeDialogs(page);
    return false;
  }
}

function coverDialogOpen(page) {
  // 注意：不能用 "设置横封面" 这种文案判断——弹窗关掉后这些字还留在 DOM 里，会误判成没关。
  // 弹窗独有的可见元素是「封面检测」按钮 / 裁切画布。
  return page
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const leaf = [...document.querySelectorAll('*')].filter(
        (el) => el.children.length === 0 && visible(el),
      );
      return leaf.some((el) => ['封面检测', '设置竖封面'].includes((el.textContent || '').trim()));
    })
    .catch(() => false);
}

/** 关掉遗留弹窗：先 Esc，再试 X / 取消 / 关闭。返回 true 表示还有弹窗残留 */
async function closeDialogs(page) {
  const has = () => coverDialogOpen(page);
  if (!(await has())) return false;

  for (let i = 0; i < 3; i++) {
    // 坐标优先：1440 视口下封面弹窗的 X 在右上角约 (宽-193, 113)
    const vp = page.viewportSize() || { width: 1440, height: 900 };
    await page.mouse.click(vp.width - 193, 113).catch(() => {});
    await sleep(900);
    if (!(await has())) return false;

    // 再试弹窗内部的 X 图标
    await page
      .evaluate(() => {
        const vw = window.innerWidth;
        const inModal = (el) => Boolean(el.closest('[class*="modal"],[class*="dialog"],[class*="semi-portal"],[class*="coverControl"]'));
        const cands = [...document.querySelectorAll('svg')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 6 && r.width < 30 && r.top > 60 && r.top < 240 && r.left > vw * 0.7;
        });
        const target = cands.find(inModal) || cands[0];
        (target?.closest('button,[class*="close"],[role="button"]') || target?.parentElement)?.click();
      })
      .catch(() => {});
    await sleep(900);
    if (!(await has())) return false;
  }
  return await has();
}

async function setSchedule(page, scheduleAt) {
  try {
    // 实测：这是 <label><input type=checkbox checked><span>定时发布</span></label> 的自定义单选，
    // 用 getByText().click() 会被 span 拦截超时，直接在 label 上 .click() 才行。
    const clicked = await page.evaluate(() => {
      const label = [...document.querySelectorAll('label')].find((l) =>
        (l.innerText || '').includes('定时发布'),
      );
      if (!label) return false;
      label.click();
      return true;
    });
    if (!clicked) return false;
    await sleep(1500);

    const when = scheduleAt.replace(/\//g, '-');
    const DATE_RE = /\d{4}-\d{1,2}-\d{1,2}/;
    // 只认"时间/日期"语义的输入框，绝不碰标题框
    const candidates = [
      'input[placeholder*="时间"]',
      'input[placeholder*="日期"]',
      'input[placeholder*="请选择"]',
      '.semi-datePicker input',
      'input[type="datetime-local"]',
    ];
    for (const sel of candidates) {
      const list = page.locator(sel);
      const n = await list.count();
      for (let i = 0; i < n; i++) {
        const el = list.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const ph = (await el.getAttribute('placeholder')) || '';
        if (/标题|描述/.test(ph)) continue; // 宁可放弃也不误填
        await el.click({ timeout: 3000 }).catch(() => {});
        await sleep(300);
        await page.keyboard.press('Control+A').catch(() => {});
        await el.fill('').catch(() => {});
        await el.type(when, { delay: 40 });
        await sleep(900);
        const v = await el.inputValue().catch(() => '');
        if (DATE_RE.test(v)) {
          await page.keyboard.press('Enter').catch(() => {});
          await sleep(1000);
          return true;
        }
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
    // 有的版本是日历选择器：直接点今天+时间
    log.warn('没找到日期时间输入框，尝试确认已有默认时间');
    for (const t of ['确定', '确认']) {
      const btn = page.getByText(t, { exact: true }).first();
      if (await btn.count()) {
        await btn.click({ timeout: 2500 }).catch(() => {});
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
