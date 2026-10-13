/**
 * Loon Script API harness — 在 Node 里跑 glados.js 的无头验证层
 * 用法:
 *   node harness.mjs --mock                       # 全场景模拟(零网络)
 *   node harness.mjs --live-status <file>         # 只打 /api/user/status 验 cookie (不真签到, checkin 被 DRY-RUN 拦截)
 *   node harness.mjs --live <file>                # 完整链路 (checkin 幂等; 已签返回 code:1)
 * file = Cookie 池文本, 每行一个账号 (格式同插件参数, 不入 git)
 */
import fs from 'node:fs';

const SCRIPT = fs.readFileSync(new URL('./glados.js', import.meta.url), 'utf8');
const eq = (a, b, label, bag) => {
  const pass = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}` + (pass ? '' : ` -> got ${JSON.stringify(a)} want ${JSON.stringify(b)}`));
  if (!pass) bag.push(label);
};

function makeRuntime({ notes, store, fetchFn }) {
  let resolveDone;
  const donePromise = new Promise((r) => (resolveDone = r));
  const rt = {
    $argument: {},
    $done: () => resolveDone('done'),
    console: { log: (...a) => console.log('    | console:', ...a) },
    $persistentStore: {
      read: (k) => store.get(k) ?? null,
      write: (v, k) => { store.set(k, String(v)); return true; },
    },
    $notification: { post: (t, s, b) => notes.push({ t, s, b }) },
    $task: { fetch: (req) => fetchFn(req) },
    setTimeout,
  };
  return { rt, donePromise };
}

async function runScript(rt) {
  const fn = new Function('$argument', '$task', '$persistentStore', '$notification', '$done', 'console', SCRIPT);
  return fn(rt.$argument, rt.$task, rt.$persistentStore, rt.$notification, rt.$done, rt.console);
}

const resp = (status, body) => ({ statusCode: status, body: typeof body === 'string' ? body : JSON.stringify(body) });

// ---- T1: 未配置 cookie ----
async function t1_noCookie() {
  console.log('T1 未配置 cookie -> 提示通知, 不发请求');
  const bag = [], notes = [], store = new Map(); let fetches = 0;
  const { rt, donePromise } = makeRuntime({
    notes, store,
    fetchFn: () => { fetches++; return Promise.resolve(resp(401, {})); },
  });
  rt.$argument = { cookies: '', notify: true, delay: 0 };
  runScript(rt); await donePromise;
  eq(fetches, 0, 'T1 不发任何请求', bag);
  eq(notes.length, 1, 'T1 通知 1 条', bag);
  eq(notes[0]?.t, 'GLaDOS 签到', 'T1 通知标题', bag);
  eq(notes[0]?.s, '\u672a\u914d\u7f6e', 'T1 副标题=未配置', bag);
  return bag;
}

// ---- T2: 3 账号混合 (code0 成功 / code1 已签 / 401 失效) ----
async function t2_mixed() {
  console.log('T2 3 账号 (成功/已签/失效) -> 分类正确 + 间隔 + 落库');
  const bag = [], notes = [], store = new Map(); const fetchLog = [];
  const { rt, donePromise } = makeRuntime({
    notes, store,
    fetchFn: (req) => {
      fetchLog.push({ url: req.url, method: req.method, body: req.body, t: Date.now() });
      if (req.url.includes('/status')) {
        if (req.headers.Cookie.includes('GOOD')) return Promise.resolve(resp(200, { code: 0, data: { leftDays: '12.0', traffic: 1 } }));
        if (req.headers.Cookie.includes('DUP')) return Promise.resolve(resp(200, { code: 0, data: { leftDays: '3.0' } }));
        return Promise.resolve(resp(401, { message: 'unauthorized' }));
      }
      if (req.headers.Cookie.includes('GOOD')) return Promise.resolve(resp(200, { code: 0, points: 8, message: 'Checkin! Got 8 Points', streak: 4, list: [] }));
      return Promise.resolve(resp(200, { code: 1, points: 0, message: "Today's observation logged. Return tomorrow for more points.", list: [] }));
    },
  });
  rt.$argument = { cookies: 'koa:sess=GOODAAA; koa:sess.sig=s1&glados.network@koa:sess=DUPBBB; koa:sess.sig=s2&koa:sess=DEADCCC; koa:sess.sig=s3', notify: true, delay: 1 };
  runScript(rt); await donePromise;
  const checkins = fetchLog.filter((f) => f.url.includes('/checkin'));
  eq(fetchLog.length, 5, 'T2 共 5 次请求 (3 status + 2 checkin, 失效截停)', bag);
  eq(checkins.length, 2, 'T2 有效账号各 1 次 checkin', bag);
  eq(checkins[0].body, JSON.stringify({ token: 'glados.one' }), 'T2 checkin body token', bag);
  const gt = checkins.map((f) => f.t);
  eq(gt[1] - gt[0] >= 900, true, 'T2 账号间隔 >=1s 生效', bag);
  const note = notes[0];
  eq(note.t, 'GLaDOS 签到', 'T2 通知标题', bag);
  eq(note.s, '1\u6210 1\u91cd 1\u5931\u6548 0\u8d25 / 3 \u4e2a\u8d26\u53f7', 'T2 汇总副标题', bag);
  eq((note.b.match(/\u2705/g) || []).length, 1, 'T2 check 成功 x1', bag);
  eq((note.b.match(/\u23ed/g) || []).length, 1, 'T2 已签 x1', bag);
  eq((notes[0]?.b || '').includes('HTTP 401'), true, 'T2 失效 detail (HTTP 401)', bag);
  const st = JSON.parse(store.get('glados_last_run'));
  eq(st.done, true, 'T2 落库 done', bag);
  eq(st.summary, '1\u6210 1\u91cd 1\u5931\u6548 0\u8d25', 'T2 落库 summary', bag);
  return bag;
}

// ---- T3: 同日二次运行短路 ----
async function t3_skipSameDay() {
  console.log('T3 同日二次运行 -> 短路不发请求');
  const bag = [], notes = [], store = new Map(); let fetches = 0;
  const { rt, donePromise } = makeRuntime({
    notes, store,
    fetchFn: () => { fetches++; return Promise.resolve(resp(200, { code: 0 })); },
  });
  store.set('glados_last_run', JSON.stringify({ date: new Date().toISOString().slice(0, 10), done: true, summary: '2\u6210 0\u91cd 0\u5931\u6548 0\u8d25' }));
  rt.$argument = { cookies: 'koa:sess=A; koa:sess.sig=x&koa:sess=B; koa:sess.sig=y', notify: true, delay: 0 };
  runScript(rt); await donePromise;
  eq(fetches, 0, 'T3 不发请求', bag);
  eq(notes[0]?.s, '\u4eca\u65e5\u5df2\u5b8c\u6210 (2\u6210 0\u91cd 0\u5931\u6548 0\u8d25)', 'T3 完成通知', bag);
  return bag;
}

// ---- T4: force 重跑 ----
async function t4_force() {
  console.log('T4 force=true 同日重跑 -> 正常请求');
  const bag = [], notes = [], store = new Map(); let fetches = 0;
  const { rt, donePromise } = makeRuntime({
    notes, store,
    fetchFn: () => { fetches++; return Promise.resolve(resp(200, { code: 1, points: 0, message: "Today's observation logged", list: [], data: { leftDays: '1.0' } })); },
  });
  store.set('glados_last_run', JSON.stringify({ date: new Date().toISOString().slice(0, 10), done: true, summary: 'x' }));
  rt.$argument = { cookies: 'koa:sess=A; koa:sess.sig=x', notify: false, delay: 0, force: true };
  runScript(rt); await donePromise;
  eq(fetches >= 2, true, 'T4 真实发起请求', bag);
  eq(notes.length, 0, 'T4 notify=false 无通知', bag);
  return bag;
}

// ---- T5: 坏格式 cookie ----
async function t5_badFormat() {
  console.log('T5 cookie 缺 (koa|gld):sess -> 标记 bad, 不发 checkin');
  const bag = [], notes = [], store = new Map(); const urls = [];
  const { rt, donePromise } = makeRuntime({
    notes, store,
    fetchFn: (req) => { urls.push(req.url); return Promise.resolve(resp(200, { code: 0, data: {} })); },
  });
  rt.$argument = { cookies: 'justonebigtokenvalue123456', notify: true, delay: 0 };
  runScript(rt); await donePromise;
  eq(urls.filter((u) => u.includes('/checkin')).length, 0, 'T5 不发 checkin', bag);
  eq((notes[0]?.s || '').includes('\u5931\u6548'), true, 'T5 归入失效', bag);
  return bag;
}

// ---- T6: 真值判定矩阵 (2026-10-13 实测响应结构) ----
async function t6_realMatrix() {
  console.log('T6 真值判定矩阵 (code 0/1/4 + 401)');
  const bag = [], notes = [], store = new Map();
  const { rt, donePromise } = makeRuntime({
    notes, store,
    fetchFn: (req) => {
      if (req.url.includes('/status')) return Promise.resolve(resp(200, { code: 0, data: { leftDays: '8.0000000000000000', traffic: 4573683693 } }));
      const c = req.headers.Cookie;
      if (c.includes('OK')) return Promise.resolve(resp(200, { code: 0, points: 7, message: 'Checkin! Got 7 Points', streak: 1, list: [] }));
      if (c.includes('DUP')) return Promise.resolve(resp(200, { code: 1, points: 0, message: "Today's observation logged. Return tomorrow for more points.", streak: 1, list: [] }));
      if (c.includes('RISK')) return Promise.resolve(resp(200, { code: 4, reason: 'device-mismatch', message: 'Automated check-in detected. Please sign in again to continue.', list: [] }));
      return Promise.resolve(resp(401, { message: 'unauthorized' }));
    },
  });
  rt.$argument = { cookies: 'koa:sess=OK; koa:sess.sig=a&koa:sess=DUP; koa:sess.sig=b&koa:sess=RISK; koa:sess.sig=c&koa:sess=DEAD; koa:sess.sig=d', notify: true, delay: 0 };
  runScript(rt); await donePromise;
  const b = notes[0]?.b || '';
  eq(b.includes('Checkin! Got 7 Points'), true, 'T6 code0 成功文案', bag);
  eq(b.includes("Today's observation logged"), true, 'T6 code1 已签文案', bag);
  eq(b.includes('device-mismatch'), true, 'T6 code4 风控 reason', bag);
  eq(b.includes('UA'), true, 'T6 风控 detail 带 UA 提示', bag);
  eq(b.includes('HTTP 401'), true, 'T6 401 失效', bag);
  eq(b.includes('7\u5206'), true, 'T6 积分展示 points=7', bag);
  const st = JSON.parse(store.get('glados_last_run'));
  eq(st.summary, '1\u6210 1\u91cd 2\u5931\u6548 0\u8d25', 'T6 汇总', bag);
  return bag;
}

// ---- live ----
async function live(file, statusOnly) {
  const raw = fs.readFileSync(file, 'utf8');
  const store = new Map();
  const { rt, donePromise } = makeRuntime({
    notes: [], store,
    fetchFn: (req) => fetch(req.url, { method: req.method, headers: req.headers, body: req.body })
      .then(async (r) => ({ statusCode: r.status, body: await r.text() }))
      .catch((e) => Promise.resolve({ statusCode: 0, body: 'ERR ' + e.message })),
  });
  const realFetch = rt.$task.fetch;
  rt.$task.fetch = (req) => {
    if (statusOnly && req.url.includes('/checkin')) {
      console.log('    | [DRY-RUN] 拦截 checkin:', req.url);
      return Promise.resolve({ statusCode: 200, body: JSON.stringify({ code: 1, message: '[DRY-RUN] You already checked in today', list: [] }) });
    }
    return realFetch(req);
  };
  rt.$argument = { cookies: raw, notify: true, delay: 3, force: true };
  console.log(statusOnly ? '== LIVE-STATUS (cookie 活性验证, 不真签到) ==' : '== LIVE (完整链路, checkin 幂等) ==');
  runScript(rt); await donePromise;
}

// ---- main ----
const mode = process.argv[2];
if (mode === '--live' || mode === '--live-status') {
  await live(process.argv[3], mode === '--live-status');
} else {
  const results = [];
  for (const t of [t1_noCookie, t2_mixed, t3_skipSameDay, t4_force, t5_badFormat, t6_realMatrix]) {
    results.push({ t: t.name, fails: await t() });
  }
  const allFail = results.flatMap((r) => r.fails);
  console.log(allFail.length ? `\n[FAIL] ${allFail.length} 个断言失败:\n - ${allFail.join('\n - ')}` : '\n[OK] 全部断言通过');
  process.exitCode = allFail.length ? 1 : 0;
}
