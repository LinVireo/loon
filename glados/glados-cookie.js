/**
 * GLaDOS Cookie 自动收集器 (Loon Script v2 / MITM http-request 侧)
 *
 * 触发: 手机 Safari 登录/打开 GLaDOS 任意 API 页面时, Loon MITM 劫持该请求,
 *       从请求头提取 Cookie + User-Agent + 域名, 写入 $persistentStore 账号池 (键 `glados_pool`).
 * 多账号: 不同域名/不同浏览器各登录一次即可, 池按 sess 凭据自动去重, 上限 20.
 * 隐私: Cookie 只存本机 Loon 键值存储, 不上报、不打印明文 (只打掩码).
 *
 * $request: { url, method, headers: { Cookie, "User-Agent", ... } }
 * 行为: 只读请求, 恒 $done({}) 不修改转发。
 */

var POOL_KEY = 'glados_pool';
var POOL_MAX = 20;
var DEFAULT_DOMAIN = 'glados.rocks';

function pickHeader(headers, name) {
  if (!headers) return '';
  var target = name.toLowerCase();
  for (var k in headers) if (k.toLowerCase() === target) return String(headers[k] || '');
  return '';
}

function mask(cookie) {
  var m = cookie.match(/(gld|koa):sess=([^;]+)/i);
  return (m ? m[2] : cookie).replace(/\s+/g, '').slice(0, 10) + '\u2026';
}

function main() {
  var url = ($request && $request.url) || '';
  var m = url.match(/^https:\/\/([^/]+)\/api\/user\//i);
  if (!m) return $done({});
  var domain = m[1].toLowerCase();

  var cookie = pickHeader($request.headers, 'Cookie');
  if (!/(?:gld|koa):sess\s*=/i.test(cookie)) return $done({}); // 无凭据, 静默放行

  var ua = pickHeader($request.headers, 'User-Agent') || '';

  var pool = [];
  try { pool = JSON.parse($persistentStore.read(POOL_KEY) || '[]') || []; } catch (e) { pool = []; }
  if (!Array.isArray(pool)) pool = [];

  var sig = (cookie.match(/sess\.sig=([^;]+)/i) || [])[1] || '';
  var sess = (cookie.match(/(?:gld|koa):sess=([^;]+)/i) || [])[1] || '';
  var id = (sig || sess).replace(/\s+/g, '').slice(-40);

  var hit = pool.filter(function (x) { return x.id === id; })[0];
  var known = hit && typeof hit === 'object';

  var added;
  if (known) {
    hit.cookie = cookie;
    hit.ua = ua;
    hit.domain = domain;
    hit.lastSeen = new Date().toISOString();
    added = false;
  } else {
    if (pool.length >= POOL_MAX) {
      $notification.post('GLaDOS Cookie 收集', '\u6cbb\u6807\u5df2\u6ee1 (' + POOL_MAX + ')', '\u4e0d\u518d\u6536\u96c6\u65b0\u5bf9\u8c61, \u8bf7\u5148\u6e05\u7406\u6cbb\u6807\u6c60');
      return $done({});
    }
    pool.push({ id: id, cookie: cookie, ua: ua, domain: domain, added: new Date().toISOString() });
    added = true;
  }

  $persistentStore.write(JSON.stringify(pool), POOL_KEY);
  if (added) {
    $notification.post(
      'GLaDOS Cookie \u5df2\u5165\u5e93',
      '\u7b2c ' + pool.length + ' \u4e2a\u8d26\u53f7 @ ' + domain,
      '\u6252\u6307\u7eb9: ' + mask(cookie) + '\n\u4ee5\u540e\u6bcf\u65e5\u5c06\u81ea\u52a8\u7b7e\u5230, \u82e5\u5931\u6548\u91cd\u65b0\u767b\u5f55\u4e00\u6b21\u5373\u53ef\u5237\u65b0'
    );
  } else {
    console.log('[GLaDOS cookie] \u5237\u65b0\u5df2\u6709\u51ed\u636e @' + domain + ' ' + mask(cookie));
  }
  $done({});
}

main();
