// 把抖音返回的 aweme / user 原始结构，压成运营真正关心的字段。
// 原则：给 agent 看的字段要少而稳（id/作者/数据/无水印地址/话题/音乐），
// 原始结构只在需要排查时通过 raw=true 打开。

const pick = (obj, path, fallback = null) => {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur == null) return fallback;
    cur = cur[key];
  }
  return cur ?? fallback;
};

const firstUrl = (list) => (Array.isArray(list) && list.length ? list[0] : null);

/** 从 bit_rate 列表里挑一个可用性最好的 mp4（优先 H.264，码率最高） */
function bestPlayUrl(video) {
  const candidates = [];
  for (const br of video.bit_rate || []) {
    const url = firstUrl(pick(br, 'play_addr.url_list', []));
    if (!url) continue;
    candidates.push({
      url,
      bitRate: br.bit_rate || 0,
      isH265: Boolean(br.is_h265 || br.is_bytevc1),
      format: br.format,
      width: br.play_addr?.width,
      height: br.play_addr?.height,
      size: br.play_addr?.data_size,
    });
  }
  if (!candidates.length) {
    const url = firstUrl(pick(video, 'play_addr.url_list', []));
    return url ? { url, bitRate: 0, isH265: Boolean(video.is_h265), format: video.format } : null;
  }
  // 能用 H.264 就用 H.264（兼容性最好），同编码下取码率最高的
  const h264 = candidates.filter((c) => !c.isH265 && (c.format || 'mp4').includes('mp4'));
  const pool = h264.length ? h264 : candidates;
  pool.sort((a, b) => b.bitRate - a.bitRate);
  return pool[0];
}

/** 无水印播放地址（play_addr 本身就无水印；download_addr 带水印，别用） */
export function noWatermarkUrl(aweme) {
  const best = bestPlayUrl(aweme.video || {});
  return best?.url || null;
}

export function normalizeAweme(aweme, { includeRaw = false } = {}) {
  if (!aweme) return null;
  const video = aweme.video || {};
  const best = bestPlayUrl(video);
  const isImages = Array.isArray(aweme.images) && aweme.images.length > 0;
  const images = isImages
    ? aweme.images.map((img, i) => ({
        index: i,
        url: firstUrl(img.url_list || []),
        width: img.width,
        height: img.height,
        // 图集里也可能夹视频
        video: img.video ? firstUrl(pick(img, 'video.play_addr.url_list', [])) : null,
      }))
    : [];

  const topics = (aweme.text_extra || [])
    .filter((t) => t && t.hashtag_name)
    .map((t) => ({ name: t.hashtag_name, id: t.hashtag_id }));

  const music = aweme.music
    ? {
        id: aweme.music.id_str || aweme.music.id,
        title: aweme.music.title,
        author: aweme.music.author,
        duration: aweme.music.duration,
        url: firstUrl(pick(aweme.music, 'play_url.url_list', [])),
      }
    : null;

  const stats = aweme.statistics || {};
  const out = {
    type: isImages ? 'images' : 'video',
    id: aweme.aweme_id,
    desc: (aweme.desc || '').trim(),
    createdAt: aweme.create_time ? new Date(aweme.create_time * 1000).toISOString() : null,
    shareUrl: `https://www.douyin.com/${isImages ? 'note' : 'video'}/${aweme.aweme_id}`,
    duration: video.duration ? Math.round(video.duration / 100) / 10 : null, // 秒
    ratio: video.ratio || null,
    size: { width: video.width || null, height: video.height || null },
    author: aweme.author
      ? {
          uid: aweme.author.uid,
          secUid: aweme.author.sec_uid,
          nickname: aweme.author.nickname,
          douyinId: aweme.author.unique_id || aweme.author.short_id,
          signature: (aweme.author.signature || '').slice(0, 200),
          followerCount: aweme.author.follower_count ?? null,
          awemeCount: aweme.author.aweme_count ?? null,
          avatar: firstUrl(pick(aweme.author, 'avatar_thumb.url_list', [])),
          verified: Boolean(aweme.author.custom_verify || aweme.author.enterprise_verify_reason),
        }
      : null,
    stats: {
      play: stats.play_count || null, // 0 表示对公开接口不可见，不是真的 0 播放
      digg: stats.digg_count ?? null,
      comment: stats.comment_count ?? null,
      share: stats.share_count ?? null,
      collect: stats.collect_count ?? null,
      recommend: stats.recommend_count ?? null,
    },
    video: isImages
      ? null
      : {
          noWatermarkUrl: best?.url || null,
          bitRate: best?.bitRate || null,
          codec: best?.isH265 ? 'h265' : 'h264',
          cover: firstUrl(pick(video, 'cover.url_list', [])),
          dynamicCover: firstUrl(pick(video, 'dynamic_cover.url_list', [])),
        },
    images,
    music,
    topics,
    isTop: Boolean(aweme.is_top),
    mediaType: aweme.aweme_type,
  };
  if (includeRaw) out.raw = aweme;
  return out;
}

export function normalizeUser(user, { includeRaw = false } = {}) {
  if (!user) return null;
  const u = {
    uid: user.uid,
    secUid: user.sec_uid,
    nickname: user.nickname,
    douyinId: user.unique_id || user.short_id,
    signature: user.signature,
    avatar: firstUrl(pick(user, 'avatar_larger.url_list', [])),
    followingCount: user.following_count ?? null,
    followerCount: user.follower_count ?? null,
    totalFavorited: user.total_favorited ?? null,
    awemeCount: user.aweme_count ?? null,
    favoritingCount: user.favoriting_count ?? null,
    verified: user.custom_verify || user.enterprise_verify_reason || null,
    gender: user.gender,
    city: user.city,
    province: user.province,
    ipLocation: user.ip_location,
    homePage: user.sec_uid ? `https://www.douyin.com/user/${user.sec_uid}` : null,
  };
  if (includeRaw) u.raw = user;
  return u;
}

export function normalizeComment(c) {
  if (!c) return null;
  return {
    id: c.cid,
    text: c.text,
    createdAt: c.create_time ? new Date(c.create_time * 1000).toISOString() : null,
    diggCount: c.digg_count ?? 0,
    replyCount: c.reply_comment_total ?? 0,
    isAuthor: Boolean(c.is_author),
    ipLabel: c.ip_label || null,
    user: c.user
      ? {
          uid: c.user.uid,
          secUid: c.user.sec_uid,
          nickname: c.user.nickname,
          avatar: firstUrl(pick(c.user, 'avatar_thumb.url_list', [])),
          signature: c.user.signature,
        }
      : null,
    replyId: c.reply_id || null,
    replies: (c.reply_comment || []).slice(0, 3).map(normalizeComment).filter(Boolean),
  };
}

export function normalizeTrending(payload) {
  const data = payload?.data || {};
  const board = (data.word_list || []).map((w) => ({
    rank: w.position,
    word: w.word,
    hotValue: w.hot_value,
    videoCount: w.video_count,
    sentenceId: w.sentence_id,
    label: w.label,
    cover: firstUrl(pick(w, 'word_cover.url_list', [])),
    eventTime: w.event_time ? new Date(w.event_time * 1000).toISOString() : null,
    url: w.sentence_id ? `https://www.douyin.com/hot/${w.sentence_id}` : null,
  }));
  return { board: data.active_time ? board : board, trending: data.trending_list || [] };
}
