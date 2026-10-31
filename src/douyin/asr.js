// 文案提取（ASR）：三级降级
//   1) 硅基流动 SenseVoice（便宜、中文准，几十秒出结果）
//   2) 阿里云百炼 qwen3-asr-flash（有 DASHSCOPE_API_KEY 时）
//   3) 本地 faster-whisper（离线免费，首次用会从 ModelScope 下模型）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG } from '../config.js';
import { logger } from '../log.js';
import { extractAudio } from './media.js';

const log = logger('asr');

export function asrAvailability() {
  return {
    siliconflow: Boolean(CONFIG.SILICONFLOW_KEY),
    dashscope: Boolean(CONFIG.DASHSCOPE_KEY),
    localWhisper: true, // 能不能跑要等真正调用（需要 python + faster-whisper）
  };
}

/**
 * 转写音频/视频文件。
 * @param {string} file 本地音视频路径
 * @param {{engine?: 'auto'|'siliconflow'|'dashscope'|'local', context?: string, model?: string}} opts
 */
export async function transcribe(file, opts = {}) {
  const { engine = 'auto', context = '', model } = opts;
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);

  const order =
    engine === 'auto'
      ? [
          ...(CONFIG.SILICONFLOW_KEY ? ['siliconflow'] : []),
          ...(CONFIG.DASHSCOPE_KEY ? ['dashscope'] : []),
          'local',
        ]
      : [engine];

  const errors = [];
  let audio = file;
  if (!/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file)) {
    try {
      audio = await extractAudio(file);
    } catch (err) {
      log.warn('提取音频失败，直接用原文件尝试', err.message);
    }
  }

  for (const e of order) {
    try {
      if (e === 'siliconflow') return { engine: e, ...(await siliconflow(audio, { model })) };
      if (e === 'dashscope') return { engine: e, ...(await dashscope(audio, { context })) };
      if (e === 'local') return { engine: e, ...(await localWhisper(audio, { model })) };
    } catch (err) {
      log.warn(`${e} 转写失败：${err.message}`);
      errors.push(`${e}: ${err.message}`);
    }
  }
  throw new Error(`所有语音识别后端都失败了：\n${errors.join('\n')}`);
}

async function siliconflow(audioFile, { model } = {}) {
  const form = new FormData();
  const buf = fs.readFileSync(audioFile);
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(audioFile));
  form.append('model', model || CONFIG.SILICONFLOW_ASR_MODEL);
  const res = await fetch(CONFIG.SILICONFLOW_ASR_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CONFIG.SILICONFLOW_KEY}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`硅基流动 HTTP ${res.status}：${text.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`硅基流动返回异常：${text.slice(0, 200)}`);
  }
  if (!json.text) throw new Error(`硅基流动没有返回 text：${text.slice(0, 200)}`);
  return { text: json.text, model: model || CONFIG.SILICONFLOW_ASR_MODEL };
}

/** 百炼 qwen3-asr-flash：只支持公网可访问的 URL，本地文件走 data URI 也行但很占带宽 */
async function dashscope(audioFile, { context }) {
  const buf = fs.readFileSync(audioFile);
  const b64 = buf.toString('base64');
  const body = {
    model: 'qwen3-asr-flash',
    input: {
      messages: [
        ...(context ? [{ role: 'system', content: [{ text: context }] }] : []),
        { role: 'user', content: [{ audio: `data:audio/mpeg;base64,${b64}` }] },
      ],
    },
    parameters: { asr_options: { enable_lid: true, enable_itn: false } },
  };
  const res = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CONFIG.DASHSCOPE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`百炼 HTTP ${res.status}：${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const out = json.output?.choices?.[0]?.message?.content?.[0]?.text;
  if (!out) throw new Error(`百炼没有返回文本：${text.slice(0, 200)}`);
  return { text: out, model: 'qwen3-asr-flash' };
}

/** 本地 faster-whisper（复用 VideoStudio-MCP 那套 ModelScope 下载） */
async function localWhisper(audioFile, { model } = {}) {
  const script = path.join(CONFIG.ROOT, 'python', 'asr_whisper.py');
  const size = model || CONFIG.WHISPER_MODEL;
  const { stdout } = await new Promise((resolve, reject) => {
    const child = spawn(
      CONFIG.PYTHON,
      [script, audioFile, '--model', size, '--model-dir', CONFIG.MODEL_DIR],
      { windowsHide: true },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => reject(new Error(`无法执行 python（${CONFIG.PYTHON}）：${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: out });
      else reject(new Error(`本地 whisper 失败（退出码 ${code}）：${err.slice(-500)}`));
    });
  });
  const json = JSON.parse(stdout.trim().split('\n').pop());
  if (!json.text) throw new Error('本地 whisper 没有输出文本');
  return { text: json.text, model: `faster-whisper/${size}`, segments: json.segments };
}
