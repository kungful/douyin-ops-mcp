#!/usr/bin/env node
// 功能测试套件：按套件跑一遍真实工具，出 UTF-8 报告（data/test-report.json + markdown）。
// 用法：
//   node scripts/test-suite.js read        # 只读类：账号数据/搜索/通知/单条数据
//   node scripts/test-suite.js preview     # 发布预览类：图文 dryRun、视频+封面+定时 dryRun
//   node scripts/test-suite.js interact    # 写操作类：在我自己的作品下评论/点赞
//   node scripts/test-suite.js all
//
// 约定：每个用例返回 {ok, note}；ok=false 不会中断，全部跑完再汇总。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../src/config.js';
import { logger } from '../src/log.js';
import { callTool } from '../src/tools/index.js';
import { closeBrowser } from '../src/browser/manager.js';

const log = logger('suite');
const suiteName = process.argv[2] || 'read';
const results = [];

const SELF_VIDEO = process.env.TEST_AWEME_ID || '7702758021469949193'; // 本机测试时发的那条
const VIDEO = 'C:/Users/hua/Videos/ConcatEdits/演示-剪一条山路 成片.mp4';
const IMAGES = [
  'C:/Users/hua/Documents/备份代码/xhs-art-shop/data/out/_test_slide.jpg',
  'C:/Users/hua/Documents/备份代码/xhs-art-shop/data/out/_test_cover_0.jpg',
  'C:/Users/hua/Documents/备份代码/xhs-art-shop/data/out/_test_summary.jpg',
].filter((f) => fs.existsSync(f));

async function run(name, tool, args, check) {
  const t0 = Date.now();
  let out;
  try {
    out = await callTool(tool, args);
  } catch (err) {
    out = { ok: false, error: { message: err.message } };
  }
  const ms = Date.now() - t0;
  let verdict = { ok: out.ok, note: '' };
  try {
    if (out.ok && check) verdict = check(out.data) || { ok: true, note: '' };
    if (!out.ok) verdict = { ok: false, note: out.error?.message || '调用失败' };
  } catch (err) {
    verdict = { ok: false, note: `检查失败：${err.message}` };
  }
  const rec = { name, tool, ok: verdict.ok, ms, note: verdict.note, data: out.ok ? trim(out.data) : null, error: out.ok ? null : out.error };
  results.push(rec);
  log.info(`${verdict.ok ? '✅' : '❌'} ${name} ${ms}ms ${verdict.note || ''}`);
  return rec;
}

/** 只保留报告里看得懂的东西，别把整坨 JSON 塞进去 */
function trim(data) {
  if (data == null) return null;
  const s = JSON.stringify(data);
  if (s.length < 1500) return data;
  if (Array.isArray(data)) return data.slice(0, 5);
  const size = (v) => {
    try {
      return JSON.stringify(v)?.length ?? 0;
    } catch {
      return 0;
    }
  };
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, size(v) > 400 ? `[${size(v)} 字节]` : v]));
}

// ------------------------------------------------------------------ 套件
const SUITES = {
  read: async () => {
    await run('账号概览', 'douyin_account_overview', {}, (d) => ({
      ok: Boolean(d?.metrics && Object.keys(d.metrics).length),
      note: d?.metrics ? Object.entries(d.metrics).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(' ') : '没读到指标',
    }));

    await run('我的作品列表', 'douyin_my_videos', { limit: 5 }, (d) => ({
      ok: Array.isArray(d.rows) && d.rows.length > 0,
      note: `${d.rows?.length || 0} 条，首条：${d.rows?.[0]?.cells?.[1] || ''}`,
    }));

    await run('单条作品数据', 'douyin_video_stats', { awemeId: SELF_VIDEO }, (d) => ({
      ok: Boolean(d.row || d.publicData),
      note: d.row ? `row=${d.row.slice(0, 60)}` : '退回公开数据',
    }));

    await run('搜索视频', 'douyin_search', { keyword: '咖啡拉花', count: 3 }, (d) => ({
      ok: Array.isArray(d.videos) && d.videos.length > 0,
      note: d.videos?.length ? d.videos[0].desc?.slice(0, 30) : '没结果（可能关键词太窄）',
    }));

    await run('搜索用户', 'douyin_search', { keyword: '咖啡', type: 'user', count: 3 }, (d) => ({
      ok: Array.isArray(d.users) && d.users.length > 0,
      note: d.users?.length ? `${d.users[0].nickname} 粉丝${d.users[0].followerCount}` : '没结果',
    }));

    await run('待回复评论', 'douyin_notifications', { limit: 5, works: 3 }, (d) => ({
      ok: Array.isArray(d.pending) && typeof d.pendingTotal === 'number',
      note: `扫了 ${d.scannedWorks} 条作品，待回复 ${d.pendingTotal} 条`,
    }));

    await run('待回复评论数', 'douyin_unread_count', { works: 3 }, (d) => ({
      ok: typeof d.pendingTotal === 'number',
      note: `待回复 ${d.pendingTotal} 条`,
    }));

    await run('我的主页（免登录接口）', 'douyin_user_profile', { target: 'https://www.douyin.com/user/self', posts: 2 }, (d) => ({
      ok: Boolean(d.user?.nickname),
      note: `${d.user?.nickname} 作品${d.user?.awemeCount} 粉丝${d.user?.followerCount}`,
    }));

    await run('评论列表', 'douyin_comments', { target: SELF_VIDEO, count: 5 }, (d) => ({
      ok: Array.isArray(d.items),
      note: `${d.items?.length || 0} 条评论（total=${d.total}）`,
    }));
  },

  preview: async () => {
    // 图文：dryRun 走到预览，验证多图上传 + 标题 + 描述 + 话题
    await run('图文发布预览（dryRun）', 'douyin_publish_images', {
      files: IMAGES,
      title: '图文自检',
      desc: '多图上传自检，不发布。',
      topics: ['测试'],
      dryRun: true,
    }, (d) => {
      const fails = (d.steps || []).filter((s) => !s.ok);
      return {
        ok: d.stage === 'preview' && fails.length === 0,
        note: `stage=${d.stage}${fails.length ? ` 卡在：${fails.map((f) => f.step).join('/')}` : ' 全部步骤通过'}`,
      };
    });

    // 视频：封面 + 定时，一起验证（dryRun，不真发）
    const soon = new Date(Date.now() + 20 * 60_000);
    const pad = (n) => String(n).padStart(2, '0');
    const scheduleAt = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())} ${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
    await run('视频+封面+定时预览（dryRun）', 'douyin_publish_video', {
      file: VIDEO,
      title: '封面定时自检',
      desc: '验证自定义封面与定时发布，不发布。',
      topics: ['测试'],
      cover: IMAGES[0],
      scheduleAt,
      dryRun: true,
    }, (d) => {
      const coverOk = (d.steps || []).find((s) => s.step === '设置封面')?.ok;
      const schedOk = (d.steps || []).find((s) => s.step === '设置定时发布')?.ok;
      // 自定义封面是已知限制（平台要求人工裁切），只要它没卡住弹窗就不算失败
      const blocking = (d.steps || []).filter(
        (s) => !s.ok && !['设置封面'].includes(s.step),
      );
      return {
        ok: d.stage === 'preview' && schedOk && blocking.length === 0,
        note: `定时=${schedOk ? 'ok' : '失败'} 封面=${coverOk ? 'ok' : '已知限制（需人工裁切）'}${blocking.length ? ` 卡在：${blocking.map((f) => f.step).join('/')}` : ''}`,
      };
    });
  },

  interact: async () => {
    const text = `自检评论 ${new Date().toISOString().slice(11, 19)}`;
    await run('发评论（自己的作品）', 'douyin_comment_publish', { awemeId: SELF_VIDEO, text }, (d) => ({
      ok: Boolean(d.ok),
      note: d.comment?.id ? `评论 id=${d.comment.id}` : JSON.stringify(d.raw || {}).slice(0, 80),
    }));

    // 评论落库有几秒延迟，轮询几次再判断
    await run('读回评论验证', 'douyin_comments_list', { target: SELF_VIDEO, count: 10 }, () => ({ ok: true, note: '占位，下面轮询' }));
    results.pop();
    {
      const t0 = Date.now();
      let seen = false;
      let count = 0;
      for (let i = 0; i < 6 && !seen; i++) {
        const r = await callTool('douyin_comments_list', { target: SELF_VIDEO, count: 10 });
        count = r.data?.items?.length || 0;
        seen = (r.data?.items || []).some((c) => (c.text || '').includes('自检评论'));
        if (!seen) await new Promise((res) => setTimeout(res, 3000));
      }
      const rec = { name: '读回评论验证', tool: 'douyin_comments_list', ok: seen, ms: Date.now() - t0, note: `${count} 条，${seen ? '看到自己刚发的' : '15 秒内没同步到（抖音有延迟）'}`, data: null, error: null };
      results.push(rec);
      log.info(`${seen ? '✅' : '❌'} ${rec.name} ${rec.ms}ms ${rec.note}`);
    }

    await run('点赞自己的作品', 'douyin_digg', { awemeId: SELF_VIDEO }, (d) => ({
      ok: Boolean(d.ok),
      note: `digg_count=${d.diggCount ?? '未知'}`,
    }));
  },
};

// ------------------------------------------------------------------ 执行
async function main() {
  const names = suiteName === 'all' ? Object.keys(SUITES) : [suiteName];
  for (const n of names) {
    if (!SUITES[n]) {
      console.error(`没有这个套件：${n}（可选 ${Object.keys(SUITES).join(' / ')}）`);
      process.exit(2);
    }
    log.info(`=== 套件 ${n} ===`);
    await SUITES[n]();
  }

  const okc = results.filter((r) => r.ok).length;
  const report = {
    at: new Date().toISOString(),
    suite: np(suiteName),
    passed: okc,
    total: results.length,
    results,
  };
  const file = path.join(CONFIG.DATA_DIR, `test-report-${suiteName}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');

  const md = [
    `# 测试报告（${suiteName}）`,
    '',
    `时间：${report.at}　通过：**${okc}/${results.length}**`,
    '',
    '| 结果 | 用例 | 工具 | 耗时 | 说明 |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name} | \`${r.tool}\` | ${r.ms}ms | ${(r.note || '').replace(/\|/g, '/')} |`),
  ].join('\n');
  fs.writeFileSync(path.join(CONFIG.DATA_DIR, `test-report-${suiteName}.md`), md, 'utf8');
  console.log(md);
  console.log(`\n报告：${file}`);
  await closeBrowser().catch(() => {});
  process.exit(okc === results.length ? 0 : 1);
}

function np(s) {
  return String(s);
}

main().catch(async (err) => {
  log.error('套件崩溃', err.stack || err.message);
  await closeBrowser().catch(() => {});
  process.exit(1);
});
