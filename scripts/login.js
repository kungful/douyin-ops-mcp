#!/usr/bin/env node
// 单独扫码登录（不经过 agent 的时候用）：打开浏览器 + 抓二维码图片 + 等扫码。
// 用法：node scripts/login.js [--wait 180]
import fs from 'node:fs';
import { logger } from '../src/log.js';
import { getLoginState, openLoginPage, waitForLogin } from '../src/creator/login.js';
import { closeBrowser } from '../src/browser/manager.js';

const log = logger('login');
const waitIdx = process.argv.indexOf('--wait');
const waitSec = waitIdx > 0 ? Number(process.argv[waitIdx + 1]) || 180 : 180;

const state = await getLoginState({ withProfile: false });
if (state.loggedIn) {
  const s = await getLoginState();
  log.info(`已经登录：${s.me?.nickname || '(读不到昵称)'}  www=${s.wwwLoggedIn} creator=${s.creatorLoggedIn}`);
  await closeBrowser();
  process.exit(0);
}

const { qrFile, full } = await openLoginPage();
if (qrFile) {
  const b64 = fs.readFileSync(qrFile).toString('base64');
  log.info(`二维码已保存：${qrFile}`);
  console.log(`\n二维码图片（base64，可直接粘到浏览器地址栏 data:image/png;base64,${b64.slice(0, 20)}…）：\n${qrFile}\n`);
} else {
  log.warn(`没抓到二维码元素，整页截图在：${full}（请在弹出的浏览器窗口里手动登录）`);
}
log.info(`等扫码，最多 ${waitSec} 秒…`);
const ok = await waitForLogin({ timeoutSec: waitSec });
const after = await getLoginState();
log.info(ok ? `登录成功：${after.me?.nickname || ''}` : '超时未完成扫码');
console.log(JSON.stringify(after, null, 2));
await closeBrowser();
process.exit(ok ? 0 : 1);
