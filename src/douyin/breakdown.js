// 爆款拆解：把一条别人（或自己）的爆款作品拆成可复用的结构包。
// 融合三家的长处：Evil0ctal 的解析/数据、yzfly 的语音转文案、评论区的真实需求。
import { CONFIG } from '../config.js';
import { logger } from '../log.js';
import { locate, fetchAweme, fetchComments } from './parse.js';
import { downloadAweme, probe } from './media.js';
import { transcribe } from './asr.js';

const log = logger('breakdown');

/** 从分段里找出前 N 秒（默认 3 秒钩子）说了什么 */
function hookOf(segments, seconds = 3) {
  if (!segments?.length) return null;
  const parts = segments.filter((s) => s.start < seconds).map((s) => s.text);
  return parts.length ? parts.join('') : segments[0].text;
}

/** 粗略切分口播结构：按标点分句，标出前中后三段 */
function structureOf(text) {
  const sentences = String(text)
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sentences.length) return null;
  const n = sentences.length;
  const third = Math.max(1, Math.round(n / 3));
  return {
    sentences: n,
    opening: sentences.slice(0, third).join(''), // 前：钩子/共鸣
    middle: sentences.slice(third, third * 2).join(''), // 中：展开/干货
    closing: sentences.slice(third * 2).join(''), // 后：结论/引导
  };
}

/**
 * @param {object} opts
 * @param {string} opts.target 作品链接或 ID
 * @param {number} [opts.comments] 抓多少条评论（默认 30）
 * @param {boolean} [opts.transcribe] 是否下载并转写口播（默认 true）
 * @param {'local'|'auto'|'siliconflow'|'dashscope'} [opts.engine]
 */
export async function breakdown({ target, comments = 30, transcribe: doAsr = true, engine = 'auto' }) {
  const t = await locate(target);
  if (t.kind !== 'aweme') throw new Error('爆款拆解需要单条作品的链接或 ID');
  const item = await fetchAweme(t.awemeId);
  const out = {
    id: item.id,
    type: item.type,
    desc: item.desc,
    topics: item.topics?.map((x) => x.name) || [],
    author: item.author,
    stats: item.stats,
    duration: item.duration,
    createdAt: item.createdAt,
    music: item.music ? { title: item.music.title, author: item.music.author } : null,
    shareUrl: item.shareUrl,
  };

  // 评论区：按点赞排序，热评往往就是选题
  try {
    const c = await fetchComments(item.id, { count: comments });
    const hot = (c.items || []).slice().sort((a, b) => (b.diggCount || 0) - (a.diggCount || 0));
    out.commentSummary = {
      total: c.total,
      topComments: hot.slice(0, 8).map((x) => ({ text: x.text, digg: x.diggCount, ip: x.ipLabel })),
      authorReplied: (c.items || []).filter((x) => x.isAuthor).length,
    };
  } catch (err) {
    out.commentSummary = { error: err.message };
  }

  // 口播文案 + 结构
  if (doAsr && item.type === 'video') {
    try {
      const saved = await downloadAweme(item, { dir: CONFIG.DOWNLOAD_DIR, skipIfDone: true });
      const file = saved.files[0] || saved.skipped[0];
      if (file) {
        out.media = { file, meta: await probe(file) };
        const res = await transcribe(file, { engine });
        out.transcript = {
          engine: res.engine,
          model: res.model,
          chars: res.text?.length || 0,
          hook3s: hookOf(res.segments, 3),
          structure: structureOf(res.text),
          text: res.text,
        };
      }
    } catch (err) {
      out.transcript = { error: err.message };
    }
  }

  out.howToUse = [
    '看 stats 判断这条为什么起来（点赞/评论比高 = 争议型，收藏高 = 干货型，分享高 = 情绪/共鸣型）',
    '看 transcript.hook3s：前 3 秒的钩子句式，是最值得抄的结构',
    '看 commentSummary.topComments：用户自己说出来的需求，直接就是下一条的选题',
    '看 topics：话题组合决定流量池，换选题时可以沿用同话题',
  ];
  return out;
}
