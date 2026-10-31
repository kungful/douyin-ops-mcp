// 抖音 Web 接口参数表。
// 参数名/默认值来自对线上请求的长期观察（Evil0ctal/Douyin_TikTok_Download_API v5 的
// platforms/douyin/params.py 是同一套结论，Apache-2.0）。version_code 过旧会被拒，
// 需要的时候改这里即可，不必动逻辑。
import { UA_FINGERPRINT } from '../config.js';

export const CLIENT = {
  aid: '6383',
  channel: 'channel_pc_web',
  version_code: '290100',
  version_name: '29.1.0',
  update_version_code: '170400',
};

export function baseParams(extra = {}) {
  return {
    device_platform: 'webapp',
    aid: CLIENT.aid,
    channel: CLIENT.channel,
    pc_client_type: '1',
    version_code: CLIENT.version_code,
    version_name: CLIENT.version_name,
    cookie_enabled: 'true',
    screen_width: '1440',
    screen_height: '900',
    browser_language: UA_FINGERPRINT.browser_language,
    browser_platform: UA_FINGERPRINT.browser_platform,
    browser_name: UA_FINGERPRINT.browser_name,
    browser_version: UA_FINGERPRINT.browser_version,
    browser_online: 'true',
    engine_name: UA_FINGERPRINT.engine_name,
    engine_version: UA_FINGERPRINT.engine_version,
    os_name: UA_FINGERPRINT.os_name,
    os_version: UA_FINGERPRINT.os_version,
    cpu_core_num: '12',
    device_memory: '8',
    platform: 'PC',
    downlink: '10',
    effective_type: '4g',
    round_trip_time: '0',
    update_version_code: CLIENT.update_version_code,
    ...extra,
  };
}

export const EP = {
  detail: '/aweme/v1/web/aweme/detail/',
  post: '/aweme/v1/web/aweme/post/',
  likes: '/aweme/v1/web/aweme/favorite/',
  userProfile: '/aweme/v1/web/user/profile/other/',
  queryUser: '/aweme/v1/web/query/user/',
  comments: '/aweme/v1/web/comment/list/',
  commentReplies: '/aweme/v1/web/comment/list/reply/',
  commentPublish: '/aweme/v1/web/comment/publish/',
  digg: '/aweme/v1/web/commit/item/digg/',
  trending: '/aweme/v1/web/hot/search/list/',
  hotSpot: '/aweme/v1/web/channel/hotspot',
  searchVideo: '/aweme/v1/web/search/item/',
  searchGeneral: '/aweme/v1/web/general/search/single/',
  searchUser: '/aweme/v1/web/discover/search/',
  mixPosts: '/aweme/v1/web/mix/aweme/',
  musicPosts: '/aweme/v1/web/music/aweme/',
  musicDetail: '/aweme/v1/web/music/detail/',
  challengeAweme: '/aweme/v1/web/challenge/aweme/',
  related: '/aweme/v1/web/aweme/related/',
  followFeed: '/aweme/v1/web/feed/follow/',
  selfProfile: '/aweme/v1/web/im/user/info/',
};

export const P = {
  detail: (aweme_id) => baseParams({ aweme_id: String(aweme_id) }),

  userProfile: (sec_user_id) =>
    baseParams({
      sec_user_id: String(sec_user_id),
      publish_video_strategy_type: '2',
      personal_center_strategy: '1',
    }),

  post: (sec_user_id, { cursor = '0', count = 20 } = {}) =>
    baseParams({
      sec_user_id: String(sec_user_id),
      max_cursor: String(cursor),
      count: String(count),
      publish_video_strategy_type: '2',
      from_user_page: '1',
      locate_query: 'false',
      need_time_list: '1',
      show_live_replay_strategy: '1',
      time_list_query: '0',
      pc_libra_divert: 'Windows',
      whale_cut_token: '',
    }),

  likes: (sec_user_id, { cursor = '0', count = 20 } = {}) =>
    baseParams({
      sec_user_id: String(sec_user_id),
      max_cursor: String(cursor),
      count: String(count),
      publish_video_strategy_type: '2',
      from_user_page: '1',
    }),

  comments: (aweme_id, { cursor = '0', count = 20 } = {}) =>
    baseParams({
      aweme_id: String(aweme_id),
      cursor: String(cursor),
      count: String(count),
      item_type: '0',
      insert_ids: '',
      whale_cut_token: '',
      cut_version: '1',
      rcFT: '',
    }),

  commentReplies: (item_id, comment_id, { cursor = '0', count = 20 } = {}) =>
    baseParams({
      item_id: String(item_id),
      comment_id: String(comment_id),
      cursor: String(cursor),
      count: String(count),
      item_type: '0',
    }),

  trending: (board = 'hot') => {
    const boards = {
      hot: ['0', ''],
      entertainment: ['2', '2'],
      society: ['2', '4'],
      challenge: ['2', 'hotspot_challenge'],
    };
    const [board_type, board_sub_type] = boards[board] || boards.hot;
    return baseParams({
      detail_list: '1',
      source: '6',
      board_type,
      board_sub_type,
    });
  },

  // 热点视频流：不需要登录，一次性返回一整屏带完整 aweme 对象的数据
  hotSpot: ({ tag_id = '', count = 20, cursor = '0' } = {}) =>
    baseParams({
      tag_id,
      count: String(count),
      cursor: String(cursor),
      source: '6',
    }),

  searchVideo: (keyword, { offset = '0', count = 10, sort_type = '0' } = {}) =>
    baseParams({
      keyword,
      search_channel: 'aweme_video_web',
      sort_type,
      publish_time: '0',
      filter_duration: '0',
      search_source: 'tab_search',
      query_correct_type: '1',
      is_filter_search: '0',
      offset: String(offset),
      count: String(count),
    }),

  searchUser: (keyword, { offset = '0', count = 10 } = {}) =>
    baseParams({
      keyword,
      search_channel: 'aweme_user_web',
      search_source: 'normal_search',
      query_correct_type: '1',
      is_filter_search: '0',
      offset: String(offset),
      count: String(count),
    }),

  mixPosts: (mix_id, { cursor = '0', count = 20 } = {}) =>
    baseParams({
      mix_id: String(mix_id),
      cursor: String(cursor),
      count: String(count),
      need_time_list: '0',
    }),

  musicPosts: (music_id, { cursor = '0', count = 20 } = {}) =>
    baseParams({
      music_id: String(music_id),
      cursor: String(cursor),
      count: String(count),
    }),

  challengeAweme: (ch_id, { cursor = '0', count = 20 } = {}) =>
    baseParams({
      ch_id: String(ch_id),
      cursor: String(cursor),
      count: String(count),
    }),
};
