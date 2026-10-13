/**
 * glados.plugin 离线校验
 * L1a: 官方 loon-legacy-converter 跑插件全文 — [Script] v2 行必须被官方解析为 "unchanged"(已是新语法) 且 0 error
 * L1b: script_v2 静态规则 — script() 的 ${var} ⊆ [Argument]、cron 段数、with 键白名单、https
 * 用法: node tools/validate.mjs [插件路径] (默认 ../glados.plugin)
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const converter = require('./vendor/loon-legacy-converter.js');
const { convertConfiguration } = await import('./vendor/legacyConverterAdapter.mjs').catch(() => ({ convertConfiguration: null }));

const file = process.argv[2] || new URL('../glados.plugin', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const src = fs.readFileSync(file, 'utf8');
let fails = 0;
const check = (pass, label, extra) => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}` + (pass || !extra ? '' : ` → ${extra}`));
  if (!pass) fails++;
};

// ---- 官方转换器判定 ----
const argumentTypes = converter.argumentTypes(src);
console.log('官方 argumentTypes() 识别 [Argument] →', JSON.stringify(argumentTypes));
for (const [name, ty] of Object.entries(argumentTypes)) {
  check(ty != null, `[Argument] ${name} 类型可解析 (${ty})`);
}
['cookies', 'notify', 'delay', 'force'].forEach((n) => check(n in argumentTypes, `[Argument] 声明了 ${n}`));

const conv = convertConfiguration(src, 'script', { includeSection: false });
console.log('官方 convertConfiguration(script) →', JSON.stringify(conv.stats), '| issues:', conv.issues.length);
check(conv.stats.failed === 0, 'L1a 官方解析失败行 = 0', JSON.stringify(conv.issues));
check(conv.issues.length === 0, 'L1a 官方 issues = 0', JSON.stringify(conv.issues));
check(conv.stats.converted === 0, 'L1a 无需转换的旧行 = 0 (本插件已是 v2)');

// ---- 静态规则 ----
const argBlock = src.match(/\[Argument\]([\s\S]*?)(\n\[|$)/)?.[1] || '';
const declared = [...argBlock.matchAll(/^\s*([A-Za-z_][\w]*)\s*=/gm)].map((m) => m[1]);
const scriptBlock = src.match(/\[Script\]([\s\S]*)$/)?.[1] || '';
const lines = scriptBlock.split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
check(lines.length === 2, 'L1b [Script] 恰好 2 行 (cron+generic)', `got ${lines.length}`);
const WITH_KEYS = new Set(['tag', 'timeout', 'requires_body', 'binary_body_mode', 'enable', 'img_url']);
let triggerOK = true;
lines.forEach((line, i) => {
  const vars = [...line.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
  const unknown = vars.filter((v) => !declared.includes(v));
  check(unknown.length === 0, `L1b 第${i + 1}行 引用的插件参数全部已声明`, JSON.stringify(unknown));
  const m = line.match(/^\s*(cron|generic|request|response|network-changed)\b/);
  check(m != null, `L1b 第${i + 1}行 有合法 Trigger`);
  if (m && m[1] === 'cron') {
    const c = line.match(/cron "([^"]+)"/);
    const seg = c ? c[1].trim().split(/\s+/).length : 0;
    check(seg === 5 || seg === 6, `L1b cron 表达式为 5/6 段`, `got ${seg}`);
    triggerOK = triggerOK && seg >= 5;
  }
  const withPart = line.split(/\swith\s+/)[1] || '';
  const keys = [...withPart.matchAll(/(\w+)\s*=/g)].map((x) => x[1]);
  const illegal = keys.filter((k) => !WITH_KEYS.has(k));
  check(illegal.length === 0, `L1b 第${i + 1}行 with 键合法`, JSON.stringify(illegal));
  const url = line.match(/script\("([^"]+)"/)?.[1];
  check(!!url && url.startsWith('https://'), `L1b 第${i + 1}行 唯一脚本路径且为 https`, url);
  const objs = [...line.matchAll(/\{\s*\$\{/g)].length;
  check(objs <= 1, `L1b 第${i + 1}行 对象参数至多一个`, `got ${objs}`);
});
const genericLine = lines.find((l) => /^\s*generic\b/.test(l));
check(!!genericLine && /img_url/.test(genericLine), 'L1b 手动入口带 img_url (App 面板图标)');
const cronLine = lines.find((l) => /^\s*cron\b/.test(l));
check(!!cronLine && /timeout=\d+/.test(cronLine), 'L1b cron 带 timeout');
check(/#!loon_version\s*=\s*3\.5\.1\(9[0-9]{2}\)|#!loon_version\s*=\s*3\.5\.2/.test(src), 'L1b 元数据声明 ≥983 (Script v2 要求)');

console.log(fails ? `\n✗ ${fails} 项未过` : '\n✓ 插件校验全部通过 (官方解析器 + v2 静态规则)');
process.exitCode = fails ? 1 : 0;
