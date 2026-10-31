# 抖音运营 MCP（douyin-ops-mcp）

仓库：<https://github.com/kungful/douyin-ops-mcp> · 配套 Pi 技能：`~/.pi/agent/skills/douyin-ops`

一个给 agent 用的抖音运营工具：**采集解析 → 爆款拆解 → 内容排期 → 自动发布 → 数据复盘**，全链路。

融合了四个上游项目各自的长处，但代码是重写的（因为它们的核心部分在国内网络下都跑不通或已经过时）：

| 上游 | 它的长处 | 我们怎么用 |
|---|---|---|
| [Evil0ctal/Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API) | 十年踩坑攒下来的接口参数表、数据模型、无水印地址选择逻辑、a_bogus 签名的成因分析 | 端点/参数表、`bit_rate` 选流策略、错误码语义、MCP 工具面"宁可少而准"的设计观 |
| [yzfly/douyin-mcp-server](https://github.com/yzfly/douyin-mcp-server) | 链接 → 视频 → 音频 → 文案 的 ASR 链路 | 文案提取做成三级降级（硅基流动 → 百炼 → 本地 faster-whisper） |
| [anYuJia/better-douyin](https://github.com/anYuJia/better-douyin) | 采集/批量/导出的产品化思路（它是 Tauri 壳，功能在闭源发行版里） | 批量下载、去重清单、素材库这些运营侧的信息架构 |
| [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | MCP 工具面的划分方式（登录/发布/搜索/详情/评论/通知），以及"登录态持久化"这套工程范式 | 工具命名与分组、扫码登录 + profile 复用、发布前 dryRun 预览的习惯 |

## 关键设计：为什么必须有浏览器

抖音 Web 的每个 `/aweme/v1/web/*` 请求都要带 `a_bogus` 签名，算法藏在字节码 VM 里（`bdms.js`），
而且**站点自己已经给 `fetch` 打了补丁**：任何从抖音页面上下文里发出的 `/aweme/v1/web/*` 请求，
a_bogus、msToken、指纹 cookie 全都会自动补齐。

所以本项目的接口调用方式是——**在真实 Chrome 的抖音标签页里 `page.evaluate(fetch(...))`**：

```
✅ 免登录：作品详情、用户资料、作品列表、评论、热榜、热点视频流
❌ 需要登录：搜索、发布、我的作品数据、评论/通知、点赞评论等写操作
```

代价是必须有浏览器；好处是**签名规则变了不用跟**（上游那个项目为此维护了 4000 行签名代码，
还需要 cookie 池 + 代理池）。而"运营账号"本来就得登录浏览器，所以这个代价是白送的。

## 快速开始

```bash
cd "C:\Users\hua\Documents\备份代码\douyin-mcp-fusion"
npm install                 # 只依赖 playwright-core，用系统 Chrome，不下载浏览器
npm run smoke               # 自检：热榜/解析/评论/登录态（会弹一次 Chrome 窗口）
npm run smoke -- --full     # 再跑下载 + 文案提取
```

注册到 pi（已写入 `~/.pi/agent/mcp.json`）后，在 pi 里执行 `/reload` 即可看到 29 个工具。

首次使用先登录一次（登录态存进 `data/browser-profile`，之后不用再扫）：

```
douyin_login_qrcode({ waitSeconds: 120 })   # 抓二维码 → 用户用抖音 App 扫码
douyin_login_status({})                     # 确认 www / 创作者中心 都登录了
```

## 工具清单（29 个）

### 采集 · 免登录
| 工具 | 干什么 |
|---|---|
| `douyin_parse` | 分享链接/文案/ID/主页 → 结构化作品（无水印地址、图集、话题、音乐、互动数据） |
| `douyin_download` | 下一条作品（视频取最高可用 H.264、图集全下、可选 BGM），带去重清单 |
| `douyin_batch_download` | 批量：博主主页 / 关键词搜索 / 热点视频流，带游标与限速 |
| `douyin_user_profile` | 博主资料 + 作品列表（对标账号分析） |
| `douyin_trending` | 热榜（总榜/娱乐/社会/挑战）+ 热点视频流（带数据的选题池） |
| `douyin_comments` | 作品评论（点赞数、IP 属地、作者是否回复、二级回复） |
| `douyin_transcribe` | 视频转文案：硅基流动 → 百炼 → 本地 faster-whisper 三级降级 |
| `douyin_breakdown` | **爆款拆解**：数据定性 + 前 3 秒钩子 + 口播前中后三段 + 热评需求 |
| `douyin_local_check` | 发布前自查：时长/分辨率/宽高比/音轨/大小 |

### 登录 · 发布
| 工具 | 干什么 |
|---|---|
| `douyin_login_qrcode` | 抓扫码登录二维码（base64 PNG + 文件），等扫码，登录态持久化 |
| `douyin_login_status` / `douyin_logout` | 看登录态 / 清登录态（换号用） |
| `douyin_publish_video` | 发布视频：标题、正文、话题、封面、定时；**支持 dryRun 预览截图** |
| `douyin_publish_images` | 发布图文（≤35 张） |
| `douyin_publish_preflight` | 不开浏览器，先校验素材与定时参数 |

### 数据 · 互动
| 工具 | 干什么 |
|---|---|
| `douyin_my_videos` | 我的作品列表 + 每条的播放/点赞/评论/分享（创作者中心真实数据） |
| `douyin_video_stats` | 单条作品数据 |
| `douyin_account_overview` | 账号概览：粉丝、新增、播放、获赞、主页访问、完播率 |
| `douyin_comments_list` / `douyin_comment_replies` | 读评论 / 展开二级回复 |
| `douyin_comment_publish` | 发评论 / 回复评论 |
| `douyin_digg` | 点赞 / 取消点赞 |
| `douyin_notifications` / `douyin_unread_count` | 通知列表 / 未读数 |

### 排期 · 自动化
| 工具 | 干什么 |
|---|---|
| `douyin_queue_add` | 把内容排进发布队列（含定时时间） |
| `douyin_queue_list` / `douyin_queue_cancel` | 看队列 / 取消 |
| `douyin_queue_run` | 立刻执行到期任务（agent 定时调用即可） |

常驻发布：`npm run queue`（或双击 `start-queue.cmd`），每 30 秒检查一次队列，到点自动发。

## 一条完整的运营链路长这样

```
1) 选题   douyin_trending({board:'hot', videos:10})
          → 今天有什么在涨；挑 3 个和你赛道交叉的

2) 对标   douyin_search({keyword:'咖啡拉花'})  → douyin_breakdown({target: 爆款链接})
          → 搞清楚它为什么起：钩子句式、结构、热评里的真实需求

3) 采集   douyin_batch_download({source:'user', target:'竞品主页', limit:10})
          → 素材库；配 douyin_transcribe 拆口播

4) 创作   用 videostudio 技能剪片（或本地已有成片）
          douyin_local_check({file})  → 规格过不了就别发了

5) 发布   douyin_publish_video({file, title, desc, topics, dryRun:true})
          → 看预览截图确认 → dryRun:false 真发
          或者 douyin_queue_add 排进一周的档期

6) 复盘   douyin_my_videos({limit:20}) + douyin_account_overview({})
          → 哪条值得投流/切片；douyin_notifications 及时回评论
```

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DOUYIN_DATA` | 数据根目录（profile/下载/队列/模型） | `<项目>/data` |
| `DOUYIN_DOWNLOAD_DIR` | 下载目录 | `<数据>/downloads` |
| `DOUYIN_HEADLESS` | `1` = 无头（**不推荐**，必被风控） | 有头 |
| `DOUYIN_CHROME_CHANNEL` | `chrome` / `msedge` | `chrome` |
| `DOUYIN_CHROME_EXECUTABLE` | 指定 Chrome 路径（覆盖 channel） | — |
| `SILICONFLOW_API_KEY`（或 `API_KEY`） | 硅基流动 ASR，最快最便宜 | — |
| `DASHSCOPE_API_KEY` | 阿里云百炼 qwen3-asr | — |
| `DOUYIN_WHISPER_MODEL` | 本地 whisper 尺寸 `tiny/base/small/medium/large-v3` | `small` |
| `DOUYIN_QUEUE_ALLOW_SUBMIT` | `0` = 队列只填不点发布（人工确认） | `1` |
| `DOUYIN_PYTHON` / `DOUYIN_FFMPEG` / `DOUYIN_FFPROBE` | 外部命令路径 | PATH 里的 |

没有 ASR key 也能用：会自动落到本地 faster-whisper（首次从 ModelScope 下模型，`small` 约 484MB）。

## 反爬与稳定性（踩过的坑）

- **无头浏览器必然吃滑块**。默认有头；用户能看到 Chrome 窗口，需要过验证码时手动过一下，之后 profile 里就干净了。
- 命中验证码/登录墙/风控时，工具不会静默失败，而是返回带截图路径的明确提示（`BrowserBlockedError`）。
- 频率：批量采集每条间隔 1.2~2.7 秒随机；一次 `limit` 建议 ≤30。
- `version_code=290100` 是当前 Web 客户端版本，抖音大版本升级后可能需要更新 `src/douyin/params.js`。
- 公开接口的 `play_count` 对别人的作品永远是 0（不是真 0 播放）；真实播放量只有创作者中心有 → 用 `douyin_my_videos`。

## 目录结构

```
src/
  server.js              MCP stdio 服务（手写 JSON-RPC，不依赖 SDK）
  tools/index.js         29 个工具的定义与描述（描述是写给模型看的）
  browser/manager.js     持久化 Chrome（唯一 profile）+ 页面池
  browser/pagekit.js     导航、验证码/风控识别、多候选选择器点击填写
  douyin/client.js       ★ 页内 fetch（站点自动签名）+ 错误码语义
  douyin/params.js       接口参数表
  douyin/parse.js        链接/ID/主页 定位 + 详情/列表/搜索/热榜
  douyin/normalize.js    aweme/user/comment → 运营关心的字段
  douyin/media.js        下载、ffmpeg 探针、抽帧、发布规格校验
  douyin/asr.js          ASR 三级降级
  douyin/breakdown.js    爆款拆解
  creator/login.js       扫码登录、登录态判定、会话预热
  creator/publish.js     视频/图文发布（多候选选择器 + dryRun + 逐步报告）
  creator/stats.js       我的作品 / 账号概览 / 单条数据
  creator/interactions.js 评论、回复、点赞、通知
  creator/scrape.js      创作者中心表格抓取与指标解析
  store.js               队列 / 素材库 / 下载清单（原子写 JSON）
python/asr_whisper.py    本地 faster-whisper（ModelScope 下模型）
scripts/                 smoke / protocol-test / login / queue-daemon
```

## 实测记录（2026-10-31，账号「苏维埃」）

`node scripts/test-suite.js all` 的成绩：**12/14 通过**（报告在 `data/test-report-all.md`）。

| 能力 | 状态 | 备注 |
|---|---|---|
| 解析 / 下载 / 评论读 / 热榜 / 主页 / 热点流 | ✅ | 免登录 |
| 搜索视频 / 搜索用户 | ✅ | 需要登录；响应里的 `guide_search_words` 当选题联想词用 |
| 我的作品列表 / 账号概览 / 单条数据 | ✅ | 创作者中心真实数据（播放、完播率、2秒跳出率、吸粉量） |
| 待回复评论（替代通知） | ✅ | 抖音 Web 通知中心已不存在（/notice、/messages 全 404），改用"评论待回复" |
| 扫码登录 + 登录态持久化 | ✅ | www 登录弹窗里的 base64 二维码 |
| **发布视频（标题+描述+话题）** | ✅ | 已真发 `7702758021469949193`，全部字段落库 |
| **发布图文（多图）** | ✅ 预览 | dryRun 全流程通过（真发没跑，避免再留测试帖） |
| 定时发布 | ✅ | 时间输入框读回校验通过 |
| **发评论（UI 路径）** | ✅ | 在作品页评论区输入并回车，读回验证通过 |
| 点赞 | ⚠️ | 同一颗心有时点得动有时不动（DOM 里只有 0×0 的隐藏副本），偶发 no-op |
| 自定义封面 | ❌ 已知限制 | 平台封面弹窗要求人工裁切/确认，自动点「完成」不生效；已做到"失败就关弹窗、不挡发布" |

踩过并已修掉的坑：

1. 上传页是 React，`input[type=file]` 要等挂载完才出现（约 10s）。
2. 发布编辑页真实路径是 `/content/post/video`，不是 `/content/publish`。
3. 标题要 `.type()` 并读回 `inputValue()`；描述**必须鼠标点进 `.zone-container` 再 `insertText`**（点 locator 不聚焦，第一版就这么发出去一条空描述）。
4. 图文必须先点「发布图文」切模式，否则拿到的是只收 `video/*` 的单文件 input。
5. 话题走页面 `#添加话题` → 输入 → 点联想项，并读回校验。
6. 页面 `innerText` 里常驻"上传中"文案，不能拿来判断上传状态；要用发布按钮状态 + 预览视频 duration。
7. **点完发布 ≠ 发完**：抖音先提交再后台上传（右下角百分比），上传没走完关浏览器就断了。
8. 定时发布是 `<label><input type=checkbox><span>定时发布</span></label>` 的自定义单选，`getByText().click()` 会被 span 拦截超时，只能 `label.click()`。
9. 抖音大量 `data-e2e` 节点是 **0×0 的隐藏副本**：`waitForSelector` 默认等 visible 会一直超时，必须 `state:'attached'`。
10. 封面弹窗装不下 Esc / 取消，只有右上角那颗 svg X 能关；关不掉会挡住"发布"按钮。
11. Web 写接口（comment/publish、commit/item/digg）直接被风控：`status_code=8` / `4`，所以互动走 UI。
12. 连续高频操作会被限流（页面 30s 渲染不出内容）——测试的时候要把节奏放慢。

## 已知限制

- 创作者中心改版后选择器会失效。第一次发请务必 `dryRun: true` 看截图；失败时返回的 `steps` 会指出卡在哪一步，改那一步的选择器即可。
- **自定义封面不可用**（平台要人工裁切）：建议不传 `cover`，用平台自动封面；工具会在失败时自动关掉弹窗，不影响发布。
- **点赞偶发 no-op**：页面只暴露 0×0 的隐藏节点，点了没反应时重试一次即可；批量养号别指望它。
- 抖音会限流连续高频操作（页面 30s 渲染不出来），批量采集/互动要放慢节奏。
- 创作者中心的表格结构随版本变化，`douyin_my_videos` 解析不到时会退回返回页面文本，供人工定位。
- 只支持抖音（中国区），不含 TikTok。
- 不做刷量、不做多账号矩阵（同一 profile 只能登一个号；多号就复制一份 data 目录并改 `DOUYIN_DATA`）。

## 许可与致谢

本项目代码为自研。接口参数/数据结构的知识来源见上表（上游均为 Apache-2.0，只借鉴了参数名、
数据字段和工程判断，没有拷贝其代码）。`a_bogus` 的成因分析出自上游 `docs/design/17-signature-reversing.md` —
但本项目**没有实现签名算法**，用的是"在页面里让站点自己签"这条更稳的路。
