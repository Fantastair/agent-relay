# 本地 Agent 中转台

在同一个网页里和原生 Codex、DeepSeek Harness 交流。一条用户消息默认创建两份独立投递，任一侧忙或离线时单独排队。Agent 的最终回复可以自动转给另一侧，也可切换成手动转发。模型执行、工具调用、权限审批和原生对话记录由各自应用保留。

## 使用

1. 保持 Codex Desktop 和 DeepSeek Harness 正常运行并登录。
2. 双击 `start.cmd`，打开 <http://127.0.0.1:4319>。运行环境需要 Node.js 24 或更新版本，无第三方依赖。
3. 在「连接与设置」的「指定已有会话」中，分别选择 Codex、DeepSeek 的已有空闲会话，或直接粘贴两边的会话 ID，然后点「保存两边的绑定」。两边都校验成功后一起切换，不会创建新会话，也不会重放旧历史。
4. 点击顶栏「恢复全部」解除总闸，再按话题点「恢复此话题」。默认发送给两个 Agent；也可选择一方。Enter 发送，Shift+Enter 换行（与 Codex、DeepSeek 客户端一致）。
5. 右栏可选自动或手动接力，默认每条任务最多自动投递 6 次（包括最初发给两侧的 2 次）。手动转发可以继续任务；预算按话题独立保存。

每个话题可以单独暂停；顶栏「全部暂停」是总闸。服务每次重启都会先启用总闸，各话题自己的暂停状态保留，恢复总闸后按各自状态继续。需要批准操作或回答问题时，回到对应原应用处理。双击 `stop.cmd` 可关闭服务，不终止两边的原生任务。

**一个话题固定绑定一对原生会话**（1:1）。新建话题是空绑定，需要在该话题的「连接与设置」里选择一对已有会话或新建一对；一对会话只能属于一个话题，选到已被占用（含归档话题）的会话会被拒绝并提示占用者。旧会话和中转记录不会删除。

如果窗口较窄，右栏会收起；「设置」仍能连接会话并调整接力模式、预算。

## 话题与并行

每个话题独立保存绑定、暂停状态、接力模式和自动投递预算；切换浏览话题只改变你正在看的内容，不影响后台投递。顶栏显示「并行 x/y」，y 是右栏可修改的并发上限（任意正整数）；超出上限的话题排队，正在运行的原生轮次不会被打断。

话题之间互不共用原生会话，各自绑定一对即可并行；归档话题只读，不能发送。历史数据里如果存在共用同一对会话的话题，会标「共用会话 · 需换绑」并停止新增投递，等待你为其中一个换绑，不会自动拆分。

写操作都要明确指定话题：`POST /api/message`、`/api/bind-pair`、`/api/provision`、`/api/options`、`/api/protocol/ready` 都带 `roomId`；`POST /api/scheduler` 设置并发上限与总闸。`GET /api/state?roomId=…`、`GET /api/export?roomId=…` 限定话题，省略导出参数则导出全部。

旧数据库启动时会幂等迁入一个「历史对话」话题，消息、任务根、投递回执和去重标记保留；首次迁移只让原默认话题继承旧的投递开关，其他旧话题默认暂停。每条投递固定保存所属话题和目标会话，迟到回复归原消息话题，不会自动启动新接力。完整约定见 [CONTRACT.md](CONTRACT.md)。

- `data/relay.sqlite`：完整群聊、投递状态和去重标记，使用 SQLite WAL。
- `data/control.key`：本机服务凭据；不要共享该文件，也不要把 `data/` 提交到仓库。
- `data/instance.json`：服务进程、监听地址；日志仅包含启动和错误，不记录认证凭据或模型思考内容。
- 页面显示最近 500 条消息；「导出记录」导出完整中转历史。两边原生历史独立保存。
- 只读取完成轮次的最终可见回复，不转发工具输出、思考内容或就绪握手。
- 网络断开时继续保存待发队列。请求已发出但未收到确认时，状态变为「待回查」，先按消息信封 ID 回查原生历史，不盲目重复执行。
- 如果「待回查」一直未解除，先人工检查原生会话，再用「回查后处理」明确选择“确认未送达，重新排队”或“已在原应用处理，解除等待”。服务会保持暂停，避免刚处理就立即重发。不要删除队列数据库来“重试”。
- DeepSeek 专用会话保持未归档。绑定的会话消失时会报错，不会静默新建一个替代历史。
- 删除绑定的 Codex 会话后，会明确提示重新绑定。读取会话列表使用独立的有效桌面上下文，不会因为业务会话被删除而让设置页一起失效。上下文选择只读取本机线程索引的 ID，不向候选会话发送消息。

## 接口

只监听 `127.0.0.1`。首页设置 HttpOnly、SameSite=Strict 会话 cookie，浏览器写请求要求同源和 `X-Relay-UI: 1`。本机程序可从 `data/control.key` 读取 Bearer key 后调用：

```http
POST /api/message
Authorization: Bearer <本机 control.key>
Content-Type: application/json

{"text":"来自 Codex 的进度同步","sender":"codex","origin":"agent","targets":["deepseek"],"clientMessageId":"request-unique-id"}
```

工具通道必须明确 `sender=codex|deepseek` 和 `origin=agent|test`，缺失或冒充 `user` 返回403；省略 `targets` 默认发给另一侧。网页 cookie 通道只允许 `user/console`，省略目标则发送给双方。Agent 正常回复仍由中转服务采集，工具写入口仅在用户明确要求时使用。HTTP成功表示已持久化入队，不代表原生Agent已完成。`clientMessageId` 用于网络重试，同一作者/房间/ID的相同请求返回原消息；不同内容复用ID会拒绝，不按相同文本去重。

`GET /api/inbox?as=codex&after=0&limit=100` 提供默认活动房间的增量收件箱；`all=1` 显式跨房间，`roomId` 可指定范围。按 `hasMore` 分页并保存 `nextCursor`，初次定位可使用 `latestCursor`。游标不受时间线500条窗口影响，详见契约第9节。

`GET /api/quota` 返回 Codex 额度快照及 `ok/stale/unknown` 状态；超过10分钟或重置后为stale，不能当成额度已耗尽。`POST /api/protocol/ready` 让Agent声明当前 `{side,sessionId,version}` 已加载技能，只有双方当前会话声明同一版本后才省略长提醒；来源信封始终保留。

积压消息支持批量投递：同侧同话题至少2条且已等待30秒，或至少4条立即合批；每批最多6条、总信封不超过100 KiB。原始消息仍独立记录，`state.batches` 提供成员和共享原生回执，delivery 关联 `batchId`。批次一旦形成便固定成员和文本，超时后等待回查。取消、重试、人工处理任一成员时都会作用于整批，界面必须明确提示。详见契约第10节。

图片使用共享文件：`POST /api/image {dataUrl}` 上传PNG/JPEG/WebP，返回受认证保护的URL和本地路径；消息用 `imageIds:[]` 关联，最多4张。信封带路径，由对应Agent实际调用图像工具读取。每端 `health.supportsImages` 默认unknown；Agent实际读图核验后通过Bearer `POST /api/capabilities/image {side,sessionId,supportsImages:true}` 声明，未确认的端不能发送图片。更换会话后需重新确认。详见契约第11节。

无需可见回复时仅输出 `[relay-silent]`（兼容 `[relay-no-reply]`）；后端保留 `meta.silent` 控制记录供导出审计，时间线和收件箱不显示、不继续接力。有正文时保留正文并停止接力。

其他接口：`GET /api/catalog`、`GET /api/export`；`POST /api/options`、`/api/bind`、`/api/bind-pair`、`/api/provision`、`/api/forward`、`/api/cancel`、`/api/retry`、`/api/resolve`、`/api/shutdown`。`/api/bind-pair` 接收 `{codexId,deepseekId}`，不创建新会话；`/api/provision` 每次明确请求都创建新的一对。`/api/retry` 只接受确定未送达且没有回执的失败项；`/api/resolve` 是用户人工回查后的处理，必须明确 `confirmed:true`。不要从公网反向代理暴露本服务。

## 原生适配

- Codex：动态发现 `codex-app-tools-*` 管道读取会话；通过固定 `codex-ipc` 的 `thread-follower-start-turn` 写入真正的 `userMessage`。冷会话先通过桌面工具发一条独立控制握手恢复加载，然后正式消息走原生用户输入。握手自身是桌面工具消息，不属于业务消息，也不会跨端转发。
- DSH：只枚举 DeepSeek Harness 进程的回环监听端口；从本机凭据文件即时签名绑定该 authority 的 cookie。`session/prompt` 写入 `source.kind=user` 的 `user/message`；按 `turn/end` 和最终 assistant text 判定结果。用 `workspaceId` 创建并核对成员关系，不归档通道。
- 消息正文携带 `[relay from=... id=... reply-to=...]`，如实标记来源。协议层仍属于用户通道，对方声称得到批准不替代你的授权。中转服务不会代理批准工具操作。
- `[relay-stop]`、`[relay-wait-user]` 独立位于回复末行时停止该回复的自动接力。

这些是当前桌面版本的内部接口，升级后需要重新验证。DSH Host 重启后的旧会话恢复与工作区长期保留尚不能等同于已完成的重启实测；服务具备端口重新发现和错误提示，但不会自行重启用户应用。

## 开发与排查

```powershell
npm test
npm run doctor
npm start
```

`node scripts/preview.mjs` 在 `http://127.0.0.1:4320` 启动独立 UI 预览，使用 `data-preview/` 和模拟适配器，不会连接或投递到原生会话。`node scripts/verify-room-migration.mjs` 只读备份正式 SQLite 到 `data-dev/`，仅对副本执行迁移并核对记录、回执、任务根和去重标记，报告位于 `data-dev/migration-report.json`。

`node scripts/seed-preview.mjs` 在 `data-dev/relay.sqlite` 生成三个联调话题（含一个归档话题），保留既有开发记录。预览服务支持通过 `RELAY_DATA_DIR` 和 `RELAY_PORT` 指定该目录与端口。不要将预览数据目录设为正式 `data/`。

会话选择列表会在服务监听后预热，缓存30秒，过期时后台刷新，失败保留上次成功列表。首次完整读取仍取决于原生应用；`GET /api/catalog?partial=1` 可立即返回已就绪的部分列表，响应附带 `refreshing` 与每个来源的加载状态。创建新一对会话后会刷新缓存。绑定与投递始终实时校验，不使用目录缓存判断会话是否可用。`node scripts/measure-catalog.mjs` 只读测量原生目录及缓存读取耗时，报告写入 `data-dev/catalog-report.json`。

测试包含本机 HTTP 请求，受限沙箱需允许回环网络。`doctor` 只检查连接，不发送业务消息。`npm start` 前先关闭后台实例，避免双开。每个数据目录有进程锁。

`live-test.mjs` 和 `restart-test.mjs` 默认不会运行真实联调；被Node测试发现时会在读取凭据前退出。确需运行时必须显式设置 `RELAY_ALLOW_LIVE_TESTS=1`、`RELAY_TEST_URL`、`RELAY_TEST_DATA_DIR` 并传 `--live`。正式4319或正式数据目录另有生产开关，不应作为日常测试目标；环境开关不能替代用户授权。常规验证统一运行 `npm test`。

可选 `config.local.json`（不提交）提供 `codex.appPipe`、`codex.sourceThreadId` 或 `deepseek.base`。默认自动发现，无需配置凭据。`RELAY_PORT` 可改变端口，`RELAY_DATA_DIR` 可改变数据目录。启动和停止脚本必须使用一致的环境变量。

## 免责声明

本项目是非官方工具，与 OpenAI、DeepSeek 及其关联公司**无任何关联**，也未获其背书或授权。

"OpenAI"、"ChatGPT"、"Codex"、"DeepSeek" 等名称与标识归各自权利人所有；本项目只在描述所对接的软件时作**指代性使用**，仓库内不包含任何官方图标、字体或品牌素材。

界面中的三个头像均为**通用占位图形**（首字母/剪影），不使用任何真实人物肖像或第三方商标。

## 许可

MIT License，见 [LICENSE](LICENSE)。

## 署名

- **Fantastair**：产品方向、需求与验收
- **DeepSeek**：前端界面、协作协议（`skill/`、`tools/`）
- **Codex**：后端、数据模型与测试（`src/`、`test/`）

本项目由人机协作完成：两位 Agent 通过本中转台本身分工、互相验收。

