# qoder-credit-auto-apply —— Qoder credits 监控与自动申请

> **这是什么**：一个监控 **Qoder Desktop** 剩余 credits 的小工具。
> credits 掉到阈值以下时，它会自动去「办事大厅」这类门户提交一条额度申请。
>
> **给下载者的第一句话**：监控部分（`monitor/`）是通用的，下载即可用；
> **最后一步「在哪里申请、怎么申请」是需要你自己改的**（`apply/`）。
> 仓库里附的实现是**北京大学办事大厅**（`wsyy.pku.edu.cn`，app_id=575），
> 换学校/换门户请看 [`apply/README.md`](apply/README.md)。

- 检测方式：**被动** —— 只读 Qoder Desktop 自己写到本地的日志，不轮询接口、不产生任何 Agent 回合、**不消耗 credits**
- 触发条件：**只有 Qoder Desktop 打开时才会监测**，Qoder 没开就什么都不做
- 提交方式：本地脚本驱动 **Edge over CDP**（零 npm 依赖），自动填「剩余\<NNN\>credits」并点击「立即提交」
- 默认阈值：有效剩余 ≤ **150 credits**

### 下载者须知（三步）

1. **装依赖**：只要 Node.js ≥ 22，别的都不用装（零 npm 依赖）。
2. **改提交层**：打开 `config.json` 的 `application` / `browser` 两段，把门户 URL、按钮文案、
   事由输入框特征串换成你自己学校的；结构差太多就重写 `apply/apply-pku.mjs`
   （契约见 [`apply/README.md`](apply/README.md)）。**这一步不做的话，监控能跑，但提交会失败。**
3. **注册计划任务**：先手动登录一次你的门户（脚本会停在那儿等你），再执行
   `powershell -NoProfile -ExecutionPolicy Bypass -File .\register-tasks.ps1`。

`monitor/` 那一层（读日志、算额度、阈值判定、状态机、去重、派发）**不需要改**。

---

## 目录结构（两层）

```
credit-apply/
├── monitor/            ← 监控层：与学校无关，下载即可用
│   ├── credit-watch.mjs    读本地日志 → 算有效剩余 → 阈值判定 → 调用 apply 层
│   └── test-watcher.mjs    离线测试（28 项断言，不需要浏览器也不需要额度接口）
├── apply/              ← 提交层：**你要按自己门户改的部分**
│   ├── apply-pku.mjs       北大办事大厅实现（打开→申请→填事由→提交→回读）
│   ├── browser-driver.mjs  极简 CDP 客户端（通用，零 npm 依赖）
│   └── README.md           接口契约 + 换门户的改法
├── config.json         阈值、轮询间隔、按钮文案、日志上限、路径等全部配置
├── register-tasks.ps1  注册/更新两个 Windows 计划任务（路径自定位，可整目录搬迁）
├── migrate.ps1         搬迁助手：复制到新目录并重新注册任务，一条命令搞定
├── watch.cmd / check.cmd  手动兜底启动脚本
├── browser-profile/    Edge 专用 profile（保存登录态），**含 cookie，绝不入库**
├── artifacts/          提交前后的截图与页面结构 dump，**不入库**
└── state.json / *.log / *.lock  运行状态与日志，**不入库**
```

两层之间只有两个接口，耦合极低：

```
monitor/credit-watch.mjs
   │  有效剩余 ≤ 阈值
   │  spawn: node apply/apply-pku.mjs     (环境变量 REMAINING_CREDITS=<数字>)
   ▼
apply/apply-pku.mjs
   │  提交成功 / 失败
   │  spawn: node monitor/credit-watch.mjs --mark submitted|failed
   ▼
monitor/credit-watch.mjs  更新状态机
```

---

## 工作原理

```
Qoder Desktop 刷新额度接口（仅在 Qoder 运行时）
        │  （服务端把归一化额度 JSON 写进本地日志的「用量响应摘要」行）
        ▼
计划任务每 2 分钟跑一次 --tick
        │  ① 先看 Qoder 进程在不在
        │     不在 → 直接退出，什么都不做（开机不启动、Qoder 没开不工作）
        ▼  ② 在 → 解析日志尾部
        │  有效剩余 = userQuota + orgResourcePackage(available)
        │            + addOnQuota + Σ dedicatedResourcePackages
        ▼
≤ 150 ? ── 否 ──▶ idle（继续观察）
        │ 是
        ▼
triggered → dispatched ──▶ apply/apply-pku.mjs（Edge/CDP 自动填表提交）→ submitted
```

**有效剩余不是单个额度包**：个人包经常已经耗尽而机构共享包还有余额，因此阈值必须按各池之和计算，否则个人包一归零就会误触发申请。

---

## 安装 / 启用

前置条件：Windows、Node.js（≥22，需支持内置 `WebSocket`）、Edge 或 Chrome。

1. **首次登录（只做一次，必须由本人完成）**
   用本目录的专用 profile 启动 Edge，手动完成门户的统一身份认证，登录态会保存在 `browser-profile/`：

   ```cmd
   node -e "import('./apply/browser-driver.mjs').then(m => m.launchBrowser({port:9333, profileDir:'browser-profile'}))"
   ```

   脚本本身**不接触任何账号、密码、验证码**；遇到验证码或短信验证会停下等你处理，不做绕过。

2. **注册计划任务**

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\register-tasks.ps1
   ```

   | 任务 | 触发 | 说明 |
   | --- | --- | --- |
   | `QoderCreditWatch` | 每 2 分钟 | 调度 tick：Qoder 在跑才监测，不跑就退出 |
   | `QoderCreditCheck` | 每 6 小时 | 兜底自愈：心跳还新鲜就跳过，否则补一次检查 |

3. **验证**

   ```cmd
   node monitor/credit-watch.mjs --status       REM 当前状态机
   node monitor/credit-watch.mjs --tick         REM 跑一次调度 tick（不提交）
   node monitor/credit-watch.mjs --once --dry-run REM 只报告不派发
   node monitor/test-watcher.mjs                 REM 离线测试（28 项）
   ```

---

## 日常运维

```powershell
# 查看任务状态
Get-ScheduledTask -TaskName 'QoderCreditWatch','QoderCreditCheck' | Select-Object TaskName,State
Get-ScheduledTaskInfo  -TaskName 'QoderCreditWatch' | Select-Object LastRunTime,LastTaskResult

# 手动拉起 / 停止
Start-ScheduledTask -TaskName 'QoderCreditWatch'
Stop-ScheduledTask  -TaskName 'QoderCreditWatch'

# 只看不提交的演练
$env:REMAINING_CREDITS = 888
node apply/apply-pku.mjs --dry-run
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
| `pollIntervalMs` | `60000` | 常驻模式下的轮询间隔 |
| `heartbeatAliveMs` | `300000` | 心跳保鲜期，超过则认为调度任务挂了 |
| `maxSnapshotAgeHours` | `6` | 快照超过这个小时数视为过期，不触发 |
| `maxLogBytes` | `1048576` | 单个日志文件上限（1 MB），超过后只保留尾部 |
| `keepLogBytes` | `262144` | 截断时保留的尾部大小（256 KB） |
| `artifactMaxBytes` | `20971520` | `artifacts/` 目录总大小上限（20 MB），超了删最旧的 |
| `paths.applyScript` | `apply/apply-pku.mjs` | 提交层入口，换成你自己的脚本 |
| `paths.monitorScript` | `monitor/credit-watch.mjs` | 监控层入口（供提交层回报状态） |
| `guard.processNames` | `["Qoder CN.exe","Qoder.exe"]` | 判定「Qoder 已打开」的进程名 |
| `browser.*` | — | 提交层用：端口、profile、按钮文案、事由模板 |
| `application.*` | — | 提交层用：门户 URL 与页面特征串 |

日志/产物都有硬上限，长年运行不会把磁盘撑大：`watch.log` 约 110 KB/天，到 1 MB 就截断成 256 KB。

---

## 已知限制

- **只在 Qoder Desktop 打开时监测**。Qoder 不写 Windows 事件日志，而 WMI 事件订阅需要管理员权限，
  所以用「每 2 分钟一次的调度 tick + 进程检测」实现：Qoder 关着时 tick 立刻退出，
  机器上不留常驻进程，也不会有常驻控制台窗口。
  tick 间隔在 `register-tasks.ps1` 里的 `$tickMinutes` 调整。

- **应用目录可以是任意路径，含中文也没问题**（实测：计划任务直接调用 node 时中文脚本路径正常，`conhost --headless` 同样正常）。搬迁用一条命令：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\migrate.ps1 -Target 'D:\apps\credit-apply'
  ```

  它会停任务 → 复制目录（`browser-profile/` 连同登录态一起带走，不用重新登录）→ 在新位置重新注册任务 → 启动监视器并打印验证结果。**旧目录不会自动删除**，确认新位置正常后自己删。

  也可以手动搬：把整个文件夹移到新位置，在新位置运行 `register-tasks.ps1` 即可（脚本所有路径都从自身位置推导，不含硬编码路径）。

  历史上踩过的坑与现在的规避方式：

  | 坑 | 现象 | 现在的做法 |
  | --- | --- | --- |
  | `.cmd` 作为任务动作 | 含中文目录时 `cmd.exe /c` 静默失败，退出码 1 | 任务动作直接调 `node.exe`，不用批处理包装 |
  | WorkingDirectory 含中文 | 报 `0x8007010B`（目录无效） | 固定用 `$env:USERPROFILE`，脚本路径全部自解析 |
  | `Register-ScheduledTask -Force` 覆盖已有任务 | 报 `0x80070005`（拒绝访问） | 先 `Unregister-ScheduledTask` 再注册 |
  | `Stop-ScheduledTask` 杀不掉孙进程 | node 变成孤儿进程，继续写旧目录 | 注册/搬迁时按命令行特征显式清理 node 进程 |

- **控制台窗口不会弹出**。计划任务用 `conhost.exe --headless` 启动 —— 子进程照常运行，但**不分配可见窗口**。

  > 提交额度时弹出的 **Edge 窗口是故意的**：那是真实提交过程，留着你能亲眼看到填了什么、点了什么。

- **门户改版**会导致定位失败：按钮/字段改名时脚本会把页面结构 dump 到 `artifacts/` 并标记 `failed`，不会乱点。
- **提交结果不确定**时仍按 `submitted` 处理（宁可少申请一次，也不重复申请），并在 `state.json` 备注里提示人工核实。
- Edge 窗口被关闭或机器重启都没关系：脚本每次都会重新拉起 Edge，登录态保存在专用 profile 里。

---

## 安全边界

- 全程不产生 Agent 回合、不调用额度接口，**不消耗任何 credits**
- 不接触任何凭据：密码、验证码、短信验证一律由本人在浏览器里完成
- 申请事由只写入额度数字（`剩余<NNN>credits`），不写入任何个人信息
- `browser-profile/`（含登录 cookie）与 `artifacts/`（含姓名/学工号）**不入库**
