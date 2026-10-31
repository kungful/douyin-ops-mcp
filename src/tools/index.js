// 工具注册表。每个工具 = { name, title, description, inputSchema, handler }。
// 描述写给模型看：说清"什么时候用、要什么参数、会付出什么代价（登录/耗时/花钱）"。
import { CONFIG, absPath } from '../config.js';
import { logger } from '../log.js';
import { sleep } from '../util.js';
import { addQueueItem, loadQueue, updateQueueItem } from '../store.js';
import { locate, fetchAweme, fetchUser, fetchUserPosts, searchVideos, searchUsers, fetchHotSpotVideos } from '../douyin/parse.js';
import { fetchComments } from '../douyin/parse.js';
import { P, EP } from '../douyin/params.js';
import { apiGet } from '../douyin/client.js';
import { downloadAweme } from '../douyin/media.js';
import { probe, checkPublishable } from '../douyin/media.js';
import { transcribe, asrAvailability } from '../douyin/asr.js';
import { normalizeTrending } from '../douyin/normalize.js';
import { breakdown } from '../douyin/breakdown.js';
import { getLoginState, openLoginPage, waitForLogin, clearLogin, fetchSelf } from '../creator/login.js';
import { publish, preflight } from '../creator/publish.js';
import { myVideos, accountOverview, videoStats } from '../creator/stats.js';
import { listComments, publishComment, digg, unreadCount, notifications, listReplies } from '../creator/interactions.js';

const log = logger('tools');

const s = (description, extra = {}) => ({ type: 'string', description, ...extra });
const n = (description, extra = {}) => ({ type: 'number', description, ...extra });
const b = (description) => ({ type: 'boolean', description });
const arr = (description, items = { type: 'string' }) => ({ type: 'array', description, items });

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });

// ----------------------------------------------------------------- 采集 / 解析
const readTools = [
  {
    name: 'douyin_parse',
    title: '解析抖音链接/作品',
    description:
      '把一个抖音分享链接、分享文案、裸作品 ID 或用户主页链接，解析成结构化数据：作品类型（视频/图文）、文案、话题、作者、互动数据、无水印播放地址、图集图片、背景音乐。不需要登录。批量粘贴多个链接时请逐个调用。',
    inputSchema: obj({
      target: s('分享链接、分享文案（含中文说明也行）、作品 ID（19 位数字）或用户主页链接/ sec_uid'),
      raw: b('是否附带完整原始 JSON（调试用，会很长，默认 false）'),
    }, ['target']),
    handler: async ({ target, raw = false }) => {
      const t = await locate(target);
      if (t.kind === 'aweme') return { kind: 'aweme', ...(await fetchAweme(t.awemeId, { raw })) };
      if (t.kind === 'user') return { kind: 'user', ...(await fetchUser(t.secUid, { raw })) };
      return { kind: t.kind, target: t, hint: '合集/音乐链接请用对应工具（douyin_batch_download）' };
    },
  },
  {
    name: 'douyin_download',
    title: '下载作品（无水印）',
    description:
      '下载一个抖音作品到本地：视频取无水印最高可用画质（优先 H.264），图集会下全部图片，可选连背景音乐一起下。已下过的会自动跳过（有 manifest 去重）。返回本地文件路径，可用于后续剪辑/发布。',
    inputSchema: obj({
      target: s('分享链接 / 作品 ID'),
      dir: s('保存目录（默认 data/downloads）'),
      music: b('是否同时下载背景音乐 mp3'),
      raw: b('保留原始 JSON'),
    }, ['target']),
    handler: async ({ target, dir, music = false }) => {
      const t = await locate(target);
      if (t.kind !== 'aweme') throw new Error('这条链接不是单个作品，批量请用 douyin_batch_download');
      const item = await fetchAweme(t.awemeId);
      const saved = await downloadAweme(item, { dir: absPath(dir || CONFIG.DOWNLOAD_DIR), needMusic: music });
      const meta = saved.files[0]?.endsWith('.mp4') ? await probe(saved.files[0]) : null;
      return { item: { id: item.id, type: item.type, desc: item.desc, author: item.author?.nickname, stats: item.stats }, ...saved, meta };
    },
  },
  {
    name: 'douyin_batch_download',
    title: '批量下载（主页/搜索/热榜）',
    description:
      '批量下载：某个博主主页的全部/部分作品、关键词搜索命中的作品、或当前热点视频流。带 limit 与游标控制，自动去重、自动跳过已下载。适合做选题拆解、竞品分析、素材库。注意有频率风控，一次别拉太多（建议 limit ≤ 30）。',
    inputSchema: obj({
      source: { type: 'string', enum: ['user', 'search', 'hotspot'], description: 'user=博主主页；search=关键词搜索（需登录）；hotspot=热点视频流（免登录）' },
      target: s('user：主页链接或 sec_uid；search：关键词；hotspot：留空'),
      limit: n('最多下载多少个作品（默认 10，建议 ≤30）', { default: 10 }),
      dir: s('保存目录'),
      cursor: s('分页游标（上一页返回的 cursor，默认 0）'),
      music: b('是否下载背景音乐（默认 false）'),
    }, ['source', 'limit']),
    handler: async ({ source, target = '', limit = 10, dir, cursor = '0', music = false }) => {
      const items = [];
      let nextCursor = '0';
      let hasMore = false;
      if (source === 'user') {
        const t = await locate(target);
        if (t.kind !== 'user') throw new Error('user 模式需要一个用户主页链接或 sec_uid');
        const page = await fetchUserPosts(t.secUid, { count: Math.min(limit, 20), cursor });
        items.push(...page.items);
        nextCursor = page.cursor;
        hasMore = page.hasMore;
      } else if (source === 'search') {
        items.push(...(await searchVideos(target, { count: Math.min(limit, 20), offset: Number(cursor) || 0 })));
        nextCursor = String((Number(cursor) || 0) + Math.min(limit, 20));
        hasMore = true;
      } else {
        const page = await fetchHotSpotVideos({ count: Math.min(limit, 20), cursor });
        items.push(...page.items);
        nextCursor = page.cursor;
        hasMore = page.hasMore;
      }

      const results = [];
      for (const item of items.slice(0, limit)) {
        try {
          const saved = await downloadAweme(item, { dir: absPath(dir || CONFIG.DOWNLOAD_DIR), needMusic: music });
          results.push({ id: item.id, desc: item.desc?.slice(0, 60), stats: item.stats, files: saved.files, skipped: saved.skipped });
        } catch (err) {
          results.push({ id: item.id, error: err.message });
        }
        await sleep(1200 + Math.random() * 1500); // 别把 CDN/风控惹毛
      }
      return { source, downloaded: results.filter((r) => r.files?.length).length, results, nextCursor, hasMore };
    },
  },
  {
    name: 'douyin_user_profile',
    title: '博主资料 + 作品列表',
    description: '读一个抖音博主的公开资料（粉丝、作品数、简介、认证）以及最近的作品列表。做竞品/对标账号分析的第一步。',
    inputSchema: obj({
      target: s('主页链接或 sec_uid'),
      posts: n('顺便拉多少条作品（0 = 只拉资料，默认 10）', { default: 10 }),
    }, ['target']),
    handler: async ({ target, posts = 10 }) => {
      const t = await locate(target);
      if (t.kind !== 'user') {
        if (t.kind !== 'aweme') throw new Error('需要用户主页链接或 sec_uid');
        const aweme = await fetchAweme(t.awemeId);
        if (!aweme.author?.secUid) throw new Error('从作品里取不到作者主页');
        const user = await fetchUser(aweme.author.secUid);
        const list = posts ? await fetchUserPosts(aweme.author.secUid, { count: posts }) : null;
        return { user, posts: list?.items, hasMore: list?.hasMore };
      }
      const user = await fetchUser(t.secUid);
      const list = posts ? await fetchUserPosts(t.secUid, { count: posts }) : null;
      return { user, posts: list?.items, cursor: list?.cursor, hasMore: list?.hasMore };
    },
  },
  {
    name: 'douyin_search',
    title: '搜索视频/用户（需登录）',
    description: '用关键词搜索抖音视频或用户。抖音只对已登录会话开放搜索，未登录会返回"请先登录"。用于找选题、找对标账号、找爆款结构。',
    inputSchema: obj({
      keyword: s('关键词'),
      type: { type: 'string', enum: ['video', 'user'], description: '搜索类型，默认 video' },
      count: n('返回条数（默认 10）', { default: 10 }),
      offset: n('偏移，用于翻页（默认 0）', { default: 0 }),
      sort: { type: 'string', enum: ['0', '1', '2'], description: '排序：0 综合、1 最多点赞、2 最新发布' },
    }, ['keyword']),
    handler: async ({ keyword, type = 'video', count = 10, offset = 0, sort = '0' }) => {
      if (type === 'user') return { keyword, users: await searchUsers(keyword, { count, offset }) };
      return { keyword, videos: await searchVideos(keyword, { count, offset, sort }) };
    },
  },
  {
    name: 'douyin_trending',
    title: '抖音热榜 / 热点视频',
    description:
      '拿抖音热榜（总榜/娱乐/社会/挑战榜）和"热点视频"流（每条都带完整互动数据，可判断这个热点值不值得跟）。免登录，是每天选选题的第一站。',
    inputSchema: obj({
      board: { type: 'string', enum: ['hot', 'entertainment', 'society', 'challenge'], description: '榜单，默认 hot 总榜' },
      videos: n('顺便拉多少条热点视频（0=不要，默认 0）', { default: 0 }),
    }),
    handler: async ({ board = 'hot', videos = 0 }) => {
      const payload = await apiGet(EP.trending, P.trending(board), { label: 'trending' });
      const { board: list } = normalizeTrending(payload);
      const out = { board, count: list.length, list: list.slice(0, 50) };
      if (videos > 0) {
        const hot = await fetchHotSpotVideos({ count: Math.min(videos, 20) });
        out.videos = hot.items.map((v) => ({
          id: v.id,
          desc: (v.desc || '').slice(0, 80),
          author: v.author?.nickname,
          stats: v.stats,
          url: v.shareUrl,
        }));
      }
      return out;
    },
  },
  {
    name: 'douyin_comments',
    title: '读作品评论',
    description: '读一条作品的评论区（含点赞数、作者回复标记、IP 属地、前 3 条二级回复）。用来抓用户真实需求、找选题、找可以互动的潜在客户。',
    inputSchema: obj({
      target: s('作品链接或作品 ID'),
      count: n('条数（默认 20）', { default: 20 }),
      cursor: s('翻页游标'),
    }, ['target']),
    handler: async ({ target, count = 20, cursor = '0' }) => {
      const t = await locate(target);
      if (t.kind !== 'aweme') throw new Error('需要作品链接或作品 ID');
      return fetchComments(t.awemeId, { count, cursor });
    },
  },
  {
    name: 'douyin_transcribe',
    title: '视频转文案（语音识别）',
    description:
      '把视频/音频里的口播转成文字（可带时间轴）。三级降级：硅基流动 SenseVoice（快、便宜）→ 阿里云百炼 qwen3-asr → 本地 faster-whisper（离线免费，首次要下模型）。用于拆解爆款口播结构、给自己拍的口播生成字幕稿。',
    inputSchema: obj({
      target: s('抖音作品链接 / 作品 ID / 本地音视频文件路径'),
      engine: { type: 'string', enum: ['auto', 'siliconflow', 'dashscope', 'local'], description: '识别后端，默认 auto' },
      segments: b('是否返回带时间轴的分段（默认 false）'),
      saveDir: s('临时文件目录（默认 data/downloads）'),
    }, ['target']),
    handler: async ({ target, engine = 'auto', segments = false, saveDir }) => {
      let file = target;
      if (!/\.(mp4|mov|mp3|wav|m4a|aac|flac)$/i.test(target)) {
        const t = await locate(target);
        if (t.kind !== 'aweme') throw new Error('需要作品链接或本地文件路径');
        const item = await fetchAweme(t.awemeId);
        if (item.type === 'images') throw new Error('这是图文作品，没有语音可转写');
        const saved = await downloadAweme(item, { dir: absPath(saveDir || CONFIG.DOWNLOAD_DIR), skipIfDone: true });
        file = saved.files[0] || saved.skipped[0];
        if (!file) throw new Error('下载失败，拿不到可转写的文件');
      }
      const res = await transcribe(file, { engine });
      return {
        file,
        engine: res.engine,
        model: res.model,
        chars: res.text?.length || 0,
        text: res.text,
        segments: segments ? res.segments : undefined,
        available: asrAvailability(),
      };
    },
  },
  {
    name: 'douyin_breakdown',
    title: '爆款拆解（数据+口播+热评）',
    description:
      '把一条爆款作品拆成可以直接复用的结构包：互动数据（判断爆款类型）、前 3 秒钩子、口播的前中后三段结构、热门评论（用户的真实需求）、话题与音乐。做选题和模仿结构的第一步。会比 douyin_parse 慢（要下载+语音识别），只要数据就关掉 transcribe。',
    inputSchema: obj({
      target: s('作品链接或作品 ID'),
      comments: n('抓多少条评论（默认 30）', { default: 30 }),
      transcribe: b('是否下载并转写口播（默认 true；关掉就只给数据和评论）'),
      engine: { type: 'string', enum: ['auto', 'local', 'siliconflow', 'dashscope'], description: '语音识别后端' },
    }, ['target']),
    handler: async ({ target, comments = 30, transcribe: doAsr = true, engine = 'auto' }) =>
      breakdown({ target, comments, transcribe: doAsr, engine }),
  },
  {
    name: 'douyin_local_check',
    title: '检查本地视频是否符合发布要求',
    description: '发布前自查：时长、分辨率、宽高比、是否有音轨、码率、大小，并给出问题清单。也能顺便抽一帧看画面。',
    inputSchema: obj({
      file: s('本地视频文件绝对路径'),
      frameAt: n('抽帧时间点（秒，0=不抽）', { default: 0 }),
    }, ['file']),
    handler: async ({ file, frameAt = 0 }) => {
      const { probe: p, checkPublishable: chk, grabFrame } = await import('../douyin/media.js');
      const meta = await p(file);
      const problems = chk(meta);
      let frame = null;
      if (frameAt > 0) {
        try {
          frame = await grabFrame(file, undefined, frameAt);
        } catch (err) {
          frame = `抽帧失败：${err.message}`;
        }
      }
      return { file, meta, problems, ok: problems.length === 0, frame };
    },
  },
];

// ----------------------------------------------------------------- 登录 / 发布
const publishTools = [
  {
    name: 'douyin_login_qrcode',
    title: '扫码登录抖音',
    description:
      '打开浏览器并抓取创作者中心的登录二维码（返回本地图片路径）。用户用抖音 App 扫码后登录态会持久保存在浏览器 profile 里，之后所有工具都不需要再登录。等待期间请让用户完成扫码。',
    inputSchema: obj({
      waitSeconds: n('等扫码多久（默认 120 秒；0=只给二维码不等）', { default: 120 }),
    }),
    handler: async ({ waitSeconds = 120 }) => {
      const state = await getLoginState({ withProfile: false });
      if (state.loggedIn) return { alreadyLoggedIn: true, ...(await getLoginState()) };
      const { qrFile, qrBase64, screenshot, url, text, clicked } = await openLoginPage();
      if (!waitSeconds) return { qrFile, qrBase64, screenshot, url, clicked, hint: '请用户用抖音 App 扫码后调用 douyin_login_status 确认' };
      const ok = await waitForLogin({ timeoutSec: waitSeconds });
      const after = await getLoginState();
      return {
        loggedIn: ok || after.loggedIn,
        qrFile,
        qrBase64,
        screenshot,
        url,
        pageText: ok ? undefined : text,
        ...after,
        hint: ok ? '登录成功，登录态已保存' : '还没扫码成功：二维码可能过期，重新调用一次即可换新码',
      };
    },
  },
  {
    name: 'douyin_login_status',
    title: '查看登录状态',
    description: '检查抖音登录态：www（浏览/搜索/评论）与创作者中心（发布/数据）分别是否登录，已登录时返回账号资料。',
    inputSchema: obj({}),
    handler: async () => getLoginState(),
  },
  {
    name: 'douyin_logout',
    title: '退出登录 / 清空登录态',
    description: '清掉浏览器 profile 里的所有抖音 cookie（换号或登录态异常时用）。',
    inputSchema: obj({}),
    handler: async () => {
      await clearLogin();
      return { ok: true, ...(await getLoginState({ withProfile: false })) };
    },
  },
  {
    name: 'douyin_publish_video',
    title: '发布视频',
    description:
      '把本地视频发布到抖音（走创作者中心真实上传流程）：标题、正文、话题、自定义封面、定时发布。强烈建议先用 dryRun=true 走一遍：它会一路填到"发布按钮就在眼前"并截图，确认无误再 dryRun=false 真发。需要先 douyin_login_qrcode 登录。',
    inputSchema: obj({
      file: s('本地视频文件绝对路径（mp4/mov，≥3 秒，建议 9:16）'),
      title: s('作品标题（≤30 字，可留空）'),
      desc: s('正文/简介，可以带 #话题'),
      topics: arr('额外话题数组，不带 # 号，例如 ["职场干货","副业"]'),
      cover: s('自定义封面图片路径（可选）'),
      scheduleAt: s('定时发布时间，格式 "YYYY-MM-DD HH:mm"（可选，最多提前 14 天）'),
      dryRun: b('true = 只填不发布，返回预览截图（建议第一次这么用）'),
      keepOpen: b('停在页面上不要关闭（人可以接手补信息）'),
    }, ['file']),
    handler: async ({ file, title = '', desc = '', topics = [], cover = '', scheduleAt = '', dryRun = true, keepOpen = false }) => {
      return publish({ kind: 'video', files: [file], title, desc, topics, coverFile: cover, scheduleAt, dryRun, keepOpen });
    },
  },
  {
    name: 'douyin_publish_images',
    title: '发布图文',
    description:
      '把一组本地图片发布成抖音图文（最多 35 张）：标题（≤20 字）、正文、话题、可选配乐占位与定时发布。同样建议先 dryRun=true 预览截图。',
    inputSchema: obj({
      files: arr('本地图片绝对路径数组（jpg/png/webp，按顺序展示）'),
      title: s('标题（≤20 字）'),
      desc: s('正文，可以带 #话题'),
      topics: arr('额外话题数组'),
      scheduleAt: s('定时发布时间 "YYYY-MM-DD HH:mm"（可选）'),
      dryRun: b('true = 只填不发布'),
      keepOpen: b('停在页面上'),
    }, ['files']),
    handler: async ({ files, title = '', desc = '', topics = [], scheduleAt = '', dryRun = true, keepOpen = false }) => {
      return publish({ kind: 'images', files, title, desc, topics, scheduleAt, dryRun, keepOpen });
    },
  },
  {
    name: 'douyin_publish_preflight',
    title: '发布前自查',
    description: '不打开浏览器，先检查素材：文件是否存在、时长/分辨率/音轨/大小是否满足抖音要求、定时时间是否合法。',
    inputSchema: obj({
      kind: { type: 'string', enum: ['video', 'images'], description: '发布类型' },
      files: arr('本地文件路径数组'),
      scheduleAt: s('定时时间（可选）'),
    }, ['kind', 'files']),
    handler: async ({ kind, files, scheduleAt }) => {
      const pre = await preflight({ kind, files, scheduleAt });
      return { ok: pre.problems.length === 0, ...pre };
    },
  },
  {
    name: 'douyin_video_stats',
    title: '单条作品数据',
    description: '查自己某条作品在创作者中心的数据（播放/点赞/评论/分享）。作品不在第一页时会退回公开数据（播放量对非本人不公开）。',
    inputSchema: obj({ awemeId: s('作品 ID（19 位数字）') }, ['awemeId']),
    handler: async ({ awemeId }) => videoStats(awemeId),
  },
  {
    name: 'douyin_my_videos',
    title: '我的作品列表与数据',
    description: '从创作者中心作品管理页读出我的作品列表，含每个作品的播放、点赞、评论、分享、状态。做复盘/找哪条该投流的第一手数据。',
    inputSchema: obj({ limit: n('最多多少条（默认 20）', { default: 20 }) }),
    handler: async ({ limit = 20 }) => myVideos({ limit }),
  },
  {
    name: 'douyin_account_overview',
    title: '账号数据概览',
    description: '账号层面的数据：粉丝总数、新增粉丝、播放量、获赞、主页访问、完播率等（从创作者中心首页/数据中心读）。',
    inputSchema: obj({}),
    handler: async () => accountOverview(),
  },
];

// ----------------------------------------------------------------- 互动
const interactTools = [
  {
    name: 'douyin_comments_list',
    title: '评论列表（读）',
    description: '读任意作品评论（我的或别人的）。回复评论前先用它拿到评论 ID。',
    inputSchema: obj({
      target: s('作品链接或作品 ID'),
      count: n('条数（默认 20）', { default: 20 }),
      cursor: s('翻页游标'),
    }, ['target']),
    handler: async ({ target, count = 20, cursor = '0' }) => {
      const t = await locate(target);
      if (t.kind !== 'aweme') throw new Error('需要作品链接或作品 ID');
      return listComments(t.awemeId, { count, cursor });
    },
  },
  {
    name: 'douyin_comment_replies',
    title: '某条评论的回复',
    description: '展开一条评论下的二级回复。',
    inputSchema: obj({
      awemeId: s('作品 ID'),
      commentId: s('评论 ID'),
      count: n('条数', { default: 20 }),
    }, ['awemeId', 'commentId']),
    handler: async ({ awemeId, commentId, count = 20 }) => listReplies(awemeId, commentId, { count }),
  },
  {
    name: 'douyin_comment_publish',
    title: '发评论 / 回复评论',
    description:
      '在作品下发一条新评论，或者回复某条已有评论（给 commentId 就是回复）。这是真实对外发言，注意语气与频率；一次别连发多条（容易被限流）。',
    inputSchema: obj({
      awemeId: s('作品 ID'),
      text: s('评论内容'),
      commentId: s('要回复的评论 ID（可选）'),
    }, ['awemeId', 'text']),
    handler: async ({ awemeId, text, commentId }) => publishComment(awemeId, text, commentId),
  },
  {
    name: 'douyin_digg',
    title: '点赞 / 取消点赞',
    description: '给某条作品点赞或取消点赞（养号互动用，别刷）。',
    inputSchema: obj({
      awemeId: s('作品 ID'),
      unlike: b('true = 取消点赞'),
    }, ['awemeId']),
    handler: async ({ awemeId, unlike = false }) => digg(awemeId, { unlike }),
  },
  {
    name: 'douyin_notifications',
    title: '通知列表',
    description: '读通知：谁评论了你、谁点了赞、谁新关注了你。用来及时互动（运营最有效的动作之一）。',
    inputSchema: obj({ limit: n('条数（默认 20）', { default: 20 }) }),
    handler: async ({ limit = 20 }) => notifications({ limit }),
  },
  {
    name: 'douyin_unread_count',
    title: '未读通知数',
    description: '各分区未读数：评论和@、赞和收藏、新增关注。',
    inputSchema: obj({}),
    handler: async () => unreadCount(),
  },
];

// ----------------------------------------------------------------- 发布队列
const queueTools = [
  {
    name: 'douyin_queue_add',
    title: '加入发布队列',
    description:
      '把一条准备好的内容排进定时发布队列（视频或图文）。到时间由队列守护进程（scripts/queue-daemon.js）或 douyin_queue_run 自动发布。适合"一次排一周内容"的运营节奏。',
    inputSchema: obj({
      kind: { type: 'string', enum: ['video', 'images'], description: '内容类型' },
      files: arr('本地文件绝对路径数组（视频 1 个 / 图文 1~35 张）'),
      title: s('标题'),
      desc: s('正文（可带 #话题）'),
      topics: arr('额外话题数组'),
      scheduleAt: s('计划发布时间 "YYYY-MM-DD HH:mm"（不填=尽快发）'),
      cover: s('封面图路径（可选，仅视频）'),
      dryRun: b('true = 到时只填不发布（人工确认）'),
    }, ['kind', 'files']),
    handler: async ({ kind, files, title = '', desc = '', topics = [], scheduleAt = '', cover = '', dryRun = false }) => {
      const pre = await preflight({ kind, files, scheduleAt });
      if (pre.problems.length) return { ok: false, problems: pre.problems, queued: false };
      const item = addQueueItem({ kind, files, title, desc, topics, cover, scheduleAt, dryRun });
      return { ok: true, queued: true, item };
    },
  },
  {
    name: 'douyin_queue_list',
    title: '查看发布队列',
    description: '列出队列里所有内容与状态（pending/running/done/failed），看今天该发什么。',
    inputSchema: obj({
      status: { type: 'string', enum: ['all', 'pending', 'done', 'failed'], description: '筛状态，默认 all' },
    }),
    handler: async ({ status = 'all' }) => {
      const q = loadQueue();
      const items = status === 'all' ? q.items : q.items.filter((i) => i.status === status);
      return {
        total: q.items.length,
        pending: q.items.filter((i) => i.status === 'pending').length,
        items: items.slice(-50),
      };
    },
  },
  {
    name: 'douyin_queue_cancel',
    title: '取消队列里的一条',
    description: '按 id 取消一条待发布内容。',
    inputSchema: obj({ id: s('队列条目 id') }, ['id']),
    handler: async ({ id }) => {
      const updated = updateQueueItem(id, { status: 'canceled' });
      return updated ? { ok: true, item: updated } : { ok: false, error: `队列里没有 ${id}` };
    },
  },
  {
    name: 'douyin_queue_run',
    title: '执行到期的队列任务',
    description:
      '立刻执行队列里所有到期（scheduleAt 已过或未设）的内容并发布。适合让 agent 定时调用（比如每 10 分钟一次）；也可以直接跑 scripts/queue-daemon.js 常驻。',
    inputSchema: obj({ force: b('true = 忽略时间，把所有 pending 都跑掉') }),
    handler: async ({ force = false }) => {
      const q = loadQueue();
      const now = Date.now();
      const due = q.items.filter(
        (i) =>
          i.status === 'pending' &&
          (force || !i.scheduleAt || new Date(i.scheduleAt.replace(/\//g, '-').replace(' ', 'T')).getTime() <= now + 60_000),
      );
      const results = [];
      for (const item of due) {
        updateQueueItem(item.id, { status: 'running', attempts: (item.attempts || 0) + 1 });
        try {
          const res = await publish({
            kind: item.kind,
            files: item.files,
            title: item.title,
            desc: item.desc,
            topics: item.topics || [],
            coverFile: item.cover || '',
            scheduleAt: item.scheduleAt || '',
            dryRun: Boolean(item.dryRun),
          });
          updateQueueItem(item.id, {
            status: res.ok ? (res.dryRun ? 'needs_confirm' : 'done') : 'failed',
            result: { stage: res.stage, detail: res.detail, screenshot: res.screenshot, problems: res.problems, error: res.error },
          });
          results.push({ id: item.id, ok: res.ok, stage: res.stage, detail: res.detail, error: res.error });
        } catch (err) {
          updateQueueItem(item.id, { status: 'failed', result: { error: err.message } });
          results.push({ id: item.id, ok: false, error: err.message });
        }
        await sleep(3000);
      }
      return { ran: results.length, results, allowSubmit: CONFIG.QUEUE_ALLOW_SUBMIT };
    },
  },
];

export const TOOLS = [...readTools, ...publishTools, ...interactTools, ...queueTools];

export function findTool(name) {
  return TOOLS.find((t) => t.name === name);
}

export function toolManifest() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: `${t.description}`,
    inputSchema: t.inputSchema,
    annotations: { title: t.title },
  }));
}

/** 统一执行入口：捕获异常，返回结构化的 error（MCP 里用 isError 标记） */
export async function callTool(name, args = {}) {
  const tool = findTool(name);
  if (!tool) throw new Error(`没有这个工具：${name}`);
  try {
    const data = await tool.handler(args || {});
    return { ok: true, data };
  } catch (err) {
    log.warn(`工具 ${name} 出错：${err.message}`);
    return {
      ok: false,
      error: {
        message: err.message,
        code: err.code || err.block || null,
        hint: err.hint || null,
        screenshot: err.screenshot || null,
      },
    };
  }
}

export { fetchSelf };
