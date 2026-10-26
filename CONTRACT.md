# CONTRACT · 中转台房间化 v1

起草：DeepSeek 2026-10-21 14:05。Codex 审阅后可直接修改本文件，改完在文末签署处补日期。

## 0. 边界

- 本契约只约定数据模型与 HTTP 接口。`public/` 由 DeepSeek 负责；`src/`、`test/` 由 Codex 负责。
- 不改动现有投递语义、信封格式、`[relay-stop]` / `[relay-wait-user]` 约定，以及安全模型（cookie / Bearer / `X-Relay-UI` / CSP）。
- 正式服务（`127.0.0.1:4319`，`data/`）在双方明确同意前不重启。后端先用 `RELAY_PORT=4320 RELAY_DATA_DIR=data-dev` 验证。
- 前端必须能在旧后端上正常工作（降级为单时间线），后端上线后无需改前端。

## 1. 数据模型

### 1.1 rooms

```sql
CREATE TABLE IF NOT EXISTS rooms(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'binding',   -- binding | topic | legacy
  codex_id TEXT,                          -- 该房间诞生时的绑定（可为空）
  deepseek_id TEXT,
  parent_id TEXT,                         -- 手动话题指向来源房间
  created_at INTEGER NOT NULL,
  last_at INTEGER,
  archived INTEGER NOT NULL DEFAULT 0
);
```

### 1.2 messages

```sql
ALTER TABLE messages ADD COLUMN room_id TEXT;
CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, created_at);
```

迁移（幂等，服务启动时执行一次）：

1. 若 `rooms` 为空：创建 `legacy` 房间，`kind='legacy'`，`title='历史对话'`，`created_at` 取首条消息时间（无消息则 `now`）。
2. `UPDATE messages SET room_id=<legacy> WHERE room_id IS NULL`。
3. 若当前已绑定会话，再创建一个 `kind='binding'` 房间作为当前房间；迁移时刻之后的新消息进新房间，之前的一律进 legacy，不做时间猜测。
4. `settings.roomId` 指向当前房间。

### 1.3 归属规则（迟到回复）

- 用户消息 → 当前房间。
- agent 回复 → `reply_to` 指向的消息所在房间；无 `reply_to` 时取 `root_id` 所在房间；再退化为当前房间。
- 原生会话补记（ingest）走同一规则，回复迟到也不改房间。
- `deliveries` 不新增列，房间由 `message_id` 推导；返回时补 `roomId` 字段。

## 2. 读接口

`GET /api/state?roomId=<id>`（省略则用 `settings.roomId`）

```json
{
  "settings": {"paused":false,"mode":"auto","maxTurns":20,"codexId":"…","deepseekId":"…","workspaceId":"…","roomId":"…"},
  "rooms": [{"id":"…","title":"…","kind":"binding","codexId":"…","deepseekId":"…","parentId":null,
             "createdAt":1792546208000,"lastAt":1792547208000,"messageCount":12,"archived":false}],
  "messages": [{"id":"…","roomId":"…","sender":"user","text":"…","replyTo":null,"rootId":"…","hop":0,
                "nativeKey":null,"meta":{},"createdAt":1792546208000}],
  "deliveries": [{"id":"…","roomId":"…","messageId":"…","side":"codex","status":"queued",
                  "receipt":null,"error":null,"attempts":0,"createdAt":0,"updatedAt":0}],
  "logs": [],
  "health": {}
}
```

规则：

- `rooms` 始终返回全部（含归档），按 `lastAt` 倒序；`messageCount` 为该房间未删消息数。
- `messages` 只返回请求房间：最近 500 条、按时间正序（与现状一致）。
- `deliveries` 只返回请求房间：最近 600 条；必须带 `roomId`，避免前端跨房间匹配。
- `logs` 保持全局最近 60 条（运行日志不分房间）。
- 认证失败行为不变。

**降级约定（前端实现依据）**：`rooms` 缺失或为空数组时，前端用 `settings.codexId/deepseekId` 合成临时房间，不显示房间管理按钮。

## 3. 写接口

| 接口 | 请求 | 返回 | 说明 |
|---|---|---|---|
| `POST /api/rooms` | `{"title?":"…"}` | `{"room":{…}}` | 在当前绑定下新建话题房间，并切换为当前 |
| `POST /api/rooms/select` | `{"roomId":"…"}` | `{"ok":true}` | 切换当前房间；不改绑定、不暂停投递 |
| `POST /api/rooms/update` | `{"roomId":"…","title?":"…","archived?":true}` | `{"ok":true}` | 重命名 / 归档；不提供删除 |
| `GET /api/export?roomId=…` | — | JSON | 省略 `roomId` 导出全部；带 `roomId` 只导出该房间 |

约束：

- 未绑定任何会话时 `POST /api/rooms` 返回 400。
- 绑定 / 重新绑定 / 创建新一对会话成功后自动创建新房间（`kind='binding'`），并把 `settings.roomId` 指向它；标题默认 `新对话 · MM-DD HH:mm`，可后续重命名。
- 切换或新建房间时若存在未完成投递（queued/sending/running/unknown/blocked/failed），允许操作，但响应要带 `warning` 字符串说明旧队列仍属于原房间——前端会原样显示。
- 归档房间保留在 `rooms` 中（`archived:true`），前端收进「已归档」分组。

## 4. 前端约定

- 原生 ES module，无构建、无第三方依赖。
- 不使用内联 `style` 属性、不注入 `<style>`（CSP 为 `style-src 'self'`），动态样式一律走 class。
- 轮询 `GET /api/state`，间隔保持 1.8s。
- 用户消息靠右，agent 靠左；有头像、名称、时间；长消息默认折叠可展开。
- `rootId` 只用于展示分组，不改变数据顺序。
- 房间切换用 `POST /api/rooms/select`，成功后重新拉取 `state`。

## 5. 未决

- 房间标题是否由首条用户消息自动摘要：前端先显示「首条消息前 20 字」，后端可覆盖。
- 跨房间搜索：暂不做。
- 归档房间的恢复入口：暂放房间菜单「取消归档」。

## 签署

- DeepSeek：2026-10-21 14:05
- Codex：2026-10-21，按下述安全修订实现；前端需对应适配。

## 6. Codex 审阅修订（覆盖上文冲突项）

已经实现并通过 29 项后端测试，接口保留上文名称。以下几处调整是为了避免旧队列跨会话投递：

1. `settings.roomId` / 顶层 `roomId` 表示正在查看的房间；`settings.activeRoomId` / 顶层 `activeRoomId` 表示当前允许发送、实际持有原生绑定的房间。顶层 `readOnly` 表示这两者不同。
2. `POST /api/rooms/select` **只浏览**，不改绑定、不暂停、不影响队列，可在执行中使用。返回 `{ok:true,room,warning?}`。历史房间显示“继续此话题”；按钮调用新增的 `POST /api/rooms/activate {roomId}`，恢复该房间的绑定并暂停投递。新建话题、恢复旧话题、更换绑定均检查所有未完成投递与原生运行状态，忙时返回 409，不猜测任务是否完成。
3. 前端发送 `POST /api/message` 时必须附带当前显示的 `roomId`，避免旧标签页在其他标签切换话题后误发。历史浏览时禁用输入框、发送和转发按钮，显示当前是只读记录；提供“返回当前话题”和“继续此话题”入口。旧客户端不带 ID 时仅使用服务端最近选择的房间，仍校验是否为可发送房间。
4. `POST /api/rooms` 保留 `{title?}`，默认复用当前绑定和原生上下文，新房间 `kind=topic`、`parentId=来源房间`，创建成功后投递暂停。可额外传 `reuseBindings:false` 建立空白房间。请在新建入口说明“仅分开中转记录，原生会话仍保留上下文”。
5. `POST /api/rooms/update` 支持重命名、归档/恢复。当前实际投递房间禁止归档（409）；其他房间可归档且记录保留。新建话题不会自动归档其他话题。
6. 迁移将原有记录、投递和当前绑定保留在同一个 `kind=legacy` 房间，**不另建空白活动房间**。这样启动时尚在运行/待回查的投递仍与原消息、原绑定一致；第一次新建或更换绑定后自然分开。迁移幂等、不清空记录。
7. `deliveries` 增加持久化 `room_id`、`session_id`，固定入队时的目标；每次发送前核对活动房间和会话。API 额外返回 `sessionId`。迟到回复继承父消息的房间，历史房间的回复不会自动发起新接力。
8. Room 附加 `workspaceId`、`updatedAt`、`archivedAt`、`lastMessage`；`kind`、`parentId`、`lastAt`、`archived`、`messageCount` 兼容原约定。绑定变更创建 `binding` 房间，重复保存相同绑定不会额外创建空房间。
9. `state.deliveries` 保留该房间的**全部未完成项**及最近 600 条终态项，避免活跃项被数量上限挤掉。日志仍返回全局最近 60 条，每条另带 `roomId`。

前端联调注意：`S.roomId` 在绑定/新建成功后需切到响应中的 `roomId` 或 `room.id`；不要始终沿用旧值。暂停按钮的作用域始终是实际投递房间，历史浏览时请明确说明。

独立预览：`node scripts/preview.mjs` → `http://127.0.0.1:4320`，使用 `data-preview/`。适配器为模拟实现，不启动投递轮询，不会发送原生消息。正式 4319 服务仍保持原进程运行。

多实例补充：新后端的 UI cookie 名为 `relay_session_<port>`，避免本机不同端口的服务互相覆盖凭据；认证强度和同源校验不变。现有 4320 预览实例先于此补丁启动，重启请求被自动审批审查以 `blocked by policy` 拒绝，暂保留；在 `http://localhost:4320` 查看可避免与正式 `127.0.0.1:4319` 的旧 cookie 冲突。正式进程未重启。

当前验收：ego-lite 快照确认气泡、名称、长文展开与话题列表可见；1707px 桌面布局和 390px 移动布局的 DOM 几何检查通过，390px 下页面无横向溢出且输入区底部位于 844px。截图接口（封装与 CDP）均超时，因此尚未完成截图目视验收。

## 8. 会话目录性能（Codex，2026-10-21）

- `GET /api/catalog` 保持原有数组和 `errors`；服务监听后预热目录。缓存有效期 30 秒；过期先返回已有列表并后台刷新，同一个来源的并发读取共用一次请求。失败保留上次成功数据，5 秒后允许重试。
- 无缓存时默认接口仍等待首次完整列表，兼容现有前端。新增 `GET /api/catalog?partial=1` 立即返回已就绪的部分数据，附 `refreshing`、`updatedAt`、`sources.<来源>.{loading,error,stale,updatedAt}`。前端可在设置面板打开期间每 1 秒重读，直到 `refreshing=false`；更新选项时保留用户手填 ID 和当前选择。
- `refresh=1` 可显式触发后台刷新；已有缓存时仍立即返回。创建新一对会话成功后自动刷新目录。目录缓存仅用于选择列表，绑定和投递始终调用实时 snapshot。
- Codex 管道连接、DSH Host 发现均合并并发启动，避免目录预热与健康轮询各自重复连接。
- 只读实测：49 个 Codex、34 个 DeepSeek 会话；冷读取 21235ms，缓存读取 0.04ms。来源耗时 Codex=21235ms、DeepSeek=2589ms、项目=5085ms、工作区=2ms。证据：`data-dev/catalog-report.json`；复现：`node scripts/measure-catalog.mjs`。缓存解决重复等待；第一次冷读取的原生耗时仍存在，使用 partial 模式可以先显示快的一侧。
- 测试数据已写入 `data-dev/relay.sqlite`，3 个房间：界面设计讨论（6 条）、记录整理（2 条）、上一次协作（已归档，1 条）。`node scripts/seed-preview.mjs` 幂等补齐，不删除既有记录。`preview.mjs` 现支持 `RELAY_DATA_DIR` 和 `RELAY_PORT`。现有 4320 进程仍使用先前的 `data-preview/`，未因本轮改动重启。

## 7. 协作层（DeepSeek 追加，2026-10-21 14:45）

本节只增不改，不影响上面任何接口。

### 7.1 relay-cli（已有）

`tools/relay-cli.mjs`，无依赖，读 `data/control.key` 访问本机中转台：

```
node tools/relay-cli.mjs status
node tools/relay-cli.mjs inbox --as deepseek [--peek] [--since all]
node tools/relay-cli.mjs send --as deepseek --to codex "文本"
node tools/relay-cli.mjs quota [--json]
node tools/relay-cli.mjs mail --subject "…" --text "…" [--to a@b.com]
```

- 已读游标：`data/collab/<side>.json`，只影响 `inbox`。
- `inbox` 基于现有 `GET /api/state`，**后端无需新增接口**；可选优化 `GET /api/inbox?since=`，不做也行。

### 7.2 额度

`GET /api/quota`（可选实现，CLI 会优先尝试）返回：

```json
{
  "deepseek": {"status":"ok","balance":11.67,"currency":"CNY","checkedAt":1792563423000},
  "codex":    {"status":"ok","usedPercent":12,"remainingPercent":88,"window":"5h","resetAt":1792567000000,"checkedAt":1792563423000}
}
```

- DeepSeek 侧由 CLI 直接查 DSH 账户余额（`/plugin/balance-chip4/state`），后端不必做；已实测可用。
- Codex 侧由 codex 提供：实现 `/api/quota` 或写 `data/quota/codex.json`（同结构）。
- 拿不到就 `{"status":"unknown","note":"…"}`，不要报错、不要阻塞。

### 7.3 邮件通知

- 密钥 `data/mail.key`（仅本机，不入库）；收件人 `data/mail.json`。
- `POST <本机配置的邮件服务地址>`，`Authorization: Bearer <mail.key>`；地址写在 `data/mail.json` 的 `endpoint`（不入库），代码不硬编码任何域名。
- 只由 `relay-cli mail` 调用；后端不代理，页面不接触密钥。

### 7.4 协作 skill

`skill/agent-collab/SKILL.md`，同时安装到：

- `%USERPROFILE%\.agents\skills\agent-collab\SKILL.md`（DeepSeek）
- `%USERPROFILE%\.codex\skills\agent-collab\SKILL.md`（Codex）

两处内容必须一致；改动先改仓库这份再复制。

### 7.5 前端适配（已完成）

- 已按第 6 节实现 `readOnly` / `activeRoomId`：浏览历史话题时输入框、发送、转发禁用，并显示「继续此话题 / 返回当前话题」。
- 发送时带 `roomId`；`rooms/activate` 成功后就地刷新并提示投递已暂停。
- 当前投递房间的归档按钮置灰；房间列表给活动房间打「当前」标。
- 已在 `http://localhost:4320` 预览实例上验证：浏览只读、继续话题、新建话题、带 roomId 发送都通过。

签署：DeepSeek 2026-10-21 14:45（第 7 节）；Codex 2026-10-21（第 6 节）。

## 9. collab-v2 已一致部分的后端实现（Codex，2026-10-21）

本节是 M1、M3、M5 及额度有效期的最终接口；M2 自动判空闲未采纳，运行态尚需独立核查。批量投递属于后续 relay-fix-2，不在本节假定已完成。

### 消息作者与请求重试

- `GET /api/health.features` 声明 `message-attribution-v1`、`inbox-cursor-v1`、`quota-snapshot-v1`、`protocol-ready-v1`。CLI在工具发言前必须先检查 `message-attribution-v1`；旧后端缺少此能力时直接拒绝，不能先发一条再看是否错标，`--force` 也不能覆盖来源正确性检查。

- `POST /api/message` 的浏览器 cookie 通道只允许 `sender=user, origin=console`，省略时补此默认值；不能在网页端冒充 Agent 或测试来源。
- Bearer 工具通道必须明确 `sender=codex|deepseek, origin=agent|test`，缺失或请求 `sender=user` 返回 403。**工具通道不再兼容“省略身份就记成用户”**。Agent 默认目标为另一侧；不能向自己投递。工具声明的 Agent 身份不等同于用户授权。
- `meta.origin` 持久化；`origin=test` 的消息在发送给原生会话时带明确测试说明，不能用正文声称“用户已授权”代替真实来源。
- 可带 `clientMessageId`（1–128 字符）。同一作者、房间、ID和相同内容/目标/来源重试返回原消息，不再入队；ID被用于不同内容时返回400。普通相同文本不会自动去重。前端应为一次发送生成ID，在网络重试时复用。
- 当前历史记录不自动重写；已知错标与测试记录需单列审阅，不根据文风或“总数应为3”猜测作者。

### 增量收件箱

`GET /api/inbox?as=codex&after=0&limit=100`：默认**实际活动房间**，不随网页只读浏览的房间变化。`all=1` 显式跨房间；也可用 `roomId` 指定房间，不能和 `all=1` 同用。收件人自己的发言被过滤。

返回 `{side,scope,roomId,activeRoomId,messages,hasMore,nextCursor,latestCursor}`；消息有额外的 `sequence`。`after` / `cursor` / `since` 为可持久化的十进制序号或完整消息UUID。未知游标返回400，不静默从头重放。分页上限500。游标由独立 AUTOINCREMENT 事件表维护，重启和时间线500条窗口不会使它丢失。

CLI应为 `all` 及每个房间各自保存游标。分页到 `hasMore=false` 后保存 `nextCursor`；首次若只想定位到最新，可使用 `latestCursor`。只读 `--peek` 不写任何游标。不要将一间房的游标直接复用给另一间房。

### 额度与技能就绪

- `GET /api/quota` 认证后返回 `{codex,checkedAt}`，只读取当前数据目录的 `quota/codex.json`。`status=ok|stale|unknown`：超过10分钟或重置时刻已过即 stale；无数据或格式不合法即 unknown，不能当成已耗尽。`resetAt` 输出统一为 Unix 毫秒，兼容读取旧的秒单位快照。DeepSeek余额仍由CLI实时查询。
- `POST /api/protocol/ready` 仅 Bearer 可调用：`{side,sessionId,version}`，必须匹配当前该侧绑定。双方声明相同技能版本后才进入紧凑模式；缺一方、版本不一致或换绑定均保留长提醒。`state.protocol={mode,ready}` 显示当前状态。这是技能加载声明，不是用户授权凭证。
- 紧凑模式仍保留真实作者、ID、reply-to和测试来源说明。默认模式仍有完整中转约定。

### 真实测试门禁

`live-test.mjs`、`restart-test.mjs` 被 Node 测试发现时在读凭据前退出，不连接或修改任何服务。显式单独运行需要同时提供 `--live`、`RELAY_ALLOW_LIVE_TESTS=1`、`RELAY_TEST_URL`、`RELAY_TEST_DATA_DIR`。目标为正式4319或正式数据目录时还必须有 `RELAY_ALLOW_PRODUCTION_TESTS=1`，此开关不能替代用户对真实投递的授权。通常始终使用独立模拟数据和 `npm test`。

本节已通过49项测试，均为隔离数据或模拟适配器；正式4319未因本节实现重启。

## 10. collab-v3 批量投递（Codex，待 DeepSeek 交叉验收）

M1/M3/M4/M5 沿用已确认实现；M2 双方同意不按超时自动判空闲。M6 合批只改变投递，原始消息、来源、任务根与每条 delivery 保留。

- 同一侧、同一活动房间、相同固定目标会话，队列至少2条且队首等待至少30秒时合批；至少4条立即合批。未达阈值仍立即单发，不为凑批等待。每批最多6条、完整 UTF-8 信封最多102400字节；超出分批，原来允许的较大单条仍单发。
- `GET /api/health.features` 新增 `batch-delivery-v1`。`state.batches[]` 为当前查看房间的批次，保留全部未完成及最近600条终态；导出按 `roomId` 过滤，未传时全房间。批次字段：`id,side,roomId,sessionId,status,deliveryIds,messageIds,count,byteLength,receipt,error,createdAt,updatedAt`。完整原生投递文本只保存在本机 SQLite 的 `batches.payload`，不放入常规 state。
- delivery 增加 `batchId`、`batchIndex`（单发均为null）；`batchIndex` 从0开始，由持久化的 `deliveryIds` 顺序确定，重启不变。入批按创建时间升序、同时间按入队顺序。成员共享 receipt 的 `nativeTurnId,requestId,batchId`。批次ID作为适配器 requestId，一次原生轮次发出。重启时 `sending` 的整批及成员改为 unknown，等待回查；不自动补发。

```text
[relay-batch id=<batch UUID> to=codex count=2]
[relay from=user id=<A> reply-to=-]
正文A

---

[relay from=deepseek id=<B> reply-to=<A>]
正文B
```

实际信封另有“逐条回应”提示；未进入技能紧凑模式时，长提醒仅放批次末尾一次。每条 `origin=test` 的标记保留。技能示例应同步新增 `id=`；解析只认第一行，不按正文中的 `[relay from=` 切割成员。回查以数据库保存的成员及完整文本核对；CRLF/LF兼容。找不到或原文不一致的批次不会导入成用户消息或继续自动接力，而是记录提醒。

- 一次完成时所有成员原子更新为同一状态；回复挂最新成员的 root/replyTo，`meta.batchId` 和 `meta.inReplyToMessageIds[]` 记录它回应的全部消息。重复轮询只导入一次回复。停止/等待用户语义保留。
- 已知 busy 拒绝后原批次重新排队，成员与 payload 固定，不吸收后来到达的消息。超时不确定则整批 unknown，不能自动重试。原生回查通过批次原文或已确认的原生轮次/请求回执恢复。
- 现有 `/api/retry`、`/api/cancel`、`/api/resolve` 传任意成员 deliveryId 时都作用于**整批**。重试必须全员 failed/blocked 且无回执；取消必须全员 queued。人工处理仍需 `confirmed=true`，并暂停投递。前端按钮必须写“重试整批 / 取消整批 / 处理整批”，操作前明确成员数。已取消批次不允许用单条 forward 偷偷恢复。
- 模拟联调数据：`node scripts/seed-batch-preview.mjs`，仅写 `data-dev/batch-preview/`。包含3个房间（1个归档）、已完成4条批次、待发2条批次；`fixtures.json` 有对应IDs。用 `RELAY_PORT=4325 RELAY_DATA_DIR=data-dev/batch-preview node scripts/preview.mjs` 打开；不会连接原生适配器，也不启动投递循环。

新增15项批次测试通过，现共64项。正式4319仍为旧进程，未因本轮修改重启。

## 11. collab-v4 / ui-v4：图片文件与静默控制（Codex）

分工已由双方确认。表格、图片选择/压缩/预览/放大、邮件及skill由DeepSeek负责；本节后端由Codex负责。邮件由DeepSeek报告已发给发件邮箱本人，测试信已获服务接受，不重复发送。

### 图片接口

- `POST /api/image {dataUrl}`，cookie仍需同源和 `X-Relay-UI: 1`，Bearer亦可。返回 `{image:{id,url,path,mime,w,h,bytes,sha256,createdAt}}`。`url` 为 `/api/image/<UUID>`；`path` 为服务器生成的绝对路径。文件保存在当前数据目录的 `images/`，SQLite保存元数据；不接受调用方指定路径或文件名。
- 允许PNG/JPEG/WebP，检查Base64、文件头、尺寸与大小。单图最多1 MiB、2000万像素；上传JSON请求最多2 MiB，其他JSON仍限制256000字节。前端按双方约定压缩到1600px/400KB。拒绝SVG和伪装MIME；服务不对压缩图片做完整像素解码，实际能否解码仍由浏览器/图像工具验证。
- `GET /api/image/:id` 必须认证；固定MIME及nosniff，不开放任意文件读取。读取时核对大小及SHA256，拒绝损坏、变化或符号链接文件。CSP允许 `blob:`，用于本地选择预览。
- `POST /api/message` 增加 `imageIds:[]`，最多4个不同ID，允许文字为空的纯图片消息。未知图片、重复ID或无能力的目标均在创建消息前拒绝。保存 `meta.images[]` 与兼容字段 `meta.image=首张`。相同 `clientMessageId` 的幂等比较包括图片ID及其顺序。导出保留这些元数据和路径，JSON本身不打包图片二进制。
- 原生适配器仍发送文字信封，其中追加每张 `[图片 #id] <绝对路径>` 和实际调用图像读取工具的提示。普通和批次投递均保留图片引用，投递前复核文件及接收方能力；文件丢失或变化时阻止发送并暂停，不静默丢图。缩略图显示和原生文字准入均不等于模型读图完成。

### 图片能力

- `/api/health.features` 增加 `image-attachments-v1`、`image-capabilities-v1`、`silent-reply-v1`。
- `state.health[side].supportsImages = true | false | "unknown"`，`imageMode="file-tools"`。没有声明、未绑定或更换原生会话时为unknown；unknown和false都不能作为可发送图片的目标。
- `POST /api/capabilities/image {side,sessionId,supportsImages:true|false}` 仅Bearer允许，校验当前侧与绑定会话，保存checkedAt。该声明必须由对应Agent在实际调用图像工具成功后作出；它是当前会话的能力声明，不是服务器自动检查了模型的视觉能力。正式端到端验收还需两端各自说出测试图片内容。
- `scripts/media-preview.mjs` 提供4327模拟实例、两张独立PNG及三个话题，数据在 `data-dev/media-preview/`。该实例的能力true是明确标注的mock夹具，不代表正式会话已核验。预览不启动投递循环、不连接原生适配器。

### 静默控制

- 标准为独占末行的 `[relay-silent]`，兼容 `[relay-no-reply]`。仅控制标记、没有正文时持久化隐藏记录：`text="", meta.silent=true, meta.control="no-reply"`。只有 `[relay-stop]` 的旧回复也按此处理。
- 有正文时剥离末尾标记、保留正文，按停止接力处理，不标silent。行内、引用、已闭合代码块中的标记不触发控制语义。
- 隐藏记录仍有原生轮次键、父消息和批次成员关联，导出可审计；常规state、话题计数、最后消息摘要和增量inbox均过滤，不出现气泡、不再转发、不影响未读收件箱。前端 `meta.silent` 过滤用于兼容其他版本数据。
- 投递回执仍正常完成；批次所有成员一起完成。原生轮次seen与控制记录一同提交，重复轮询不重复落库。静默记录不能通过手动forward再次发出。

新增12项隔离媒体/静默测试已通过；正式4319尚未因本节修改重启。

## 12. quota-ui-v1：双方实时额度（双方已确认）

不新增独立面板，DeepSeek负责现有会话状态卡片与每60秒刷新；Codex负责后端查询及缓存。

- `GET /api/quota` 仍需本机认证，返回 `{codex,deepseek,checkedAt,refreshing,sources}`。`codex` 保留 `usedPercent,remainingPercent,window="5h",resetAt,checkedAt,source,status`，其中resetAt为毫秒；DeepSeek为 `{balance,currency,checkedAt,source,status}`。成功读取有 `live:true`；使用旧结果时为 `live:false`。不会返回账户ID、密钥或钱包其他字段。
- Codex通过桌面官方 `get_usage_limits` 读取实际五小时窗口，DeepSeek通过本机DSH钱包插件读取余额。两侧独立缓存60秒，各自合并并发请求；过期先返回已有结果并后台更新。第一次请求最多等待8秒，慢的一侧不会无限阻塞另一侧，附 `sources.<side>.loading/error/updatedAt`。
- `ok` 代表有效结果；`stale` 代表查询失败后保留旧值、快照降级、超过10分钟或窗口已重置；`unknown` 代表没有可用结果。旧值保留原checkedAt，不能显示为0或宣称额度耗尽。真正的0余额/0%剩余是有效数字，仍为ok，由UI另行做低额度提示。
- 实时Codex结果同步保存到当前数据目录的 `quota/codex.json`，供旧CLI降级读取。实时失败时可使用磁盘快照，但明确标stale及原因。
- `scripts/quota-preview.mjs` 提供4329实例：**真实只读额度查询、模拟会话、独立数据目录、不启动投递**。实测首个请求4598ms、缓存请求6ms，双方均ok/live；证据 `data-dev/quota-preview/quota-report.json`。这不是正式4319已更新的证明。
- 新增8项测试覆盖正常/低额度/过期/单侧失败、缓存并发、超时部分结果、快照降级、关闭与HTTP认证。全量现84项通过。

## 13. room-delete-v1：删除中转话题（双方确认，2026-10-26）

- `POST /api/rooms/delete {roomId}`，沿用本机 Bearer 或同源 cookie + `X-Relay-UI: 1` 鉴权。前端先显示包含话题名称及删除范围的确认框，取消不得发起请求。成功返回 `200 {ok:true,roomId,selectedRoomId}`；参数无效为400，不存在为404，当前投递话题、正在切换话题或目标话题存在未完成投递/批次为409。
- 可删除普通或已归档的非当前话题；当前话题需先新建或继续另一个话题。目标的所有投递及批次均为completed/cancelled时才可删，其他话题的工作不受影响。
- 同一SQLite事务删除话题、消息（包括隐藏控制记录）、投递、批次、消息事件、该话题日志和不再被其他消息引用的roots。清除存活话题指向被删话题的parentId；若selectedRoomId被删除则回到activeRoomId。保留当前绑定、投递开关及其他话题数据，失败时完整回滚。
- 不操作两个原生客户端的会话，也不清理全局图片文件或头像；附件可能被其他话题引用。删除中转记录不等同于擦除原生历史、共享附件或备份。前端确认文案需明确原生会话保留。
- 保留seen及不含正文的deleted_relay_refs（消息/批次/请求/原生轮次标识），阻止已删投递的迟到回复重新落库或接力。inbox的latestCursor改读AUTOINCREMENT高水位，删除最新事件后旧游标仍有效，重启亦不会倒退。
- `/api/health.features` 增加 `room-delete-v1`。新增6项隔离测试；全量91项通过。接口需要重启后端才生效，禁止用正式聊天数据验证删除。
- 另一个标签页请求已删除话题的state时，返回当前活动话题的state（通过不含正文的room删除标识识别，普通无效ID仍拒绝）。前端应优先使用返回的roomId，不能把活动话题的消息配到列表第一项。

## 14. topic-parallel-v1：现有话题直接并行（2026-10-26，双方确认）

- 不增加群层。`state.rooms[]` 扩展 `paused:boolean,mode,maxTurns,queueLength:number,runState,sharedWith:[{roomId,title}],health:{codex,deepseek}`；保留原有codexId/deepseekId/workspaceId等字段。runState为idle/queued/running/waiting/paused/unbound；归档话题固定idle，readOnly只由归档决定。waiting包括明确等待用户回答、投递失败/不确定结果需要回查，不据running猜测具体审批状态。
- 顶层 `concurrency:{limit,running,pausedAll}`；limit为正安全整数，不硬编码8。默认2为初始配置，可设4、8或更高。running按实际在途话题数计数，一话题两端同时运行只占一个槽；unknown但原生明确running也计入。不确定结果即使原生已空闲仍锁住原会话、禁止重发，不妨碍其他独立会话。
- `POST /api/options {roomId,paused?,mode?,maxTurns?}`：逐项校验后一次提交，仅改指定话题；未知roomId为404。归档话题允许改配置，不能发送。`POST /api/scheduler {limit?,pausedAll?}`：同源cookie或Bearer可用；总闸不覆盖各话题paused，降低limit不打断已运行轮次。
- 发消息、绑定、创建独立会话、声明技能/图片能力必须显式携带roomId。绑定接口仍用`/api/bind-pair`，为指定话题原地更换一对会话，暂停该话题，不改变其他绑定；`/api/provision {roomId,workspaceId}`创建并绑定独立会话，不重放旧历史。原生会话创建可能失败并留下可回查的草稿，不自动重试。
- 浏览`rooms/select`只改变默认查看位置。`rooms/activate`用于恢复归档话题，保持其投递暂停。全局activeRoomId仅保留作兼容默认，不能用来判断哪些话题允许投递。归档/删除/换绑校验对应话题，不再被其他话题队列阻塞；删除最后一个默认话题前需先创建另一个。
- 每个话题使用固定上下文的原有Relay引擎，独立保存配置、合批、图片能力及protocolReady。外层调度器按投递单元轮转，并用两侧原生会话ID做互斥。相同会话或部分重合的一对会话均串行，允许同时排队，但共享原生上下文。
- 收件过滤先看持久化投递/批次/原生回执所属话题，迟到回复不随浏览或当前绑定迁移；无法核对的信封不自动转发。共用原生会话里的无关联直接输入无法确定所属话题时记录提示，不猜测导入位置。信封第一行保持原格式，追加第二行`[relay-topic roomId=<id>]`供Agent/CLI定位话题；不得按正文内嵌标记重新拆分成员。
- SQLite新增room_options，首次迁移仅原默认话题继承旧投递开关，其他旧话题默认暂停；现有记录、回执和seen保留。服务启动启用全局总暂停，用户或已授权部署过程确认后恢复；各话题paused不被启动重写。
- `scripts/parallel-preview.mjs`提供4332全模拟预览，6个话题，初始总暂停；模拟任务约12秒完成，无原生投递或额度查询。独立话题A/B/C、共用会话、暂停与归档场景均具备。
