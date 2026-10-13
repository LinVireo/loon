# GLaDOS 签到 (Loon 多账号)

cron 定时 + generic 手动双入口; 纯 `$task.fetch` 轮询, **无需 MitM**。跑在 Script v2 (Loon 3.5.1(983)+, 目标设备 3.5.2(1005))。

## 安装

```
https://raw.githubusercontent.com/noxenys/loon/main/glados/glados.plugin
```

1. Loon → 插件 → 添加 → 填上面 URL
2. 编辑 `[Argument]`:
   - **Cookie 池** (`&` 分隔多账号): 浏览器登录 glados.rocks → F12 → Application → Cookies → 复制**完整 Cookie 串**(必须含 `gld:sess=`/`koa:sess=` 及对应 `.sig=`; 2026-10 实测键名为 `gld:sess`)
   - 多账号格式: `cookie1&cookie2`, 或给某号指定域名 `glados.network@cookie3`
   - 通知/间隔(秒)/强制重跑 开关
3. 手动: Loon 首页面板 "GLaDOS 手动签到"

## 验证(改完脚本/配置后, 不用碰 Loon)

```bash
node harness.mjs --mock            # 5 场景 20 断言 (逻辑层, 零网络)
node tools/validate.mjs            # 官方解析器校验插件语法 (v2 静态规则)
# 真接口 (可选; cookie 文件不进 git):
node harness.mjs --live-status acc.txt   # 只验 cookie 活性, 不真正签到
node harness.mjs --live acc.txt          # 完整链路 (checkin 幂等, 已签=“已签到”)
acc.txt 每行一个账号, 同 Cookie 池格式。
```

## 真机 30 秒清单

导入后: ①插件页无红字/参数表单出现 4 项 → ②填 Cookie 池 → ③首页面板手动跑 → ④出 "GLaDOS 签到 / N成M重…" 通知 → ⑤插件日志看到逐账号 `[mask] state detail` 即全通。

## 文件

- `glados.js` — 主脚本 (无 Loon 外依赖)
- `glados.plugin` — 插件声明 ([Argument] 类型化 + 2 行 [Script] v2)
- `harness.mjs` — Loon Script API 的 Node 无头测试台 (mock/live)
- `tools/validate.mjs` — 官方 loon-legacy-converter 打底 + script_v2 静态规则
- `tools/vendor/` — 上游 nsloon.app 转换器源码快照 (2026-10-10)
