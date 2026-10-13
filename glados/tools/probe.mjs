// GLaDOS checkin 风控侦察: 变体矩阵定位 "Automated check-in detected" 触发条件
import fs from 'node:fs';
const cookie = fs.readFileSync(new URL('../acc.txt', import.meta.url), 'utf8').trim();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function headers(domain) {
  return {
    'User-Agent': UA,
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: `https://${domain}/console/checkin`,
    Origin: `https://${domain}`,
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}

async function get(url, domain) {
  const r = await fetch(url, { headers: headers(domain) });
  const t = await r.text();
  return { status: r.status, body: t };
}

async function checkin(domain, token, cookieOverride) {
  const h = headers(domain);
  if (cookieOverride) h.Cookie = cookieOverride;
  h['Content-Type'] = 'application/json;charset=UTF-8';
  const t0 = Date.now();
  const r = await fetch(`https://${domain}/api/user/checkin`, {
    method: 'POST', headers: h, body: JSON.stringify({ token }),
  });
  const t = await r.text();
  return { status: r.status, ms: Date.now() - t0, body: t.slice(0, 220) };
}

// V0: 先 GET console 页面 (热域/可能的导航指纹), 检查页面特征
const v0 = await get('https://glados.rocks/console/checkin', 'glados.rocks');
console.log('V0 GET /console/checkin →', v0.status, '| len:', v0.body.length, '| has-turnstile:', /turnstile|cf-chl|challenge/i.test(v0.body), '| has-script-token:', /csfr|_token|xsrf/i.test(v0.body));

// V1: rocks + token=glados.one (基准)
console.log('V1 rocks token=glados.one →', JSON.stringify(await checkin('glados.rocks', 'glados.one')));
await new Promise((r) => setTimeout(r, 4000));

// V2: space (用户注册站) + token=glados.space
console.log('V2 space token=glados.space →', JSON.stringify(await checkin('glados.space', 'glados.space')));
await new Promise((r) => setTimeout(r, 4000));

// V3: network + token=glados.network
console.log('V3 network token=glados.network →', JSON.stringify(await checkin('glados.network', 'glados.network')));
