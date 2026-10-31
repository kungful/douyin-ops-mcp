// 下载与媒体处理：无水印视频 / 图集 / 音乐，配 ffmpeg 探针与抽帧。
// 抖音的 CDN（douyinvod.com）不需要 cookie，但要有像样的 UA + Referer。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CONFIG } from '../config.js';
import { logger } from '../log.js';
import { safeName, sleep } from '../util.js';
import { manifestHas, manifestPut } from '../store.js';

const log = logger('media');

const CDN_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  referer: 'https://www.douyin.com/',
  accept: '*/*',
};

/** 流式下载到本地文件，返回 {file, bytes} */
export async function downloadFile(url, file, { tries = 3 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: CDN_HEADERS, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const tmp = `${file}.part`;
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      const bytes = fs.statSync(tmp).size;
      if (bytes < 1024) throw new Error(`下载内容过小（${bytes} 字节）`);
      fs.renameSync(tmp, file);
      return { file, bytes };
    } catch (err) {
      lastErr = err;
      if (i < tries) await sleep(1200 * i);
    }
  }
  throw new Error(`下载失败：${lastErr?.message || lastErr}`);
}

/** 作品本地文件名前缀：日期_作者_描述_id（防重名又便于检索） */
export function fileStem(item, { prefix = '' } = {}) {
  const date = (item.createdAt || '').slice(0, 10) || 'nodate';
  const author = safeName(item.author?.nickname || 'unknown', 'author', 18);
  const desc = safeName(item.desc || '', '', 30);
  const parts = [prefix, date, author, desc, item.id].filter(Boolean);
  return parts.join('_').replace(/_+/g, '_');
}

function guessExt(url, fallback = '.mp4') {
  try {
    const p = new URL(url).pathname;
    const ext = path.extname(p);
    if (ext && ext.length <= 6) return ext;
  } catch {
    /* ignore */
  }
  return fallback;
}

/**
 * 下载一个作品（视频或图集）。
 * @param {object} item normalizeAweme 的输出
 * @param {{dir?: string, needMusic?: boolean, skipIfDone?: boolean, prefix?: string}} opts
 */
export async function downloadAweme(item, opts = {}) {
  const { dir = CONFIG.DOWNLOAD_DIR, needMusic = false, skipIfDone = true, prefix = '' } = opts;
  const stem = fileStem(item, { prefix });
  const files = [];
  const skipped = [];

  if (item.type === 'images') {
    for (let i = 0; i < item.images.length; i++) {
      const img = item.images[i];
      const url = img.video || img.url;
      if (!url) continue;
      const ext = img.video ? '.mp4' : guessExt(url, '.jpg');
      const file = path.join(dir, `${stem}_${String(i + 1).padStart(2, '0')}${ext}`);
      const key = `img:${item.id}:${i}`;
      if (skipIfDone && fs.existsSync(file)) {
        skipped.push(file);
        continue;
      }
      if (skipIfDone && manifestHas(key) && fs.existsSync(manifestHas(key).file)) {
        skipped.push(manifestHas(key).file);
        continue;
      }
      const res = await downloadFile(url, file);
      manifestPut(key, { file, bytes: res.bytes, url });
      files.push(file);
    }
  } else if (item.video?.noWatermarkUrl) {
    const file = path.join(dir, `${stem}.mp4`);
    const key = `vid:${item.id}`;
    if (skipIfDone && fs.existsSync(file)) skipped.push(file);
    else if (skipIfDone && manifestHas(key) && fs.existsSync(manifestHas(key).file)) skipped.push(manifestHas(key).file);
    else {
      const res = await downloadFile(item.video.noWatermarkUrl, file);
      manifestPut(key, { file, bytes: res.bytes, url: item.video.noWatermarkUrl });
      files.push(file);
    }
  }

  if (needMusic && item.music?.url) {
    const file = path.join(dir, `${stem}_music.mp3`);
    if (!(skipIfDone && fs.existsSync(file))) {
      try {
        await downloadFile(item.music.url, file);
        files.push(file);
      } catch (err) {
        log.warn('音乐下载失败', err.message);
      }
    }
  }

  if (!files.length && !skipped.length) throw new Error('这个作品没有可下载的地址（可能是直播回放或受限内容）');
  return { files, skipped, stem };
}

// ------------------------------------------------------------------ ffmpeg
function run(cmd, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} 超时`));
    }, timeout);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`无法执行 ${cmd}：${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} 退出码 ${code}：${stderr.slice(-400)}`));
    });
  });
}

/** ffprobe 探针：时长/尺寸/码率 */
export async function probe(file) {
  try {
    const { stdout } = await run(CONFIG.FFPROBE, [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size,bit_rate:stream=width,height,codec_name,r_frame_rate,codec_type',
      '-of',
      'json',
      file,
    ]);
    const j = JSON.parse(stdout);
    const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
    const a = (j.streams || []).find((s) => s.codec_type === 'audio') || {};
    return {
      duration: j.format?.duration ? Number(j.format.duration) : null,
      bytes: j.format?.size ? Number(j.format.size) : null,
      bitRate: j.format?.bit_rate ? Number(j.format.bit_rate) : null,
      width: v.width ?? null,
      height: v.height ?? null,
      videoCodec: v.codec_name ?? null,
      hasAudio: Boolean(a.codec_name),
    };
  } catch (err) {
    log.warn('ffprobe 失败', err.message);
    return null;
  }
}

/** 提音频：单声道 16k mp3，ASR 的最佳输入 */
export async function extractAudio(videoFile, outFile) {
  const out = outFile || videoFile.replace(/\.[^.]+$/, '.mp3');
  await run(CONFIG.FFMPEG, ['-y', '-i', videoFile, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', out]);
  return out;
}

/** 抽一帧当封面 */
export async function grabFrame(videoFile, outFile, atSec = 1) {
  const out = outFile || videoFile.replace(/\.[^.]+$/, '.jpg');
  await run(CONFIG.FFMPEG, ['-y', '-ss', String(atSec), '-i', videoFile, '-frames:v', '1', '-q:v', '2', out]);
  return out;
}

/** 视频是否符合抖音发布要求（宽高比/时长/大小），返回问题列表 */
export function checkPublishable(meta) {
  const problems = [];
  if (!meta) return ['读不到视频信息，无法校验'];
  const { width, height, duration, bytes } = meta;
  if (width && height) {
    const ratio = height / width;
    if (ratio < 0.5 || ratio > 2.5) problems.push(`宽高比 ${width}x${height} 偏离抖音偏好（9:16 / 1:1 / 16:9 最稳）`);
  }
  if (duration != null) {
    if (duration < 3) problems.push(`时长 ${duration.toFixed(1)}s 太短（抖音要求 ≥3 秒）`);
    if (duration > 15 * 60) problems.push(`时长 ${(duration / 60).toFixed(1)} 分钟超过 15 分钟上限`);
  }
  if (bytes && bytes > 4 * 1024 ** 3) problems.push('文件超过 4GB');
  if (!meta.hasAudio) problems.push('没有音轨（短视频一般必须有声音）');
  return problems;
}
