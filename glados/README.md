# GLaDOS 签到 (Loon 多账号 · 自动收集 Cookie)

分 MINI 双脚本范式: **`glados-cookie.js` 收集器**（MITM 劫持登录请求, 抓 Cookie+UA 自动建账号池）+ **`glados.js` 签到**（cron 定时 + generic 手动）。免手动复制 Cookie; Cookie 只存本机 Loon 键值存储, 不上报。

## 安装（3 步）

1. 装**插件**:
   ```
   https://raw.githubusercontent.com/noxenys/loon/main/glados/glados.plugin
   ```
   插件自带 `[Mitm] hostname` 7 个 GLaDOS 域名（自动合并进主配置）。
2. **Loon 里装并完全信任 MITM 证书**（设置→MITM→证书; 若已装过可跳过）
3. **手机浏览器登录一次任意 GLaDOS 主站**（Safari 打开 `glados.rocks` 登录即可）:
   - 打开后任意 `/api/user/*` 请求触发收集器 → 通知 "GLaDOS Cookie 已入库 第 N 个账号"
   - **多账号** = 不同域名/不同浏览器各登录一次（自动去重, 上限 20）
   - 之后每天 cron 07:30 / 21:30 自动签到, 面板可手动跑

## 运行机制（实测 2026-10-13, 设备 3.5.2(1005)）

| 事实 | 值 |
| --- | --- |
| Cookie 键名 | **`gld:sess=` + `gld:sess.sig=`**（旧生态 `koa:sess` 已过期, 双键兼容）|
| 判定矩阵 | `code:0`=成功(message 形如 "Checkin! Got N Points") · `code:1`=今日已签 · `code:4`+`reason:"device-mismatch"`=**UA 与登录设备不符** · HTTP 401/403=失效 |
| 风控 | checkin 校验 **UA 平台与登录设备一致性** → 收集器同时抓 UA, 池内每账号绑定自己的 UA（手机登录·手机签到天然一致, 这是手填 cookie 方案做不到的）|
| 字段路径 | `data.leftDays`(字符串数字)/`data.traffic`(字节) **实际平铺无 list 包装** |
| 域名 | 7 个: rocks/network/one/space/cloud/vip/facility.com; **rocks 直连最稳**（nginx 直出）; token 统一 `glados.one` 实测可用 |
| 当日防重 | `$persistentStore` 记当天汇总, 二次运行短路; `force` 开关强制补签 |

## 本机无头验证（改任何东西后, 不用碰手机）

```bash
node harness.mjs --mock          # 8 场景(收集器+池优先+判定矩阵...) 全部断言, 零网络
node tools/validate.mjs          # 官方解析器 + Script v2 静态规则(3 行脚本/MitM/参数引用)
node harness.mjs --live acc.txt  # 真接口(账号池文本, 每行一个, 已 gitignore)
```

## 文件

- `glados.js` — 签到脚本（池优先, 手填兼容兜底）
- `glados-cookie.js` — MITM 收集器（request 劫持, 去重建池）
- `glados.plugin` — 插件（[Argument] 类型化 + 3 行 [Script] v2 + [MitM] 7 域名）
- `harness.mjs` — Loon Script API 无头测试台（mock/live 双模式）
- `tools/validate.mjs` + `tools/vendor/` — 官方转换器源码快照 (2026-10-10)
- `tools/probe.mjs` — 风控侦察脚本（device-mismatch 发现行）

## 红线

- `acc*.txt` 永不进 git（.gitignore 排除）
- 收集器/签到脚本**无任何上报逻辑**, Cookie 只落本机
- 若通知出现 "UA 与登录设备不符": 该账号在别的设备登录的 → 编辑插件参数「自定义 UA」为登录时设备 UA, 或重开收集
