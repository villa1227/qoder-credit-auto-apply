# Qoder Credits 自动申请（北大办事大厅 app_id=575）

当 Qoder 的有效剩余 credits 低于阈值时，**自动**在北大办事大厅提交额度申请，无需人工干预。

- 检测方式：**被动** —— 只读 Qoder Desktop 自己写到本地的日志，不轮询接口、不产生任何 Agent 回合、**不消耗 credits**
- 提交方式：本地脚本驱动 **Edge over CDP**（零 npm 依赖），自动填「剩余\<NNN\>credits」并点击「立即提交」
- 默认阈值：有效剩余 ≤ **150 credits**

---

## 目录与文件

| 文件 | 作用 |
| --- | --- |
| `credit-watch.mjs` | L1 采集 + 状态机 + 派发：解析本地日志 → 算有效剩余 → 阈值判定 → 需要时拉起提交脚本 |
| `browser-driver.mjs` | 极简 CDP 客户端（Node 内置 `WebSocket` + `fetch`），负责拉起/连接 Edge、点击、填表 |
| `apply-pku.mjs` | L3 提交流程：打开事项页 → 点「立即申请」→ 处理草稿弹窗 → 填事由 → 提交 → 回读结果 |
| `config.json` | 阈值、轮询间隔、按钮文案、日志上限等全部配置 |
| `state.json` | 运行时状态机（`idle → triggered → dispatched → submitted \| failed`），**不入库** |
| `test-watcher.mjs` | 离线测试（19 项断言），不需要浏览器也不需要额度接口 |
| `register-tasks.ps1` | 注册/更新两个 Windows 计划任务 |
| `watch.cmd` / `check.cmd` | 手动兜底启动脚本 |
| `browser-profile/` | Edge 专用 profile（保存北大登录态），**含登录 cookie，绝不入库** |
| `artifacts/` | 提交前后的截图与页面结构 dump，**不入库** |
| `*.log`、`*.lock`、`watch.heartbeat` | 运行日志与运行时文件，**不入库** |

---

## 工作原理

```
Qoder Desktop 刷新额度接口
        │  （服务端把归一化额度 JSON 写进本地日志的「用量响应摘要」行）
        ▼
credit-watch.mjs --watch            每 60 秒读一次本地日志尾部
        │  计算有效剩余 = userQuota + orgResourcePackage(available)
        │                 + addOnQuota + Σ dedicatedResourcePackages
        ▼
≤ 150 ? ── 否 ──▶ idle（继续观察）
        │ 是
        ▼
triggered → dispatched ──▶ apply-pku.mjs（Edge/CDP 自动填表提交）→ submitted
```

**有效剩余不是单个额度包**：个人包经常已经耗尽而机构共享包还有余额，因此阈值必须按各池之和计算，否则个人包一归零就会误触发申请。

---

## 安装 / 启用

前置条件：Windows、Node.js（≥22，需支持内置 `WebSocket`）、Edge 或 Chrome。

1. **首次登录（只做一次，必须由本人完成）**
   用本目录的专用 profile 启动 Edge，手动完成北大统一身份认证，登录态会保存在 `browser-profile/`：

   ```cmd
   node -e "import('./browser-driver.mjs').then(m => m.launchBrowser({port:9333, profileDir:'browser-profile'}))"
   ```

   脚本本身**不接触任何账号、密码、验证码**；遇到验证码或短信验证会停下等你处理，不做绕过。

2. **注册计划任务**

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\register-tasks.ps1
   ```

   | 任务 | 触发 | 说明 |
   | --- | --- | --- |
   | `QoderCreditWatch` | 登录时（`-AtLogOn -User $env:USERNAME`） | 常驻监视器；异常退出后 1 分钟内重启，最多 3 次 |
   | `QoderCreditCheck` | 每 6 小时 | 兜底自愈：监视器心跳还新鲜就跳过，否则补一次检查 |

3. **验证**

   ```cmd
   node credit-watch.mjs --status       REM 当前状态机
   node credit-watch.mjs --once --dry-run REM 只报告不派发
   node test-watcher.mjs                 REM 离线测试
   ```

---

## 日常运维

```powershell
# 查看监视器是否在跑
Get-ScheduledTask -TaskName 'QoderCreditWatch','QoderCreditCheck' | Select-Object TaskName,State
Get-ScheduledTaskInfo  -TaskName 'QoderCreditWatch' | Select-Object LastRunTime,LastTaskResult

# 手动拉起 / 停止
Start-ScheduledTask -TaskName 'QoderCreditWatch'
Stop-ScheduledTask  -TaskName 'QoderCreditWatch'

# 只看不提交的演练
$env:REMAINING_CREDITS = 888
node apply-pku.mjs --dry-run
```

状态机各阶段的含义：

| stage | 含义 |
| --- | --- |
| `idle` | 额度充足，继续观察 |
| `triggered` | 已跌破阈值，等待派发 |
| `dispatched` | 提交脚本已启动 |
| `submitted` | 本额度周期已提交过，**不会重复申请** |
| `failed` | 提交失败，按重试规则 10 分钟后再试 |

`cycleKey` 取服务端 `expiresAt`：**额度周期一变，状态机自动复位**，新周期可以再申请一次。

---

## 配置（`config.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `threshold` | `150` | 触发阈值（有效剩余 credits） |
| `pollIntervalMs` | `60000` | 监视器轮询间隔 |
| `maxSnapshotAgeHours` | `6` | 快照超过这个小时数视为过期，不触发 |
| `maxLogBytes` | `1048576` | 单个日志文件上限（1 MB），超过后只保留尾部 |
| `keepLogBytes` | `262144` | 截断时保留的尾部大小（256 KB） |
| `artifactMaxBytes` | `20971520` | `artifacts/` 目录总大小上限（20 MB），超了删最旧的 |

日志/产物都有硬上限，长年运行不会把磁盘撑大：`watch.log` 约 110 KB/天，到 1 MB 就截断成 256 KB。

---

## 已知限制

- **应用目录必须是纯 ASCII 路径**。Windows 计划任务通过 `cmd.exe` 启动批处理时无法解析中文目录名，任务会**静默失败**（退出码 1；工作目录含中文则报 `0x8007010B`）。若要迁移目录，需同步修改 `register-tasks.ps1` 里的 `$base` 并重新注册。
- **门户改版**会导致定位失败：按钮/字段改名时脚本会把页面结构 dump 到 `artifacts/` 并标记 `failed`，不会乱点。
- **提交结果不确定**时仍按 `submitted` 处理（宁可少申请一次，也不重复申请），并在 `state.json` 备注里提示人工核实。
- Edge 窗口被关闭或机器重启都没关系：脚本每次都会重新拉起 Edge，登录态保存在专用 profile 里。

---

## 安全边界

- 全程不产生 Agent 回合、不调用额度接口，**不消耗任何 credits**
- 不接触任何凭据：密码、验证码、短信验证一律由本人在浏览器里完成
- 申请事由只写入额度数字（`剩余<NNN>credits`），不写入任何个人信息
