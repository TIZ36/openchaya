# fbot —— 录入飞书助手（开发文档）

> 桌面版（Electron）内置的飞书机器人模块：`@机器人 → 能力菜单 → 选项 → 表单 → 提交 → 落库`。
> 卡片在 Chaya 里可视化配置，业务处理在代码里。纯本地，长连接随 App 在线。

---

## 1. 模块构成

| 文件 | 角色 |
|------|------|
| `electron/fbot.cjs` | **引擎**：长连接 + 卡片生成 + 事件路由 + spec/提交持久化 + IPC |
| `electron/fbotMenu.cjs` | **业务规格**：菜单/表单默认值 + `onSubmit`/`onAction`（接真实业务改这里） |
| `electron/fbotRun.cjs` | **独立启动器**：`node electron/fbotRun.cjs`，脱离 Electron 调试 |
| `electron/main.cjs` | `registerFbot(ipcMain)` + 退出 `stopFbot()` |
| `electron/preload.cjs` | 暴露 `window.chateeElectron.fbot.*` |
| `src/v2/services/fbot.ts` | renderer 类型化桥接 |
| `src/v2/FbotView.tsx` | 一级视图（左子导航：连接·日志 / 卡片配置 / 提交记录） |
| `src/v2/ClientShell.tsx` | 左栏入口 + 视图槽（NavKey `'fbot'`，keep-alive） |

**持久化（Electron userData 下）**
- `fbot.json` — appId / appSecret / testChatId
- `fbotSpec.json` — UI 覆盖的卡片配置（菜单/表单）；删掉=恢复 fbotMenu.cjs 默认
- `fbotSubmissions.json` — 提交记录（最近 500 条）

---

## 2. 数据流（闭环）

```
用户 @superzt / 私聊
  └─[event] im.message.receive_v1 → fbot.onMessage → 回「能力菜单卡」
用户点选项
  └─[event] card.action.trigger {action:'menu',key} → 回对应「表单卡」（就地更新）
用户填表单点提交
  └─[event] card.action.trigger {action:'submit',form} →
        spec.onSubmit(formKey, values, ctx)  ← 业务逻辑（落库等）
        recordSubmission(...)                ← 落盘 + 推 UI
        → 回「回执卡」（就地更新）
```

- spec 是**数据驱动**：`fbot.cjs` 不写死菜单/表单，全读 spec。
- 数据部分（menu/forms）可被 UI 覆盖持久化；函数部分（onSubmit/onAction）永远来自 `fbotMenu.cjs` 代码。

---

## 3. 飞书后台接入（一次性，代码侧替不了）

自建应用 `cli_a940fad4a779dbef`（superzt）：

1. **权限**（权限管理，直达 `https://open.feishu.cn/app/<appid>/auth?q=<scope>`）
   - `im:message`（发消息，已开）
   - `im:message.p2p_msg:readonly`（收私聊）
   - `im:message.group_at_msg:readonly`（收群 @）
   - `contact:user.id:readonly`（按邮箱/手机查 open_id，**受「通讯录数据范围」二次限制**）
2. **事件与回调**（`/app/<appid>/event`）
   - 订阅方式 = **长连接**
   - 事件：`im.message.receive_v1`、`card.action.trigger`
3. **发布版本** —— 权限/事件改动必须发版（企业自建可能要管理员审批）才生效。
4. 验证：起长连接（App 内点「启动」或 `fbotRun.cjs`）→ 后台点「Re-Verify」。

---

## 4. 已验证的事实 / 限制（别重复踩）

- **app 在单一租户内**（`2d7a777b...`）。跨租户的人查不到、发不了。
- 给的 `oc_...` 若是 `chat_mode:p2p`，那是「你 ↔ bot」单聊，不是群。
- **bot 以自己身份发消息，不能冒充真人。**
- **按姓名搜人：飞书没有这个应用级接口**。只能 邮箱/手机 → `batch_get_id` → open_id，且受**通讯录数据范围**限制（默认可能只圈创建者本人 → 只查得到自己）。
- 拿别人 open_id 不依赖通讯录的路子：**进同一个群读群成员** / 对方给 bot 发过消息（事件带 open_id）。
- 资料卡「Business Email」≠ 一定是飞书主邮箱；查不到先试**手机号**。
- **群消息不受通讯录/可用范围限制**：bot 进群即可对所有人发言。
- **长连接随 App 生死**：关掉 Chaya，bot 下线。要 7×24 须拆独立服务端。
- **app_secret 进客户端**：个人自用 OK；分发等于泄密，须改服务端持有。
- **同一 app 只跑一个长连接**：多开实例事件会被分流/打架。

### 卡片 v2 schema 踩过的坑
- 按钮**不再用 `action` 容器**包裹，按钮是顶层元素（放 `column_set` 列里）。
- `select_static` **不支持 `label`** 属性 → 用一行 `markdown` 当标签。
- 表单提交按钮要 `form_action_type:"submit"`（不是 `action_type:"form_submit"`）。
- **`note` 标签 v2 不支持** → 用 `<font color='grey'>…</font>` 的 markdown 代替（否则回调更新报 `200673`）。
- 按钮回调用 `behaviors:[{type:'callback', value:{...}}]`；回调响应 `{toast, card:{type:'raw', data:<cardJSON>}}` 就地更新卡片。

---

## 5. 接真实业务（改 `fbotMenu.cjs`）

- **加菜单项**：`menu.options` 加一行，配 `form`（弹表单）或 `action`（自定义动作）。
- **加表单**：`forms` 加一项，字段 `kind` 支持 `input`/`multiline`/`select`。
- **落库**：在 `onSubmit(formKey, values, ctx)` 里替换 TODO —— 写后端 API / Bitable / 建工作项。`ctx.operator.open_id` 是提交人。返回 `{ok:false,message}` 可提示校验错误，返回 `{card}` 可自定义回执卡。
- **查询**：在 `onAction('query', ctx)` 里拼结果卡返回。
- UI（FbotView 卡片配置页）只改 menu/forms 的**结构/文案**；业务行为始终在代码里，互不打架。

---

## 6. 运行 / 调试

```bash
# 独立调试（不经 Electron）
FBOT_APP_ID=cli_xxx FBOT_APP_SECRET=xxx node electron/fbotRun.cjs

# 正式（Electron 内，改 preload/main 后须完整重启）
pnpm electron:dev   # 左栏「飞书」→ 启动
```

---

## 7. TODO / Backlog

### P0 接真实业务
- [ ] `onSubmit` 接「回传需求」真实落地（定目标：后端 API / Bitable / 工作项 + 字段表）
- [ ] `onAction('query')` 接真实进度查询（按 open_id / 单号）
- [ ] 提交后通知相关人（@负责人 / 推到群）

### P1 体验 / 健壮性
- [ ] 提交记录：把 `operator.open_id` 反查成姓名展示（需通讯录数据范围）
- [ ] 提交记录：导出 CSV / 按表单类型筛选 / 搜索
- [ ] 卡片配置：字段加「默认值 / 校验规则（正则/必填提示）」可视化
- [ ] 卡片配置：表单 header `template` 配色选择器
- [ ] 启动失败/断连的 UI 明确提示（当前只在日志里）
- [ ] 长连接断线重连状态回显到状态灯（SDK 自带重连，UI 没体现）

### P2 架构 / 上线
- [ ] 评估「拆独立服务端」：要 7×24 在线 / 团队共用 / 分发时，secret 不能进客户端
- [ ] 多 app / 多 bot 支持（目前单 app 单连接）
- [ ] `card.action.trigger` 幂等：同一提交重试去重（飞书会重试）
- [ ] 事件鉴权/防重放（生产环境）

### P3 安全
- [ ] App Secret 加密存储（当前 userData 明文 json）
- [ ] **提醒**：当前对话里泄露过的 secret 建议在后台 Reset 一次
