/**
 * GLaDOS 多账号签到 — Loon 插件脚本 (Script v2 统一语法 / Build 983+)
 *
 * 入口: cron 定时 + generic 手动面板, 双入口共用本脚本。
 * 账号来源(优先级): MITM 自动收集池(glados-cookie.js, 推荐主通道) > [Argument].cookies 手填兜底
 *
 * 手填 Cookie 池支持两种格式:
 *   1. & 分隔裸串: 账号1&账号2  (账号 = [domain@]完整Cookie串, 必含 (gld|koa):sess= 与 .sig=)
 *   2. JSON 数组(生态主流, 支持备注): [{"cookie":"...","ua":"...","domain":"...","name":"主号"},...]
 *
 * 可靠性: 失效/风控连续 3 次自动停号(NobyDa 式失败禁用), 重新登录刷新凭据后自动恢复。
 * 无需 MitM 于本脚本; MITM 仅由收集器使用。Cookie 全程只落本机。
 */

var DEFAULT_DOMAIN = 'glados.rocks';
var TOKEN = 'glados.one'; // 实测可用; 收集器按登录域名记录 domain
var DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// 风控: checkin 校验 UA 与登录设备一致性 (code:4 device-mismatch) — 收集器已按账号绑定 UA
var RETRY = 1; // 网络/5xx 自动补打一次
var ARG = {}; // main 赋值; maybeExchange 使用
var EXCHANGE_POINTS = { plan100: 100, plan200: 200, plan500: 500 }; // 兑换门槛(积分→天数)

// ---------- 参数解析 ----------

function parseArg(a) {
  if (a && typeof a === 'object') return a;
  if (typeof a === 'string' && a.trim().charAt(0) === '{') {
    try { return JSON.parse(a); } catch (e) { /* fallthrough */ }
  }
  return { cookies: typeof a === 'string' ? a : '' };
}

function makeAcc(cookie, domain, ua, name) {
  cookie = String(cookie || '').trim();
  var m = cookie.match(/(?:koa|gld):sess=([^;]+)/i);
  var id = m ? m[1].replace(/\s+/g, '').slice(0, 10) : '?';
  var label = String(name || '').trim();
  return {
    id: id,
    domain: (domain || DEFAULT_DOMAIN).toLowerCase(),
    cookie: cookie,
    ua: ua || '',
    name: label,
    mask: label || (id + '\u2026'),
    badFormat: !/(?:koa|gld):sess\s*=/i.test(cookie),
  };
}

function parseAccounts(s) {
  var out = [];
  // JSON 数组(生态主流): [{"cookie":"...","ua":"...","domain":"...","name":"备注"},...]
  if (String(s || '').trim().charAt(0) === '[') {
    try {
      JSON.parse(s).forEach(function (x) {
        if (x && x.cookie) out.push(makeAcc(x.cookie, x.domain, x.ua, x.name));
      });
      return out;
    } catch (e) { /* fallthrough to & 分隔 */ }
  }
  var out2 = [];
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
      out2.push(makeAcc(cookie, domain, '', ''));
    });
  return out2;
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
    var badge = leftDays != null ? ' \u5269' + leftDays + '\u5929' : '';

    if (acc.badFormat) return { acc: acc, state: 'bad', detail: 'cookie \u4e0d\u542b (koa|gld):sess' };

    return attempt(origin + '/api/user/checkin', 'POST', {
      contentType: 'application/json;charset=UTF-8',
      body: JSON.stringify({ token: TOKEN }),
    }).then(function (ck) {
      if (ck.status === 401 || ck.status === 403)
        return { acc: acc, state: 'expired', detail: 'HTTP ' + ck.status + badge };
      if (ck.status === 0) return { acc: acc, state: 'netfail', detail: ck.err || 'unknown' };
      if (ck.status !== 200) return { acc: acc, state: 'fail', detail: 'checkin HTTP ' + ck.status };

      var msg = dig(ck.data, 'message') || '';
      var code = dig(ck.data, 'code');
      var reason = String(dig(ck.data, 'reason') || '');
      var pts = dig(ck.data, 'points');
      var space = dig(ck.data, 'list', 'leftDays');
      if (space == null) space = leftDays;
      if (space != null) space = parseFloat(space);
      var tail = space != null ? ' (' + space + '\u5929)' : '';
      // \u5224\u5b9a\u77e9\u9635(2026-10-13 \u5b9e\u6d4b): \u7ed3\u6784\u5316 code \u4f18\u5148, \u6587\u6848\u4e0d\u53ef\u9760
      if (code === 0) return { acc: acc, state: 'ok', detail: '\u2726' + (pts != null ? pts + '\u5206 ' : '') + msg + tail };
      if (code === 1) return { acc: acc, state: 'dup', detail: msg + tail };
      if (code === 4 || reason === 'device-mismatch' || /automated/i.test(msg))
        return { acc: acc, state: 'risk', detail: 'UA \u4e0e\u767b\u5f55\u8bbe\u5907\u4e0d\u7b26 (\u6539\u81ea\u5b9a\u4e49 UA \u53c2\u6570): ' + (reason || msg) };
      if (code == null && /already/i.test(msg)) return { acc: acc, state: 'dup', detail: msg + tail };
      return { acc: acc, state: 'fail', detail: (code != null ? 'code' + code + ' ' : '') + (msg || 'HTTP ' + ck.status) };
    });
  });
}

function maybeExchange(r) {
  var plan = ARG.exchange;
  if (!plan || plan === 'off' || !EXCHANGE_POINTS[plan]) return Promise.resolve(r);
  if (r.state !== 'ok' && r.state !== 'dup') return Promise.resolve(r);
  var origin = 'https://' + r.acc.domain;
  var referer = origin + '/console/checkin';
  function req(method, path, body) {
    var headers = baseHeaders(r.acc.cookie, r.acc.ua || ARG.ua || '', body ? { 'Content-Type': 'application/json;charset=UTF-8' } : null);
    headers.Referer = referer; headers.Origin = origin;
    var o = { url: origin + path, method: method, headers: headers, timeout: 20 };
    if (body) o.body = JSON.stringify(body);
    return fetchJSON(o);
  }
  return req('GET', '/api/user/points').then(function (p) {
    if (p.status !== 200) { r.exchange = 'points HTTP ' + p.status; return r; }
    var balance = parseFloat(dig(p.data, 'points'));
    if (isNaN(balance)) { r.exchange = 'points \u5b57\u6bb5\u5f02\u5e38, \u76ee\u6807 ' + plan; return r; }
    r.points = balance;
    if (balance < EXCHANGE_POINTS[plan]) { r.exchange = plan + ' \u4f59\u989d ' + balance + '/' + EXCHANGE_POINTS[plan] + ' \u4e0d\u8db3, \u672a\u5151\u6362'; return r; }
    return req('POST', '/api/user/exchange', { planType: plan }).then(function (e) {
      var code = dig(e.data, 'code');
      var msg = dig(e.data, 'message') || '';
      r.exchange = (code === 0 ? '\u2713 ' : '\u2717 code' + code + ' ') + plan + ' ' + msg + ' (' + balance + ')';
      return r;
    });
  });
}

function getPoolAccounts() {
  var pool = [];
  try { pool = JSON.parse($persistentStore.read('glados_pool') || '[]') || []; } catch (e) { pool = []; }
  if (!Array.isArray(pool)) return [];
  return pool.filter(function (x) { return x && x.cookie; }).map(function (x) {
    var acc = makeAcc(x.cookie, x.domain, x.ua, x.name);
    acc.id = x.id || acc.id;
    return acc;
  });
}

// ---------- 主流程 ----------

function main() {
  var arg = parseArg($argument);
  ARG = arg;
  var force = arg.force === true || arg.force === 'true';
  var doNotify = !(arg.notify === false || arg.notify === 'false');
  var detailMode = !(arg.detail === false || arg.detail === 'false'); // \u8be6\u7ec6/\u7b80\u6613\u901a\u77e5
  var delaySec = Number(arg.delay);
  if (!isFinite(delaySec) || delaySec < 0) delaySec = 3;

  var poolAccs = getPoolAccounts();
  var manualAccs = parseAccounts(arg.cookies);
  var accounts = poolAccs.length ? poolAccs : manualAccs;

  // \u8fde\u7eed\u5931\u6548\u81ea\u52a8\u505c\u53f7(NobyDa \u5f0f\u5931\u8d25\u7981\u7528): \u514d\u6bcf\u65e5\u767d\u767d\u89e6\u98ce\u63a7; \u5237\u65b0\u51ed\u636e\u540e\u81ea\u52a8\u6062\u590d
  var FAILS_MAX = 3;
  var fails = {};
  try { fails = JSON.parse($persistentStore.read('glados_fails') || '{}') || {}; } catch (e) { fails = {}; }
  accounts.forEach(function (a) { a.disabled = !force && (fails[a.id] || 0) >= FAILS_MAX; });

  function finish(lines, skipped) {
    if (lines && lines.length && doNotify) {
      $notification.post(lines[0], lines[1] || '', lines.slice(2).join('\n'));
    }
    console.log(JSON.stringify(skipped || lines));
    $done();
  }

  if (!accounts.length) {
    return finish(['GLaDOS \u7b7e\u5230', '\u672a\u914d\u7f6e', '\u624b\u673a\u767b\u5f55\u4e00\u6b21 glados \u7f51\u9875 (MITM \u81ea\u52a8\u6536 Cookie), \u6216\u5728\u63d2\u4ef6\u53c2\u6570\u624b\u586b Cookie \u6c60']);
  }

  var now = new Date();
  var today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  var stateKey = 'glados_last_run';
  var prevState = null;
  try { prevState = JSON.parse($persistentStore.read(stateKey) || 'null'); } catch (e) { prevState = null; }

  if (prevState && prevState.date === today && prevState.done && !force) {
    return finish(
      ['GLaDOS \u7b7e\u5230', '\u4eca\u65e5\u5df2\u5b8c\u6210 (' + prevState.summary + ')', '\u53d6\u6d88\u52ff\u52a8, \u5982\u9700\u91cd\u7b7e\u5f00\u542f\u300c\u5ffd\u7565\u4eca\u65e5\u5df2\u7b7e\u8bb0\u5f55\u300d'],
      { skipped: true, date: today }
    );
  }

  var chain = Promise.resolve();
  var results = [];
  accounts.forEach(function (acc, i) {
    chain = chain
      .then(function () { if (i > 0 && !acc.disabled) return sleep(delaySec * 1000); })
      .then(function () {
        if (acc.disabled) {
          results.push({ acc: acc, state: 'paused', detail: '\u8fde\u7eed ' + FAILS_MAX + ' \u6b21\u5931\u6548\u5df2\u6682\u505c\u7b7e\u5230, \u91cd\u65b0\u767b\u5f55\u4e00\u6b21\u5373\u81ea\u52a8\u6062\u590d' });
          return null;
        }
        return runAccount(acc, acc.ua || arg.ua || '');
      })
      .then(function (r) {
        if (!r) return null;
        console.log('[' + acc.mask + '] ' + r.state + ' ' + r.detail);
        if (r.state === 'expired' || r.state === 'risk') fails[acc.id] = (fails[acc.id] || 0) + 1;
        else if (r.state === 'ok' || r.state === 'dup') fails[acc.id] = 0;
        results.push(r);
        return maybeExchange(r);
      });
  });

  chain.then(function () {
    var ok = results.filter(function (r) { return r.state === 'ok'; });
    var dup = results.filter(function (r) { return r.state === 'dup'; });
    var bad = results.filter(function (r) { return r.state === 'expired' || r.state === 'bad' || r.state === 'risk'; });
    var fail = results.filter(function (r) { return r.state === 'fail' || r.state === 'netfail'; });
    var pausedN = results.filter(function (r) { return r.state === 'paused'; }).length;
    var summary = ok.length + '\u6210 ' + dup.length + '\u91cd ' + bad.length + '\u5931\u6548 ' + fail.length + '\u8d25' + (pausedN ? ' ' + pausedN + '\u505c' : '');
    var lines = ['GLaDOS \u7b7e\u5230', summary + ' / ' + results.length + ' \u4e2a\u8d26\u53f7'];
    if (detailMode) {
      results.forEach(function (r) {
        var mark = r.state === 'ok' ? '\u2705' : r.state === 'dup' ? '\u23ed' : r.state === 'expired' || r.state === 'bad' ? '\ud83d\uded1' : r.state === 'paused' ? '\u23f8' : '\u274c';
        lines.push(mark + ' ' + r.acc.mask + ' ' + r.detail);
      });
    }
    results.forEach(function (r) {
      if (r.exchange) lines.push('[\u5151\u6362] ' + r.acc.mask + ' ' + r.exchange);
    });
    $persistentStore.write(JSON.stringify(fails), 'glados_fails');
    $persistentStore.write(
      JSON.stringify({ date: today, done: true, summary: summary, at: now.toISOString() }),
      stateKey
    );
    finish(lines);
  });
}

main();
