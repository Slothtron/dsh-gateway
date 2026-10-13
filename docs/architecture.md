# dsh-gateway 架构

把 IM 平台接进 DSH 会话的插件 bundle。本文是工程视角的整体梳理；面向使用者的安装与配置见 `README.md`。

## 1. 分层与职责

依赖单向，从上到下：

```
IM 平台（微信 / QQ / 飞书 / 钉钉）
   ↕ 平台 SDK、WebSocket、HTTP 回调或长轮询
octop-gateway（Python 库，跑在 sidecar 进程内）
   · ChannelManager / BaseChannel：限流、去重、typing、媒体落盘、群策略、@ 判定
   · 入站流水线：解析 → 预处理 → 登记 subject → 媒体落盘 → 群策略过滤
   ↕ NDJSON stdio（sidecar/dsh_gateway_sidecar.py）
Host 插件（index.js + lib/）
   · sidecar 生命周期：Python 运行时自举、退避重启、通道重放
   · Router：subject → DSH 会话（按 agent preset 组成）、内置命令、就地压缩
   · 存储域（channels / routes）+ 凭据引用
   · 每个通道的运行态（connected / reason / detail）
   · HTTP 控制面 /api/dsh-gateway + 两个 agent 工具
   ↕ cordis 服务：agents / sessions / sessionQuery / tokenMeter /
     credentials / workspaceRegistry / llm / agentDefaultModel，
     以及按需读取的 compaction 与 agentPresets（preset 里的服务经它寻址）
DSH 宿主
   ↕ 槽位 + HTTP
IM 网关页（client.js，落侧边栏 sidebar.panellist + main 槽位）
```

四层各自的边界：

- **octop-gateway 层**：平台协议与限流/去重/typing/群策略。插件不重复实现这些，也不改动它。
- **sidecar**：唯一的 Python↔Node 边界。协议是 NDJSON，按 `mid` 配对请求响应，按 `rid` 配对入站与回复。它负责把库的归一化消息**压平成插件能用的形状**（含群上下文渲染），并把插件的回复 yield 回通道。
- **Host 半**：会话生命周期与策略。它不认识平台协议，只认识 `channel` 记录、`route` 记录和归一化的入站帧。
- **Client 半**：IM 网关页。它是**目录驱动**的：字段名、类型、必填、凭据判定、按平台裁剪、平台卡片的说明文字全部来自 `core/spec/channels.json`，这一侧不维护第二份字段清单。布局是一页式主从：左栏通道列表，右栏平台选择器 / 通道详情；右栏自己开容器查询（`container:dsh-gw-pane/inline-size`），所以「两栏字段」与「平台卡片」的折行按右栏宽度算，而不是按视口宽度算。

契约层 `core/spec/` 是两侧共读的语言中立部分：`channels.json` 决定暴露哪些平台与哪些控件。字段默认值**不在文件里**，由 sidecar 从已装 octop-gateway 的数据类读出写入 `introspect`，所以库升级不会让目录过期；目录与已装库不一致时 `introspect` 报 `drift`，页面顶部显示黄色提示条。

## 2. 数据面

两张表存在 storage domain `dsh_gateway_<profile>`（`lib/domain.mjs`）——**每个 profile 一份单元**，单元名就是归属（见 §8.3）：

| 表 | 键 | 内容 |
| --- | --- | --- |
| `channels` | 通道 UUID | `kind` / `label` / `shortId` / `enabled` / `config`（非凭据字段）/ `secretRefs`（字段→凭据引用）/ `workspaceAccess`（`mode` + 路径白名单）/ `sessionPolicy`（压缩开关与阈值） |
| `routes` | `${channelId}:${subjectId}` | `sessionId` / `generation` / `modelOverride` / `cwdOverride` / `rotateOnNext` / `chatType` / `lastMetadata` / `lastCompaction` |

- **凭据永不落 domain**：值存 DSH 凭据库，键名 `DSH_GATEWAY_<通道UUID去横线大写>_<字段大写>`，表里只留引用。
- **名字是派生的，不是输入**：`label` 由宿主在创建时写成 `<平台显示名>-<6 位 id>`，`shortId` 就是那 6 位（取自去掉易混字符的字母表，创建时对已有通道去重）。页面**不发送**名字，所以「改个标签」这条路在协议上就不存在；已存在记录的 `label` 永不被目录改名波及。
- **`workspaceAccess` 取代了写死的工作区**：`all` = 不限制（会话落在中性目录，`/workspace` 可切任意已注册工作区）；`selected` = 路径白名单（会话默认落在第一个仍注册的选中路径，`/workspace` 只能在其内切换）。退役的 `workspaceMode`/`workspacePath` 仍**声明在 schema 里**——裸 `z.object` 会剥掉未知键，那样一个 pinned 通道会静默变成不受限；`normalizeChannel()` 在开表时把它折成单元素白名单并写回，然后删掉旧键。写回失败只记 warn：内存里的记录已经折好，读取方不该因为介质只读就看到旧形状。
- **路由可以先于会话存在**：`route.sessionId` 允许为空。`/model`、`/workspace` 在没有会话时把选择记在这条路由上（`generation` 为 0），第一条消息建会话时继承它，段号从 1 开始。这样「首次无会话」也能先定模型与工作区。
- **`lastMetadata` 是持久化的路由上下文**：库在内存里也记 subject（重启即失），插件这份落盘，是主动推送在重启后仍能定位目标的依据。
- **domain 版本刻意停在 2**：`dsh-storage-json` 对整单元文件是**精确比对**版本戳，升版本会让已存在的 `<DSH home>/storages/dsh_gateway*.json` 直接打不开；`compatibleVersions` 只对逐条文档布局生效。因此形状变更一律用**宽容 schema** 承载：退役字段被剥掉，新字段带默认值补进来。
- **删除通道要带走它的路由**：路由是 `channelId` 的从属行，删除通道时逐条删掉（router 内存里那份同源视图一起删）；开表时还有一次 `dropOrphanRoutes` 兜底，把指不到通道的陈旧路由清掉并记一条 warn——老版本的删除路径只删了通道记录，这正是「移除通道实例后仍有残留」的来源。
- **一个账号一条通道**：目录里每个平台声明 `identity`（承载平台账号 id 的那个控件），宿主按 `kind + identity 值` 判定重复——重复提交落到已有那条记录上（只换凭据，保留工作区访问范围与压缩设置），把已有通道改成别人正在用的账号则直接拒绝。理由：同一账号的两条活通道不是两段对话，而是两个轮询器抢一个登录，平台会踢掉其中一个，表现成随机掉线。域名只保证「本 profile 一份」，账号唯一性由这条规则兜住。

## 3. 一次入站

1. 平台事件 → octop-gateway 的 `BaseChannel.handle_inbound`：解析成归一化消息 → 预处理器 → 登记 subject（供主动推送）→ 媒体落盘 → **群策略过滤**。未触发策略的群消息在此终止，只进短时缓冲，不进任何会话。
2. sidecar 的 `processor` 收到消息，把正文与**群上下文**压平成一段文本，连同 `subject`（含 `chat_type` 与标量 metadata）写成 `inbound` 帧。
3. Host 的 `Router.handleInbound`：命中内置命令就地应答；否则按 `${channelId}:${subjectId}` 找路由，同 subject 的 turn 用 Promise 链**串行**排队。
4. 需要新会话就 `agents.create`，否则复用或 `agents.resume`；把文本原样作为 user message 提交，等 `whenIdle()`（上限 `replyTimeoutSec`）。
5. 从会话 surface 取末条 assistant 文本，按 `rid` 回给 sidecar，由它 yield 回通道发出。
6. turn 之后跑一次**就地压缩**判定（见 §5）。

## 4. 通道的群聊支持

这一节是平台差异最集中的地方。三件事必须分开看：**会话粒度**、**激活条件**、**被动上下文**。

### 4.1 平台能力

| 平台 | 群聊 | DSH 会话粒度 | @ 判定 | 主动推送进群 |
| --- | --- | --- | --- | --- |
| 微信 `weixin` | 无 | 用户 | — | 仅私聊 |
| QQ `qq` | 有 | **一个群一个会话** | 有 | 支持 |
| 飞书 `feishu` | 有 | 群会话 = 会话 id；**带话题时 = 话题 id**（一个话题一个会话） | 有（结构化 mentions） | 支持，但依赖持久化的 `chat_id`（subject_id 可能是话题 id，不是发送目标） |
| 钉钉 `dingtalk` | 有 | **每个发言人一个会话**（subject 恒为发送者） | **无** | 退化为给该人发私聊 |

库的契约是「群消息的 subject 即会话目标，作者另存于 metadata，**所有成员共用一个 thread 且不丢归属**」。QQ 与飞书遵守；钉钉用发送者当 subject，因此群内每个成员各占一个 DSH 会话，群维度只影响群策略与回复路由。

### 4.2 群策略真正的开关

群策略分两层，缺一不可：

- **能不能进来**（库内 `GroupContextManager`）：识别群会话（先看 metadata 的会话 id，再看 `chat_type == "group"`）；策略未启用直接放行。
- **要不要触发**：`activation == always` 或该消息带 `bot_mentioned`。且 `always` 在可见范围不是「全部消息」时会**降级为 mention** —— 这就是页面里「每条消息都回复」只在「全部消息」时可选的依据。

于是「仅被 @ 时回复」只在 **QQ 与飞书**成立。钉钉只把正文开头的 `@机器人名` 文本剥掉，从不上报 `bot_mentioned`，所以钉钉群要用群聊只能选「全部消息 + 每条消息都回复」。

页面据此按平台裁剪：`core/spec/channels.json` 的 `groupPolicy` 组声明 `kinds: ["qq","feishu","dingtalk"]`（微信没有群，整组不出现），并给钉钉带一条 `kindNotices` 说明。

### 4.3 被动上下文（群聊里别人说的话）

不触发的群消息不会被丢掉，而是进库内短时缓冲（受可见范围、历史模式、条数、TTL 约束，可按群覆盖）。触发时，缓冲内容挂在 `message.group_context` 上 —— 库**故意不把它并进正文**，保持会话线程干净。

因此渲染是 **processor 的责任**，也是插件的责任：sidecar 把缓冲内容渲染成

```
【群聊背景｜仅供参考】
[小李] 今天几点上线
[群成员1] 同问

【当前群消息｜请回复这条】
[小王] 帮我查一下发布单
```

无名字的发送者按出现顺序给「群成员N」，同名 id 复用同一个标签；私聊没有群上下文，渲染退化为原文，保持不变。**不渲染就等于页面里的「@ + 最近消息 / 上下文消息条数」空转**，所以这一步是把配置变真的必要条件。

### 4.4 回复与主动推送

- **回复**走 inbound 时用的 subject，群回复自然回到群里。
- **主动推送**（`im_push_text`）只给库一个 subject 标识：库会先合并它自己记住的 subject 路由状态，再做平台回填，然后剥掉仅在被动回复里有意义的临时字段。因此推送的可靠性取决于「该通道见过这个 subject」，而插件持久化的 `lastMetadata` 正是重启后的兜底。
- 钉钉是例外：它的主动发送只有私聊接口，且群回复依赖只存在于被动回复里的会话 webhook，所以**主动推送无法进群**。

## 5. 新增通道：扫码与手填

新增通道有两档，目录决定某平台有没有快捷档（`quickConfig.mode = "qr"`）：

```
POST /qr {kind}      → sidecar qr_start  → { task_id, url }
GET  /qr/:taskId     → sidecar qr_poll   → { status, url?, fills?, secrets? }
DELETE /qr/:taskId   → sidecar qr_cancel
```

- **会话活在 sidecar**：库的登录对象把一次性密钥与刷新计数放在内存里（QQ 要靠它解密 AppSecret），所以会话不能跨进程；凭据也**从不落盘**，只在确认那一刻经过一次 `qr_poll` 交给页面。
- **两个平台的等待方式不同**：QQ 有非阻塞的 `poll(task_id)`，状态由平台明确给出；微信只有阻塞式 `wait_for_login`，而且**它内部会自动换码却不告诉调用方** —— 若直接用它，页面会继续显示一张已失效的码而后台在轮询另一张，用户就卡死了。所以微信由 sidecar 自己跑有界窗口、每次刷新都由自己发起并把新码写回会话，页面上的码始终是当前那张。
- **凭据一次性交付**：`qr_poll` 首次返回成功时带上 `fills` / `secrets`，随后立刻从会话里清掉并标记已交付，重复读取拿不到第二份。
- **两种收尾方式**：`quickConfig.only` 的平台（微信）没有手动档，连接字段在创建期不出现，扫码确认后**直接创建通道**；其余平台（QQ）扫码只把值填进草稿，仍要点「创建」。两条路都走**同一条保存路径**写入凭据库 —— 凭据写入永远只有一个入口。名字两边都由宿主派生，页面不需要为「先起个名」加一个前置步骤。
- **host 层有一个坑要记住**：`registerRoutes` 在注册处就 `return`，其后的区域只在**函数声明**上可用（声明会提升）；一旦在那里写 `const`/`let`，它永远停在暂时性死区，首次调用就抛 `Cannot access ... before initialization`。`host-http.test.mjs` 把请求路径真正跑一遍，专门守住这一点。
- **二维码在客户端编码**：平台返回的是一个「要编码成二维码的链接」，本机没有现成组件，客户端内嵌了一份 MIT 的二维码编码器（`client.js` 里的 vendored 段）。配色固定白底黑码：扫码由相机识别，反色码会被不少扫码器拒绝，所以它不跟随主题。

## 6. 会话与模型策略

- **换会话只由命令触发**：`/new`（以及会改变会话创建期事实的 `/model`、`/workspace`）在路由上置 `rotateOnNext`，下一条消息开新会话（`generation + 1`），旧会话保留。
- **上下文压力不换会话，改为就地压缩**：turn 之后按 `tokenMeter` 水位判断，越线调用**这个会话自己的压缩引擎**。**插件只决定何时压**；压多少、保留什么、怎么摘要由宿主的压缩策略决定，宿主的按步压缩也照常运行，两者都只是减少同一份历史。
- **压缩引擎「按会话」取，不是「按部署」取**：DSH 可以把压缩叶装在宿主平面（acp / headless），也可以把它关进**每个 agent preset 的隔离域**（Web profile：宿主平面关掉 `compaction-basic`，由 preset 在 `isolate: {compaction:true}` 的组里重新装一个）。隔离域里的实现不在 agent 的 fiber 之下，`ctx.get('compaction')` 与 `agent.ctx.get(...)` 都取不到，唯一入口是 preset 注册表的读寻址 `agentPresets.serviceFor(agent, 'compaction')`（宿主自己的会话控制器与子代理也用这条）。插件先走它，取不到再回落宿主平面，两处都没有就跳过——**读取而非注入**：`agentPresets` 与 `compaction` 都不进 `inject`（注入在会话存在之前就解析完了，而这两个服务要么按会话取、要么可能整个不存在），部署没有压缩叶时插件照常激活。
- **会话按 agent preset 组成**：建会话时解析部署默认 preset，把 id 记进会话头（`meta.agentPreset`，持久），并在 agent 的 setup 里 `mount` 它——与宿主会话控制器同构。Web profile 把工具、技能、压缩整体挪进 preset，不挂 preset 的会话（宿主平面只剩 web search / MCP / 工具类插件）拿不到任何编码工具。恢复会话时按它记录的 preset 重新挂载；记录为空的旧会话用部署默认补齐（已开始的会话不允许改绑，创建期是唯一机会）。preset 不可用时不把会话连带做掉：记 warn，按宿主平面组成，IM 不断线。
- **不解锁模型**：普通会话跟随 DSH 当前默认选择（与宿主会话控制器同构）；只有显式 `/model` 才 pin。取模型窗口时优先读**会话自己记录的请求头**，拿不到就跳过压缩判定 —— 不猜。
- **不注入 prompt / 人设**：入站文本原样提交（群聊的上下文框架属于消息内容，见 §4.3），系统提示一律由宿主装配。

## 7. 命令与工具

IM 内直接发、由插件应答、不消耗 agent turn：`/help`、`/new`、`/compact`、`/model`（含 `list` / 序号 / `default`）、`/workspace`（含序号 / `default`）。`/model list` 与宿主模型选择器同源。

面向 agent 的工具：`im_list_channels`（通道 + 已路由 subject，含 `rotate_on_next` 与 `last_compaction`；每条通道另给 `connected` / `status_reason` / `status_detail`）、`im_push_text`（主动推送到某个 subject）。

### 连接态怎么判

设置卡片的圆点与「测试连接」共用同一个判据（`_channel_ready`）：

1. 通道自己翻的 `_running`（`start()` 置真、`stop()` 置假）—— 本目录暴露的四个平台都有它；
2. 没有 `_running` 的通道（discord / telegram / xiaoyi）回退到活着的会话句柄（`_connection_session` / `_ws_session_id` / `_session_id_ws`）。

> 只认会话句柄是不行的：四个平台里只有飞书有 `_ws_session_id`，微信（HTTP 长轮询）、QQ、钉钉都不设它，于是「实际能收发消息」的通道会被一律显示成离线。

**这个布尔不足以说明状态**，所以在它之上分了两级：sidecar 报 `{connected, reason, detail}`——`_channel_status` 把「就绪」与「已注册但还没起来（`connecting`）」分开，并把微信被平台判为登录态失效（长轮询收到 `errcode -14`、通道挂起等重新扫码）单独报成 `session-expired`；宿主再补上只有它知道的三类——`disabled`（记录停用）、`unsupported`（目录不再提供该平台）、`error`（注册/启动抛错，`detail` 带上原话）。宿主与 sidecar 的分工是「谁知道谁写」，状态条目按字段合并，sidecar 的下一帧不会抹掉宿主写下的原因。页面的圆点、标签、悬停与详情页警告行都读同一份，因此失败不可能一边显示红灯、一边显示「连接中」。

**平台错误在宿主侧翻译**（`lib/errors.mjs`）：`describeChannelError` 把认得出的平台原话翻成「先做什么」（QQ 的 `100016`、飞书的 token 校验、凭据缺项、`errcode -14`），并把原话附在后面；认不出的原样返回。翻译只发生在**边界**（HTTP 错误响应、测试连接的 detail、状态 detail），判定权仍完全在 octop-gateway：插件不因为认出某个错误就改变行为，也不吞掉任何错误。

**保存与启动分成两个答案**：配置先落 domain，再交给 sidecar 启动；启动失败时记录运行态并向页面返回 `startError`，HTTP 状态仍是 200（保存确实成功了）。合并成一个「保存失败」会让人去找一份其实已经写好的配置。

## 8. 运行时与部署形态

- **sidecar 必须独立进程**：octop-gateway 是 Python asyncio 库，DSH 是 Node/Cordis 宿主。
- **Python 运行时自举**：按显式解释器 → 包内 `.venv` → PATH → 托管 venv 顺序探测（探针会 `import octop_gateway`），都没有就在数据目录建托管 venv 安装（优先 uv）。首次启动走在激活路径之外，不拖慢宿主启动；失败写状态并退避重试。
- **数据目录**默认 `<DSH home>/dsh-gateway`，托管运行时、媒体与未绑定通道的中性会话目录都在其下。
- **工作区**：「指定工作区」范围（或部署级 `defaultWorkspacePath`）才会把会话登记进工作区；「所有工作区」范围且无 `/workspace` 覆盖时，会话跑在中性目录、不注册不 attach，因此落在侧边栏「未分组」——插件不替用户创建工作区。范围收窄会即时生效：下一次建会话会丢弃越界的 `/workspace` 覆盖并记一条 warn（`_createSession`）。
- **配置按 profile 隔离**：每个 profile 读写自己的存储单元（§8.3），装了本插件的另一个 profile 看不到、也不会加载这些通道；但**同一个 IM 账号不要配两次**——平台侧"一处一连接"是平台自己的规则（§8.3 列了四平台的表现）。sidecar 生命周期仍跟宿主进程绑定，DSH 自己的 sessions/storages/凭据库仍按 DSH home 共享。

### 8.1 激活与卸载：资源归谁释放

插件可以在插件中心被反复关闭/启用，**每次启用都会重新打开一遍资源**，因此每一项资源都必须由**本次激活自己**在 `ctx.effect` 的卸载回调里释放。漏一项，下一次启用就会报错或留下幽灵行为：

| 资源 | 打开方式 | 卸载时 | 漏掉的后果 |
| --- | --- | --- | --- |
| 存储域句柄 | `ctx.storageDomain.open(spec)` | `ctx.effect(() => () => domain.close())`（`lib/domain.mjs`） | 域名一直被占，再次启用报 `DomainError: domain 'dsh_gateway' is already open` |
| HTTP 前缀路由 | `ctx.webServer.register({kind:'prefix', ...})` | `ctx.effect(() => ctx.webServer.register(...))`（`lib/http.mjs`） | 路径一直被占（再启用报 `duplicate prefix route`），且旧 handler 在**已销毁的 ctx** 上取服务，报 `cannot get required service ... in inactive context` |
| 工具 | `ctx.tools.register()` | 注册本身就是 effect，随 ctx 卸载 | —— |
| 定时器 | `ctx.setTimeout()` | 随 ctx 销毁；待执行的重启还要显式取消 | 关闭后仍会触发一次重启 |
| Python 子进程 | `sidecar.start()` | disposer 里 `await sidecar.stop()` | 新旧两个 sidecar 同时轮询同一 IM 账号 |

- **facility 与 webserver 都只把所有权交给调用方**：前者只保留域名，后者只返回一个 disposer，都不绑定调用 ctx。所以「打开了」不等于「会被关掉」。
- **`ctx.effect(fn)` 的 `fn` 在激活时立即执行**，它**返回**的函数才是卸载回调。把「正在停止」这类状态写进 `fn` 本体（而非返回值），会让 sidecar 的崩溃自愈从激活第一毫秒起永久失效。
- **会话属于宿主，不属于插件**：关掉插件不会停掉它建的会话。因此装在 agent ctx 上、比插件 ctx 活得更久的监听器，读插件 ctx 的服务时必须降级而不是抛错（`_installFollowDefaultSelection` 的 `defaults()` 自行 try/catch，取不到默认模型就表示「没有意见」）。

### 8.2 配置分层：一个设置存在哪一层

配置只有一个真相，但真相分四层；每层有唯一的存放位置与唯一的改写入口，跨层复制一份就是 bug（这一节的表与 README 的「配置分四层」是同一份语义，README 面向使用者，这里说明机制）：

| 层 | 存放位置 | 改写入口 | 机制 |
| --- | --- | --- | --- |
| **① 宿主级**：解释器怎么找、数据目录、会话默认工作区、一轮等多久 | 包内 `cordis.patch.yml` 提供默认值，profile 的 `cordis.patch.yml` 覆盖 | 编辑 profile 的 patch 文件 | `index.js` 的 `Config`（schemastery，分 `runtime` / `sessions` 两片）；**默认值只在 schema 里声明一次**，patch 只是把同一份值写成显式配置 |
| **② 通道级**：平台字段、工作区访问范围、压缩策略 | `dsh_gateway` domain 的 `channels` 表 | 设置页「IM 网关」 | `core/spec/channels.json`（字段清单）+ `channelSchema.workspaceAccess` / `sessionPolicy`；**默认值不写进配置文件**，schema 与目录决定 |
| **③ 凭据**：Token / App Secret | DSH credentials store | 设置页（创建或扫码时写入） | 通道记录只留 `secretRefs`：`DSH_GATEWAY_<大写UUID无连字符>_<大写字段名>`；页面永不回显已存值 |
| **④ 运行时数据**：托管 venv、媒体、中性会话目录 | `<dataDir>`（默认 `<DSH_HOME>/dsh-gateway`） | 插件自己 | 人只改 ① 里的 `runtime.dataDir`，不直接动里面的东西 |

两条覆盖语义上的坑，都由门禁兜住：

- **patch 是按键赋值，不做深合并**：profile 覆盖 `config` 会替换整块配置对象，所以要保留的字段必须一并写全（README 给了"整段复制再改"的做法）。`config-surface.test.mjs` 同时守住三件事：包内 patch 的键集 == schema 的键集、patch 的值 == schema 解析出的默认值、README 表里每一项都有对应行——三处是同一个面的三个视图，漂移即报错。
- **schema 会保留未知键**：把旧版的扁平配置（`pythonBin` 等 7 个顶层键）留在 patch 里，schemastery 不会报错，插件会照着默认值跑而文件上写着别的——所以 `apply()` 第一步就检查这 7 个已迁移的顶层键，命中即 `invalid_config` 并逐条指出新路径（§1 不允许静默降级）。

适配器侧对应的不变量：默认值不新增第二份（`lib/router.mjs` 只读 `config.sessions.*`，`lib/runtime.mjs` 由 `index.js` 传参），凭据不落地（§10）。

### 8.3 配置落在 profile 作用域

一个 IM 通道就是一条真实账号的长连接：它只能被一个宿主进程加载，否则两处会互相抢消息。而 DSH 的 storage 是**每个 DSH home 一套**（`dsh-storage-json` 的 root 写死 `dshHomePath('storages')`，`storage-domain` 用一个 backend 服务所有 domain），同一个 home 下的 profile 默认会读到同一份记录；`dsh-storage-json` 还把 backend 名写死成 `json`（装第二个会 `duplicate-backend`），**没有"按 domain 路由到不同根目录"这条路**。

本插件的做法是**把配置下沉到 profile 作用域，让它在存储层就分开**，插件本身保持薄封装——不做归属字段、不做跨 profile 仲裁、不做租约：

```
ctx.baseUrl                      ← cordis 把插件挂进声明那一行的树，上下文继承该树的 baseUrl
  = <DSH_HOME>/profiles/<name>/   ← 本包的行来自自己的 bundle patch，profile 层把它并进 profile 的树
  → profile token（web / web_test）→ 单元名 dsh_gateway_web / dsh_gateway_web_test
```

- **单元名即归属**：`profileScope(ctx)`（`lib/scope.mjs`）从 `ctx.baseUrl` 取 profile 目录名，`gatewayDomainName(scope)`（`lib/domain.mjs`）拼成单元名。A profile 的通道在 B profile **根本不会被加载**，所以没有任何"这条通道是谁的、要不要启动"的判断需要写——这正是"薄"的地方。这个约定**实测过**：在临时 `DSH_HOME` 里起一个干净 profile（profile 层的行与 bundle 插入的行各试一次），插件里读到的 `ctx.baseUrl` 都是 `file:///<DSH_HOME>/profiles/<name>/`，patch 里的 `!!js baseUrl` 也一致。
- **命名约束**：storage 单元名必须匹配 `^[a-z][a-z0-9_]*$`（不允许连字符），所以 profile 名里的 `-` 归一成 `_`（`web-test` → `dsh_gateway_web_test`）。同 home 下 profile 目录名互不相同，因此单元名不会撞。
- **没有 profile 身份就退回普通单元**：`ctx.baseUrl` 不是 `<…>/profiles/<name>/` 时（单元测试、手工挂的树）scope 为空，用 `dsh_gateway`——不猜一个不存在的 profile。
- **平台侧的行为不由我们仲裁**：同一账号在两处连接时，平台按自己的规则处理（QQ/飞书/钉钉"新的顶掉旧的"，微信"两边都收，重新登录才让旧 token 失效"），插件只负责**按配置只启动本 profile 的通道**。所以文档给出的规则是"一个账号只配一处，接管时先停旧宿主"（README「配置按 profile 隔离」）。**本 profile 之内**这一条进一步做成了保存路径上的判定：目录的 `identity` 让"同一账号重复提交"落到同一条通道上，而不是留下两条抢连接的记录（§2）。

## 9. 页面的形态与挂载点

**入口是一级的侧边栏条目**，不是设置页里的一节。它由这一对注册构成，键相同：

```
sidebar.panellist   { id: 'dsh-gateway', order: 20, label: () => 'IM 网关' } + 字形组件
main                { key: 'dsh-gateway' }                                    + 页面组件
```

- `sidebar.panellist` 是 `dsh-client-ui-sidebar` 声明的 root 级列表槽：壳子自己渲染行（字形 + 标签 + 选中态），点它调 `layout.selectPanel(id)`。
- `main` 是 `dsh-client-ui-layout` 声明的 root 级 keyed 槽；`MainPanel` 用 `activePanelId` 作 entryKey，所以 id 与 key 一致才会被切到。
- **归插件所有**：两条注册都写在 `client.js` 的 `apply(ctx)` 里，插件被 DSH 关掉时整份客户端半边一并卸载，条目随之消失——不是写死在宿主导航里的常驻项。`package.json` 的 `dsh.client.inject` 因此声明 `dsh-client-ui-layout` / `dsh-client-ui-sidebar`。
- **页面外壳自己带**：离开设置模态窗后没人提供标题栏、滚动区和顶部落差，所以由插件按壳子的页面约定补齐（`.dsh-gw-page` 撑满高度 + 单一内滚动、`.dsh-gw-pagecontent` 居中定宽、页头 `padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))` 给桌面外壳的窗口控件让位）。

页面内部是一页式**主从布局**，没有抽屉、没有二级路由：

```
[侧边栏 ▸ IM 网关]  →  中栏 :  ┌ 页头：IM 网关 · 一句话说明                       ┐
┌ 状态条：sidecar 运行中 · octop-gateway 版本 · 运行时 [重建运行时] [重启 sidecar] ┐
├───────────────┬──────────────────────────────────────────────────────────┤
│ 通道 5 · 启用 3 │ 右栏：平台选择器 / 通道详情 / 空态                         │
│ [+ 新建通道]    │ ┌ 头：品牌图形 · 名称（含平台）· ID · 范围 · 状态标签 · 启停 ┐ │
│ ▸ 微信-a1b2c3   │ │ 一张卡片一组配置，按影响范围从大到小：                     │ │
│ ▸ QQ-c3d4e5     │ │   连接配置 → 工作区与会话 → 群聊策略 → 消息展示 → 删除通道 │ │
│ ▸ 飞书-…        │ └──────────────────────────────────────────────────────────┘ │
└───────────────┴──────────────────────────────────────────────────────────┘
```

- **卡片的顺序是声明出来的**，不是数组顺手的副产品：目录里每组带 `order`（连接配置 10、群聊策略 30、消息展示 40），宿主侧的「工作区与会话」不是平台配置、不进 `channels.json`，由 `client.js` 以同一个 `order` 机制插在 20 位；删除卡片永远最后。原则是**按影响范围从大到小**——能不能接入 → 会话落在哪/怎么压 → 对什么消息回 → 纯展示。`client-render-smoke.mjs` 按声明顺序断言渲染结果（改一个数字就会红）。
- **每张卡片都有一句说明**：平台侧的来自目录的 `description`，连接配置那句由 sidecar 合成，宿主侧那张自带一句，四张卡读法一致。
- **不重复已知信息**：面板头的标题已经是 `<平台>-<短 id>`，所以副标题只留 `ID <短 id> · 范围`；状态条的头行已经报了运行中 sidecar 的 octop-gateway 版本，运行时行只在**探测到的版本与它不同**时才再报一次（那意味着 venv 升级过而进程还在用旧的）。
- **左栏固定单列**（196px），只放三样东西：计数、新建按钮、通道条目（品牌图形 + 名称 + `平台 · 范围` + 状态圆点）。条目带 `aria-current` 标记选中；点已选中的条目等于收起详情。
- **右栏是容器查询的宿主**（`container:dsh-gw-pane/inline-size`）。这是关键：中栏宽度减去左栏后，真正决定「字段能否排两栏」的是右栏，所以 `@container dsh-gw-pane (width<=380px/440px)` 才是折行断点；整页 ≤600px 时才把左栏折到上方（`@container dsh-gw (width<=600px)`）。媒体查询做不到这件事——窗口很宽但内容列被限定时（例如中栏 1080px 上限、或窗口被拖窄），媒体查询给出的仍是视口宽度。
- **状态分三层呈现**，各自有唯一的词：左栏圆点（已连接 / 连接中 / 已禁用 / 不受支持）、右栏头部标签（连接正常 / 未连接 / 已禁用 / 已不再支持）、通道自身的 `_running` 判据（§7）。三者同源。
- **破坏性操作就地确认**：删除按钮在「删除通道」卡片里，点击展开一条 `role=alertdialog` 确认条（说明删什么、留什么、平台侧不动），不用 `window.confirm`——系统弹窗既打断视线，也无法与卡片状态同步。
- **保存仍是脏检查驱动**：状态轮询不冲脏表单；干净表单只在服务端指纹变化时重填（外部改动）。凭据输入框永不回显：已配置时显示 `已配置 — 留空保持不变` 与「清除」，通道运行中则整块锁定并改说「通道运行中不改动，停用后可重填」（保存启用中的通道会顺带重启它，非凭据字段因此可以边跑边改）。
- **失败可恢复**：首次读取失败时出现「状态获取失败 + 重新读取」（重跑轮询 effect）；轮询用单个合并定时器，慢响应不会叠 tick。注册进插槽的组件本身是**错误边界**（类组件声明一次，不在渲染期新建类型），渲染抛错时降级为一张说明 + 「重试」卡片，不会让整个中栏变空白。
- **文案按平台归属**：`core/spec/channels.json` 里共用组的文案（`label` / `hint` / `description` / `warnWhen`）对所有平台可见，所以**不许点名平台**——点名会出现在它并不描述的那个面板上（"微信表单里出现 QQ 提示"就是这么来的）。只属于一个平台的注意事项写进该组的 `kindNotices[kind]`，页面只在那个平台的面板里渲染成一条警示；平台自己的 `blurb` / `quickConfig` / `connection` 天生只属于自己。两道门禁守这条规则：`spec-copy-scope.test.mjs` 按"这句话在哪些平台下显示"判定整份目录，`client-render-smoke.mjs` 则按场景标签自动限定平台、在**渲染产物**上再查一遍（只看面板，不看侧栏与「支持通道」状态条——那里的平台名是部署在说自己的话）。
- **平台图形是查表 + 兜底**：`LOGO_PATHS` 覆盖目录里的四个 kind（vendored，声明在 `client.js` 内），未知 kind 退化为缩写字形——目录新增平台时立即有卡片，不会留空框。

## 10. 已知边界

- 入站仅文本进入 agent；媒体经库落盘后由库侧处理（本桥不解析媒体内容）。
- 快捷扫码只在 QQ 与微信可用：库只带这两套登录流程，钉钉的扫码注册在参考产品的上层，飞书两边都没有。
- 钉钉群：会话按发言人切分、无 @ 判定、主动推送进不了群。
- 微信：没有群，也没有群策略。
- 会话用**部署默认**的 agent preset，不提供按通道选择 preset 的设置项；preset 由部署决定，插件只负责挂载它。
- 恢复一条创建期没有记录 preset 的旧会话时，插件用部署默认把它补齐，但**会话头仍然是空的**（已开始的会话不允许改绑），所以会话列表里显示的 preset 与实际挂载的可能是"无 / 默认"这一处不一致——回退不掉，只能靠新会话。
- 界面语言以中文为主，代码与标识符一律英文。
