/**
 * GLaDOS 多账号签到 — Loon Script (v2 统一语法, Build 983+; 设备 3.5.2(1005) 验证目标)
 *
 * 入口: cron 定时 + generic 手动面板, 双入口共用本脚本 (参数一致)
 * $argument 形态:
 *   - 插件对象参数 {${cookies}, ${notify}, ${delay}, ${force}} → Object
 *   - 或 JSON 字符串 / 纯 cookie 串 (兼容手动调用)
 *
 * Cookie 池格式 (argument.cookies):
 *   账号1&账号2&账号3...
 *   账号 = [domain@]cookieString
 *     - domain 可省略, 默认 glados.rocks
 *     - cookieString = 浏览器登录后复制的完整 Cookie, 必须含 (koa|gld):sess 与 *.sig=
 *
 * 无需 MitM; 全部为脚本主动 $task.fetch。
 */

var DEFAULT_DOMAIN = 'glados.rocks';
var TOKEN = 'glados.one'; // checkin body token (生态基准值, live 阶段以抓包为准)
var DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// 服务端风控: checkin 校验 UA 平台与登录设备一致性 (code:4 device-mismatch)。cookie 在哪台设备拿的, UA 就用那台的。
var RETRY = 1; // 网络/5xx 自动补打一次

// ---------- 参数解析 ----------

function parseArg(a) {
  if (a && typeof a === 'object') return a;
  if (typeof a === 'string' && a.trim().charAt(0) === '{') {
    try { return JSON.parse(a); } catch (e) { /* fallthrough */ }
  }
  return { cookies: typeof a === 'string' ? a : '' };
}

function parseAccounts(s) {
  var out = [];
  String(s || '')
    .split('&')
    .forEach(function (part) {
      var entry = part.trim();
      if (!entry) return;
      var domain = DEFAULT_DOMAIN;
      var cookie = entry;
      var at = entry.indexOf('@');
      if (at > 0 && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(entry.slice(0, at))) {
        domain = entry.slice(0, at).toLowerCase();
        cookie = entry.slice(at + 1).trim();
      }
      var id = cookie.replace(/\s+/g, '').slice(0, 10);
      out.push({
        domain: domain,
        cookie: cookie,
        mask: (id || '?') + '…',
        badFormat: !/(?:koa|gld):sess\s*=/i.test(cookie),
      });
    });
  return out;
}

// ---------- 基础设施 ----------

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function dig(obj) {
  var cur = obj;
  for (var i = 1; i < arguments.length; i++) {
    if (cur == null) return null;
    cur = cur[arguments[i]];
  }
  return cur == null ? null : cur;
}

function fetchJSON(opts) {
  return new Promise(function (resolve) {
    $task.fetch(opts).then(
      function (resp) {
        var body = resp.body;
        var data = null;
        if (typeof body === 'string' && body) {
          try { data = JSON.parse(body); } catch (e) { data = { __raw: body.slice(0, 200) }; }
        }
        resolve({ status: resp.statusCode || resp.status || 0, data: data, raw: resp });
      },
      function (err) {
        resolve({ status: 0, data: null, err: (err && (err.message || err.error || String(err))) || 'network' });
      }
    );
  });
}

function baseHeaders(cookie, ua, extra) {
  var h = {
    'User-Agent': ua || DEFAULT_UA,
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://glados.rocks/console/checkin',
    Origin: 'https://glados.rocks',
  };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

// 单账号: status(验活+剩余天数) → checkin(幂等)。返回结果记录。
function runAccount(acc, ua, note) {
  var origin = 'https://' + acc.domain;
  var referer = origin + '/console/checkin';

  function attempt(url, method, extra) {
    var headers = baseHeaders(acc.cookie, ua, extra && extra.contentType ? { 'Content-Type': extra.contentType } : null);
    headers.Referer = referer;
    headers.Origin = origin;
    var req = { url: url, method: method, headers: headers, timeout: 20 };
    if (extra && extra.body != null) req.body = extra.body;
    return fetchJSON(req).then(function (res) {
      if ((res.status === 0 || res.status >= 500) && RETRY > 0) {
        return sleep(4000).then(function () { return fetchJSON(req); });
      }
      return res;
    });
  }

  return attempt(origin + '/api/user/status', 'GET').then(function (st) {
    if (st.status === 401 || st.status === 403) return { acc: acc, state: 'expired', detail: 'HTTP ' + st.status };
    if (st.status === 0) return { acc: acc, state: 'netfail', detail: st.err || 'unknown' };
    if (st.status !== 200) return { acc: acc, state: 'fail', detail: 'status HTTP ' + st.status };

    var leftDays = dig(st.data, 'leftDays');
    if (leftDays == null) leftDays = dig(st.data, 'list', 'leftDays');
    if (leftDays != null) leftDays = parseFloat(leftDays);

    if (acc.badFormat) return { acc: acc, state: 'bad', detail: 'cookie 不含 (koa|gld):sess' };

    return attempt(origin + '/api/user/checkin', 'POST', {
      contentType: 'application/json;charset=UTF-8',
      body: JSON.stringify({ token: TOKEN }),
    }).then(function (ck) {
      if (ck.status === 401 || ck.status === 403)
        return { acc: acc, state: 'expired', detail: 'HTTP ' + ck.status + (leftDays != null ? ' (剩' + leftDays + '天)' : '') };
      if (ck.status === 0) return { acc: acc, state: 'netfail', detail: ck.err || 'unknown' };
      if (ck.status !== 200) return { acc: acc, state: 'fail', detail: 'checkin HTTP ' + ck.status };

      var msg = dig(ck.data, 'message') || '';
      var code = dig(ck.data, 'code');
      var reason = String(dig(ck.data, 'reason') || '');
      var pts = dig(ck.data, 'points');
      var space = dig(ck.data, 'list', 'leftDays');
      if (space == null) space = leftDays;
      if (space != null) space = parseFloat(space);
      var tail = (space != null ? ' (剩' + space + '天)' : '');
      // 判定矩阵 (2026-10-13 实测: code 结构化字段优先, 文案不可靠)
      if (code === 0) return { acc: acc, state: 'ok', detail: '✦' + (pts != null ? pts + '分 ' : '') + msg + tail };
      if (code === 1) return { acc: acc, state: 'dup', detail: msg + tail };
      if (code === 4 || reason === 'device-mismatch' || /automated/i.test(msg))
        return { acc: acc, state: 'risk', detail: 'UA 与登录设备不符 (改自定义 UA 参数): ' + (reason || msg) };
      if (code == null && /already/i.test(msg)) return { acc: acc, state: 'dup', detail: msg + tail }; // 兜底
      return { acc: acc, state: 'fail', detail: (code != null ? 'code' + code + ' ' : '') + msg || ('HTTP ' + ck.status) };
    });
  });
}

// ---------- 主流程 ----------

function main() {
  var arg = parseArg($argument);
  var force = arg.force === true || arg.force === 'true';
  var doNotify = !(arg.notify === false || arg.notify === 'false');
  var delaySec = Number(arg.delay);
  if (!isFinite(delaySec) || delaySec < 0) delaySec = 3;

  var accounts = parseAccounts(arg.cookies);

  function finish(lines, skipped) {
    if (lines && lines.length && doNotify) {
      $notification.post(lines[0], lines[1] || '', lines.slice(2).join('\n'));
    }
    console.log(JSON.stringify(skipped || lines));
    $done();
  }

  if (!accounts.length) {
    return finish(['GLaDOS 签到', '未配置', '请编辑插件 [Argument] 填入 Cookie 池 (多账号用 & 分隔)']);
  }

  var now = new Date();
  var today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  var stateKey = 'glados_last_run';
  var prevState = null;
  try { prevState = JSON.parse($persistentStore.read(stateKey) || 'null'); } catch (e) { prevState = null; }

  if (prevState && prevState.date === today && prevState.done && !force) {
    return finish(
      ['GLaDOS 签到', '今日已完成 (' + prevState.summary + ')', ' 再次执行请开启「忽略今日已签记录」'],
      { skipped: true, date: today }
    );
  }

  var chain = Promise.resolve();
  var results = [];
  accounts.forEach(function (acc, i) {
    chain = chain
      .then(function () { if (i > 0) return sleep(delaySec * 1000); })
      .then(function () { return runAccount(acc, arg.ua || ''); })
      .then(function (r) { console.log('[' + acc.mask + '] ' + r.state + ' ' + r.detail); results.push(r); });
  });

  chain.then(function () {
    var ok = results.filter(function (r) { return r.state === 'ok'; });
    var dup = results.filter(function (r) { return r.state === 'dup'; });
    var bad = results.filter(function (r) { return r.state === 'expired' || r.state === 'bad' || r.state === 'risk'; });
    var fail = results.filter(function (r) { return r.state === 'fail' || r.state === 'netfail'; });
    var summary = ok.length + '成 ' + dup.length + '重 ' + bad.length + '失效 ' + fail.length + '败';
    var lines = ['GLaDOS 签到', summary + ' / ' + results.length + ' 个账号'];
    results.forEach(function (r) {
      var mark = r.state === 'ok' ? '✅' : r.state === 'dup' ? '⏭' : r.state === 'expired' || r.state === 'bad' ? '🚫' : '❌';
      lines.push(mark + ' ' + r.acc.mask + ' ' + r.detail);
    });
    $persistentStore.write(
      JSON.stringify({ date: today, done: true, summary: summary, at: now.toISOString() }),
      stateKey
    );
    finish(lines);
  });
}

main();
