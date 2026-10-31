// 全局配置：路径、浏览器、ASR 凭据、超时。
// 所有路径都允许用环境变量覆盖，方便搬到别的机器或放进 pi 的 mcp.json。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name, fallback) {
  const v = Number(env(name, ''));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const DATA_DIR = path.resolve(env('DOUYIN_DATA', path.join(ROOT, 'data')));

export const CONFIG = {
  ROOT,
  DATA_DIR,
  // Chrome 用户数据目录：登录态、指纹、风控 cookie 都留在这里，别删。
  PROFILE_DIR: path.join(DATA_DIR, 'browser-profile'),
  DOWNLOAD_DIR: path.resolve(env('DOUYIN_DOWNLOAD_DIR', path.join(DATA_DIR, 'downloads'))),
  LOG_DIR: path.join(DATA_DIR, 'logs'),
  QUEUE_FILE: path.join(DATA_DIR, 'queue.json'),
  LIBRARY_FILE: path.join(DATA_DIR, 'library.json'),
  MANIFEST_FILE: path.join(DATA_DIR, 'manifest.json'),
  SHOT_DIR: path.join(DATA_DIR, 'shots'),
  MODEL_DIR: path.join(DATA_DIR, 'models'),

  // 浏览器：抖音对无头浏览器风控很严，默认有头（用户能看到、也能手动过验证码）。
  HEADLESS: env('DOUYIN_HEADLESS', '') === '1',
  CHROME_CHANNEL: env('DOUYIN_CHROME_CHANNEL', 'chrome'), // chrome | msedge | chromium
  CHROME_EXECUTABLE: env('DOUYIN_CHROME_EXECUTABLE', ''),
  VIEWPORT: { width: num('DOUYIN_VIEWPORT_W', 1440), height: num('DOUYIN_VIEWPORT_H', 900) },
  // 单次浏览器动作的默认超时
  NAV_TIMEOUT: num('DOUYIN_NAV_TIMEOUT_MS', 60_000),
  // 页面内 fetch 超时（抖音接口通常在 2s 内返回）
  API_TIMEOUT: num('DOUYIN_API_TIMEOUT_MS', 30_000),

  // 语音识别：硅基流动（便宜快）→ 阿里云百炼 → 本地 faster-whisper（离线免费）
  SILICONFLOW_KEY: env('SILICONFLOW_API_KEY', env('API_KEY', '')),
  SILICONFLOW_ASR_URL: 'https://api.siliconflow.cn/v1/audio/transcriptions',
  SILICONFLOW_ASR_MODEL: env('DOUYIN_ASR_MODEL', 'FunAudioLLM/SenseVoiceSmall'),
  DASHSCOPE_KEY: env('DASHSCOPE_API_KEY', ''),
  WHISPER_MODEL: env('DOUYIN_WHISPER_MODEL', 'small'),
  PYTHON: env('DOUYIN_PYTHON', 'python'),
  FFMPEG: env('DOUYIN_FFMPEG', 'ffmpeg'),
  FFPROBE: env('DOUYIN_FFPROBE', 'ffprobe'),

  // 队列守护进程的轮询间隔（毫秒）
  QUEUE_INTERVAL_MS: num('DOUYIN_QUEUE_INTERVAL_MS', 30_000),
  // 是否允许队列在发布时无人值守点下"发布"按钮（false = 只到预览页，等人确认）
  QUEUE_ALLOW_SUBMIT: env('DOUYIN_QUEUE_ALLOW_SUBMIT', '1') !== '0',
};

for (const dir of [
  CONFIG.DATA_DIR,
  CONFIG.PROFILE_DIR,
  CONFIG.DOWNLOAD_DIR,
  CONFIG.LOG_DIR,
  CONFIG.SHOT_DIR,
  CONFIG.MODEL_DIR,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

// 抖音 Web 客户端会回显这些指纹参数，必须和真实浏览器一致，否则是一个免费的风控信号。
export const UA_FINGERPRINT = {
  browser_name: 'Chrome',
  browser_version: '130.0.0.0',
  browser_platform: 'Win32',
  browser_language: 'zh-CN',
  engine_name: 'Blink',
  engine_version: '130.0.0.0',
  os_name: 'Windows',
  os_version: '10',
};

export const URLs = {
  home: 'https://www.douyin.com/',
  hot: 'https://www.douyin.com/hot',
  creator: 'https://creator.douyin.com/',
  creatorUpload: 'https://creator.douyin.com/creator-micro/content/upload',
  creatorManage: 'https://creator.douyin.com/creator-micro/content/manage',
  creatorComment: 'https://creator.douyin.com/creator-micro/interaction/comment',
  creatorDataOverview: 'https://creator.douyin.com/creator-micro/data/overview',
  creatorHome: 'https://creator.douyin.com/creator-micro/home',
};

export function absPath(p, base = CONFIG.DOWNLOAD_DIR) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}
