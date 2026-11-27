# apply/ —— 提交层（唯一与具体门户相关的部分）

这一层负责**把额度申请真正提交出去**：打开浏览器、登录、填表、点提交。
监控层（`monitor/`）完全不包含任何学校、门户、按钮文案相关的逻辑，
它只做一件事：算有效剩余 credits，低于阈值时调用这一层。

**如果你不是北大的用户，或者你的学校用的是另一套办事大厅，
需要改的就是这个目录。** 监控层可以原样使用。

## 目录内容

| 文件 | 作用 |
| --- | --- |
| `apply-pku.mjs` | 北大办事大厅（`wsyy.pku.edu.cn`）的实现：打开事项页 → 点「立即申请」→ 处理草稿弹窗 → 填事由 → 点「立即提交」→ 回读结果 |
| `browser-driver.mjs` | 极简 CDP 客户端（Node 内置 `WebSocket` + `fetch`，零 npm 依赖），负责拉起/连接 Edge、点击、填表 |

## 与监控层的契约

监控层通过 `config.paths.applyScript` 找到本层的入口脚本，并这样调用它：

```
node apply/apply-pku.mjs
环境变量 REMAINING_CREDITS=<有效剩余 credits 数>
```

脚本需要遵守下面几条约定，监控层才能正确推进状态机：

1. **入口**：从环境变量 `REMAINING_CREDITS` 读取要写进申请事由的数字。
   拿不到就用 `config.threshold` 兜底。
2. **回报结果**：结束时调用监控层标记状态（`apply-pku.mjs` 里的 `markState()`）：

   ```
   node monitor/credit-watch.mjs --mark submitted --note "申请已提交，事由：剩余120credits"
   node monitor/credit-watch.mjs --mark failed    --note "FORM_NOT_OPEN"
   ```

   `submitted` 是终态：同一个额度周期内不会再触发第二次申请。
   `failed` 会在 10 分钟后重试。
3. **退出码**：`0` 成功，`1` 失败，`3` 提交结果不确定（已按 `submitted` 处理，避免重复申请）。
4. **锁**：提交期间 `apply.lock`（在应用根目录）由监控层持有，脚本结束后删除它。
   不要在没拿到锁的情况下提交。

## 换成自己的门户要改什么

最小改动是**只改 `config.json`**，不用碰代码：

```jsonc
"application": {
  "url": "https://你的门户/事项详情页",
  "detailsUrlPattern": "事项详情页 URL 里的特征串",
  "formUrlPattern":   "申请表单页 URL 里的特征串",
  "loginUrlPattern":  "登录页 URL 里的特征串（用于识别「还没登录」）",
  "portalHosts":      ["你的门户域名", "统一认证域名"]
},
"browser": {
  "applyButtonText": "立即申请",           // 进入申请表单的按钮
  "submitButtonTexts": ["立即提交"],        // 真正提交的按钮（别误点「保存草稿」）
  "reasonFieldSelectors": ["请输入申请事由"], // 事由输入框的 placeholder / aria-label
  "reasonFieldKeywords": ["事由", "原因"],   // 找不到时的兜底关键词打分
  "draftDialogChoice": "重新开始"           // 草稿弹窗里选哪个
}
```

如果你的门户结构差别更大（不是「详情页 → 申请页」两步、字段也不是 textarea、
需要填多个字段），那就**重写 `apply-pku.mjs`**，但保持上面的契约：

- 入口读 `REMAINING_CREDITS`
- 结束时 `--mark submitted|failed`
- 保持零 npm 依赖（只用 Node 内置模块），或者在 README 里写清楚新的依赖

`browser-driver.mjs` 是通用的 CDP 驱动，跟门户无关，通常可以直接复用；
只有当门户在 iframe 里、需要特殊登录流程时，才需要改它。

## 安全边界（改写时也要遵守）

- **不碰凭据**：密码、验证码、短信验证一律由本人在浏览器里完成。
  遇到登录页就停下来等，脚本本身只负责等待和检测。
- **不写个人信息**：申请事由里只放额度数字（`剩余<NNN>credits`）。
- **截图与页面 dump 落在根目录的 `artifacts/`**，里面含姓名/学工号，**不要提交到 git**。
- 浏览器 profile 在根目录的 `browser-profile/`，含登录 cookie，**不要提交到 git**。
