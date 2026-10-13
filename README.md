# dsh-gateway

把 [octop-gateway](https://github.com/TencentCloud/octop-gateway) 的多平台 IM 通道桥接为 DeepSeek Harness（DSH）会话的插件 bundle。

## 形态

```
IM 平台 ── octop-gateway（Python sidecar 子进程）── NDJSON stdio ── Host 插件 ── DSH 会话
                                                                    │
侧边栏「IM 网关」页（client.js）◀── /api/dsh-gateway ───────────────┘
```

- **Host 半**（`index.js` + `lib/`）：sidecar 进程管理（崩溃退避重启、启动重放通道）、通道与路由的 storage domain（`dsh-gateway`）、凭据走 `ctx.credentials`（ref 形式，值不落 domain）、**每个通道的运行态**（`{connected, reason, detail}`，页面据此说清「连接中」还是「启动失败」）、**平台错误的可操作翻译**（`lib/errors.mjs`）、`im_list_channels` / `im_push_text` 工具、`/api/dsh-gateway` 控制面。
- **Client 半**（`client.js`）：侧边栏一级入口「IM 网关」。它由两条注册构成——`sidebar.panellist` 的行（`id: dsh-gateway`）与 `main` 的页（`key: dsh-gateway`），壳子点行切页；两条都归插件所有，插件被关掉时条目一并消失。页面外壳（标题栏、内滚动、顶部落差）由插件自己按宿主页面约定补齐。页内是一页式**主从布局**：左栏是通道列表（顶部「新建通道」），右栏是平台选择器 / 通道详情 / 空态。左栏固定单列（约 196px），右栏**自己**是容器查询的宿主（`container:dsh-gw-pane/inline-size`），所以字段两栏与平台卡片的折行按右栏宽度决定，而不是按视口宽度；整页 ≤600px 时左栏折到上方。表单**由目录驱动**：字段名、类型、必填与凭据判定全部来自 `core/spec/channels.json`，这一侧不维护第二份字段清单；连平台卡片的品牌图形也是按 kind 查表，目录里新增平台会立刻有卡片（图形缺失时退化成缩写字形）。控件复用宿主设置页的组件（Button / Input / Switch / Checkbox / Pill / SegmentedControl / Tag / StateDot），只注入一段布局样式。编辑器规则不变：脏检查控保存、状态推送不冲表单、凭据不回显、在线锁定停机字段。页面外还套了一层**错误边界**：渲染抛错时降级成一张说明 + 「重试」卡片，不会把整个中栏拖成空白。
- **sidecar**（`sidecar/dsh_gateway_sidecar.py`）：持有 `ChannelManager`，processor 把每条入站消息转发给插件、把插件回复 yield 回通道。限流/去重/typing/群策略全部留在 octop-gateway。

## 支持的通道与配置项

**只提供 4 个平台**：微信 / QQ / 飞书 / 钉钉。白名单就是 `core/spec/channels.json` 的 `kinds` 键——不在其中的平台不出现在「新建通道」的平台选择器里，已存在的记录会保留但不启动（左栏标红点、右栏标「已不再支持」，可删除）。

### 通道名与公开 id

通道的显示名**不是填出来的**，是建通道时派生出来的：`<平台名>-<6 位 id>`，例如 `微信-a1b2c3`。6 位 id 取自一个去掉易混字符的表（`23456789abcdefghjkmnpqrstuvwxyz`），在同一批通道里唯一，创建时冲突就重抽；右栏标题下方会把它单独标成 `ID a1b2c3`，`im_list_channels` 也会一并返回 `short_id`。这样同一平台挂多个通道时靠 id 区分，不必先想一个不重名的标签。

改名不作为功能提供：目录里改平台显示名只影响**新建**的通道，已有记录的 `label` 保持不变（不会被悄悄改名）。

### 一个账号只配一处

目录里每个平台声明了一个 `identity` 控件（QQ / 飞书的 `app_id`、微信的 `bot_uin`、钉钉的 `client_id`），它就是**这个账号在平台上的身份**。宿主按它判定重复：

- **重复提交（重扫二维码、手填一个已经存在的账号）不是新建**，而是更新已有那条通道：沿用它的 id、名字、工作区访问范围与压缩设置，只换凭据；提示语会说清是「已更新」而不是「已创建」。
- **编辑一条已有通道、把它的账号改成另一条通道正在用的**会被拒绝（HTTP 409，指明是哪个通道）。否则同一个登录会落在两条通道上，两边互相抢连接。
- 同平台的不同账号仍然各有各的通道（两个机器人 = 两条通道），区分依据是账号本身，不是名字。

理由：同一个 App ID / 机器人 UIN 只能有一个活着的连接——两个通道同时轮询，平台会踢掉其中一个，另一条则表现为随机「掉线」。把它做成保存路径上的判定，比让人记住这条规矩可靠。

### 通道的运行态

`/state` 里每条通道带一个 `status`：`{connected, reason, detail, updatedAt}`。`connected` 只是「现在是不是活的」，`reason` 说明为什么不是：`connecting`（已交给 sidecar，等平台就绪）、`error`（注册/启动就失败，`detail` 是平台原话的可操作版本）、`session-expired`（微信被判登录态失效）、`disabled`、`unsupported`、`unregistered`。左栏圆点按它变色（失败是红点，不是「连接中」），悬停给出原因，通道详情页顶部也会写一行。`im_list_channels` 同样返回 `connected` / `status_reason` / `status_detail`，IM 里的 agent 因此能解释某条通道为什么不说话。

**平台错误在宿主侧翻译**（`lib/errors.mjs`）：库与平台的原话照原样附在后面，前面加一句能照做的处置。例如 QQ 的 `100016 invalid appid or secret` 会显示成「凭据无效：到开放平台重新复制 App ID 与 App Secret（或重新扫码登录）后保存；沙箱与正式环境的凭据不通用（平台原话：…）」。认不出的错误原样透传，不猜、不吞。

**保存与启动是两件事**：保存接口在配置**已经写入**之后才去启动通道，启动失败时返回 `startError`（配置照旧保存），页面的提示因此是「已保存，但启动失败：…」而不是「保存失败」——不会让人去找一份其实在的配置。切换开关同理。

| 平台 | 连接配置（键名 → 界面名） | 凭据字段 |
| --- | --- | --- |
| 微信 `weixin` | `bot_uin` 机器人 UIN、`base_url` Base URL | `token` Token |
| QQ `qq` | `app_id` App ID | `secret` App Secret |
| 飞书 `feishu` | `app_id` App ID | `app_secret`、`encrypt_key`、`verification_token` |
| 钉钉 `dingtalk` | `client_id` Client ID | `client_secret` Client Secret |

键名不是随手取的：写的是 **octop-gateway 接受的键**，包含它的 `field_aliases`（钉钉的 `client_id` / `client_secret` 由库映射为 `app_key` / `app_secret`）。所以 `config` 里存的就是库真正读的名字，中间没有一层改名表。

所有平台共用的两组附加控件：

- **消息展示**：`show_thinking` 显示思考过程、`show_tool_hints` 显示工具调用提示（库的基础配置字段）。
- **群聊策略**（`group_context`）：开关 + 群消息可见范围（自动适配 / 仅 @ 消息 / @ + 最近消息 / 全部消息）+ 回复触发方式（仅被 @ 时回复 / 每条消息都回复，仅「全部消息」时可选）+ 上下文消息条数 + 回复后清空临时上下文。未暴露的 `history_ttl_seconds` 与按群覆盖 `groups` 会随整套对象保存，不会被表单抹掉。

面向人的字段名与说明、凭据地址都写在 `core/spec/channels.json`；字段默认值不写在那里，由 sidecar 从**已装** octop-gateway 的数据类读出，库升级不会让目录过期。目录与已装库不一致时（例如库改了字段名），页面顶部会显示一条黄色提示，而不是静默丢值。细节见 `core/spec/README.md`。

## 群聊支持

群聊能力按平台差得比较多，插件按实际能力裁剪设置项（微信不显示「群聊策略」，钉钉带一条提示）：

| 平台 | 群聊 | 一个 DSH 会话对应 | 「仅被 @ 时回复」 | 主动推送进群 |
| --- | --- | --- | --- | --- |
| 微信 | 不支持 | 一个用户 | — | 仅私聊 |
| QQ | 支持 | **一个群** | 有效 | 支持 |
| 飞书 | 支持 | 一个群；**带话题时一个话题** | 有效 | 支持 |
| 钉钉 | 支持 | **每个发言人** | **无效**（拿不到 @ 标记） | 进不了群，退化为该人私聊 |

- 「@ + 最近消息」「上下文消息条数」是真实生效的：不触发的群消息由库短暂缓冲，触发时由 sidecar 渲染成「群聊背景 + 当前群消息」再交给 agent；私聊没有这段内容，正文保持原样。
- 钉钉群要能收到消息，只能用「全部消息 + 每条消息都回复」。
- 架构层面的完整梳理见仓库内 `docs/architecture.md`。

## 新增通道的两种方式

新增通道先选平台（一张卡片一个平台，带一句该平台怎么配的说明），选完才展开字段。「快捷配置（扫码）」与「手动填写」两档在有扫码流程的平台里可选；有扫码流程的平台默认落在扫码那档。

| 平台 | 快捷配置（扫码） | 手动填写 |
| --- | --- | --- |
| 微信 | 微信扫码 → 手机上确认登录 → **直接创建通道**（唯一方式，无需手填） | — |
| QQ | 手机 QQ 扫码 → 手机上确认 → 取回 App ID / App Secret，确认后创建 | 手填 App ID + App Secret |
| 飞书 | — | 手填，附「前往获取凭据」链接 |
| 钉钉 | — | 手填，附「前往获取凭据」链接 |

只有 octop-gateway 自带扫码流程的平台才有快捷档：它带 QQ 与微信两套，钉钉的扫码注册在参考产品的上层、飞书两边都没有。

- **微信是「仅扫码」**：新建时不提供手动填写，连接字段也不出现；扫码确认后插件**立即创建通道**，名字由宿主派生为「微信-<6 位 id>」——页面不发送名字，所以也不存在「扫码前先起名」这一步。通道建好之后仍可正常编辑手动修正。
- **QQ 是「扫码或手填」**：扫码只是把凭据取回来填进草稿，仍要点「创建」才落库；也可以全程手填。
- 两档都走**同一条保存路径**写入凭据库，凭据写入只有一个入口；扫描到的值在创建前只存在于页面草稿里，不进 domain。

二维码在页面上始终是白底黑码的固定配色（扫码由相机识别，不跟随明暗主题），过期会提示重新生成。

## 会话模型

- 路由键 `${channelId}:${subjectId}`；subject 即会话目标（私聊=用户，群=会话 ID）。
- **工作区访问范围**：每个通道有一个权限范围，而不是一个写死的工作区。`所有工作区`（默认）= 不限制，会话默认落在 `<dataDir>/workspace` 这个中性目录、**不进任何工作区**，`/workspace` 可以切到任意已注册工作区；`指定工作区` = 白名单，会话默认落在**第一个仍在注册表里的**选中工作区，`/workspace` 只能在这个列表内切换。中性目录**不注册成工作区**，所以不限范围的会话落在侧边栏「未分组」（插件不替用户创建任何工作区）。
- 落在某个工作区里的会话在建好后调用 `workspaceRegistry.attachSession(sessionId)`，与 GUI 建会话走同一套归属登记。
- 范围收窄会**即时生效**：路由上如果留着一个现在越界的 `/workspace` 覆盖，下一次建会话会丢弃它（记一条 warn），不能让旧覆盖绕过新范围。清单里已经不存在的路径不会消失，右栏显示成「已不在已注册的工作区里」并给一个「移除」，以免静默丢配置。
- **模型**：插件不选、不写默认模型。普通会话像 GUI 新建会话一样跟随 DSH 的当前默认选择（模型选择器每次选中的模型会被 DSH 自己持久化为默认）；只有用户显式发过 `/model <x>` 时才 pin 该覆盖。
- **上下文压缩（就地）**：turn 静默后按 `tokenMeter` 水位（默认 80%）判断，越线就调用**这个会话自己的压缩引擎**把历史就地压掉，**会话继续，不换新会话**。压多少、保留什么、怎么摘要全部由宿主的压缩策略决定，插件只决定「什么时候压」。宿主自己的按步压缩（DSH 默认 `compaction-basic` 的 `thresholdRatio`）照常运行，两者都只是减少同一份历史。
- **压缩引擎按会话取**：DSH 可以把压缩服务装在宿主平面（acp / headless 就是这样），也可以把它关在**每个 agent preset 自己的隔离域**里（Web profile 的装配），后者只有拿得到那个会话的 agent 才读得到。插件因此从**会话所属的 agent** 反查（`agentPresets.serviceFor(agent, 'compaction')`），取不到才回落到宿主平面；两处都没有时压缩不生效，但插件照常工作。
- **会话按 agent preset 组成**：插件建会话时和 GUI 建会话走同一套组合——解析部署默认的 agent preset、把它记进会话（`meta.agentPreset`，持久，恢复会话时按它重新挂载）、在 agent 的 setup 里挂载它。DSH 在 Web profile 里把**工具、技能、压缩**整体挪进了 agent preset，不挂 preset 的会话拿不到这些。恢复一条更早的、没有记录 preset 的会话时，用部署默认把它补齐（已开始的会话无法事后改绑，这里是唯一的补救点）。preset 不可用（被禁用 / 激活失败）时插件**不以会话失败收场**：记一条 warn，会话按宿主平面组成（等于旧行为），IM 不断线。
- **换会话只由命令触发**：只有 `/new`、`/model`、`/workspace` 会开启新会话；上下文压力**不再**触发换会话。
- **不注入任何 prompt / 人设**：入站文本原样作为 user message 提交，系统提示一律由 DSH 自身装配。

## 内置路由命令

IM 里直接发（由插件应答，不消耗 agent turn）：

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令一览 |
| `/new` | 下一条消息开启新会话（当前会话保留） |
| `/compact` | 立即就地压缩当前会话历史，会话继续 |
| `/model` | 查看当前会话模型（含上次压缩信息） |
| `/model list` | 按 provider 分组编号列出可用模型 |
| `/model <序号\|模型ID>` | 切换模型（下一条消息开新会话） |
| `/model default` | 清除覆盖，回到跟随 DSH 默认选择 |
| `/workspace` | 列出**这个通道可以用的**工作区（带序号与当前标记） |
| `/workspace <序号\|名称>` | 切换工作区（下一条消息开新会话） |
| `/workspace default` | 清除覆盖，回到通道默认位置 |

`/model list` 与 DSH 模型选择器同源（`llm.listProviders()` × `llm.listModels()`），空目录的 provider（例如被 `models: []` 屏蔽的官方模型）会自动消失。

`/compact` 与自动压缩走同一条接口（同一条「按会话取引擎」的路径），区别只是**何时**调用；这个会话所属的 preset 和宿主平面都没有压缩服务时，它会明确回一句「没有装配压缩服务」，而不是静默失败。页面上的「上下文压缩」开关与阈值就是自动那一路的入口，卡片里会写明这个部署的引擎是在宿主平面还是在 agent preset 里。

`/model <x>` 与 `/workspace <n>` **不需要先有会话**：还没有会话时它们会把选择记在这条路由上，第一条消息就按它建会话（回复会说明「已记录……第一条消息就会…」）。这条选择会落盘，重启后依然有效。

## 安装与配置

```bash
dsh plugin --profile <name> add /path/to/dsh-gateway
```

装完即用：插件的 Python 运行时自己解决，不需要你先准备虚拟环境。

### 配置分四层

改之前先认准它在哪一层——四层各有唯一的存放位置和唯一的改写入口：

| 层 | 存在哪 | 谁改 | 里面是什么 |
| --- | --- | --- | --- |
| **① 宿主级插件配置** | profile 的 `cordis.patch.yml` 覆盖包内 `cordis.patch.yml` 的默认值 | 编辑文件 | 解释器怎么找、数据目录、会话默认工作区、一轮等多久 |
| **② 通道级配置** | **本 profile 自己的存储单元** `<DSH_HOME>/storages/dsh_gateway_<profile>.json`（平台字段 + `workspaceAccess` + `sessionPolicy`） | 「IM 网关」页面 | 每个平台自己的字段、工作区访问范围、上下文压缩 |
| **③ 凭据** | DSH credentials store（通道记录里只留 ref） | 「IM 网关」页面（创建或扫码时写入，页面永不回显） | Token / App Secret 等 |
| **④ 运行时数据** | `<dataDir>`（默认 `<DSH_HOME>/dsh-gateway`） | 插件自己 | 托管 venv、媒体、未绑定通道的中性会话目录 |

②③ 的默认值由代码与本包目录（`core/spec/channels.json`）决定，**不在配置文件里重复一遍**；④ 由插件管理，人只改它上级的 `<dataDir>`。① 的字段在下面。

### 宿主级配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `runtime.pythonBin` | 空 | 显式指定解释器；非空 = 只用它，跳过全部探测与自动安装 |
| `runtime.pythonRuntime` | `auto` | `auto` = 探测（包内 `.venv` → `python3`/`python`）→ 没有就自举；`system` = 只探测不安装；`managed` = 只用 `<dataDir>/runtime/venv` |
| `runtime.pipIndexUrl` | 空 | 托管 venv 安装时的包源（内网镜像用），只在安装时用 |
| `runtime.gatewayVersion` | 空 | 托管 venv 里 `octop-gateway` 的版本后缀，如 `==1.0.0`（空 = 最新），只在安装时用 |
| `runtime.dataDir` | 空 | 数据目录：托管运行时、媒体、中性会话目录 `<dataDir>/workspace` 都在其下；空 = `<DSH_HOME>/dsh-gateway`（默认 DSH home 时即 `~/.dsh/dsh-gateway`） |
| `sessions.defaultWorkspacePath` | 空 | 「所有工作区」范围且没有 `/workspace` 覆盖时的默认工作区；空 = 不绑定 → 会话跑在 `<dataDir>/workspace` 且不进任何工作区（侧边栏「未分组」） |
| `sessions.replyTimeoutSec` | 240 | 等一轮 turn 落定的上限（秒），下限 30 |

**怎么覆盖**：宿主 patch 是**按键赋值**，不做深合并——覆盖 `config` 会把整块配置换掉，所以要保留的字段得一并写全。最省事的做法是把包内 `cordis.patch.yml` 的 `config:` 块整段复制到 profile 的 `cordis.patch.yml`（`- id: dsh-gateway` + `config:` 两层都要），再改你关心的值。

这三处（包内 `cordis.patch.yml`、`index.js` 的 `Config` schema、本表）是同一个面的三个视图，`config-surface.test.mjs` 在它们漂移时报错。旧版本把这几项摊在顶层；摊平的写法现在会**响亮失败**（`invalid_config` 并逐条指出新路径），不会被静默忽略。

### Python 运行时怎么来的

sidecar 是 Python 程序，npm 只能把脚本装到位；解释器和 `octop-gateway` 依赖在 Python 自己的生态里，插件把这步自动化了，默认（`runtime` 全部留空）的行为是：

1. **按顺序探测**：包内 `.venv/bin/python`（开发检出场景）→ PATH 上的 `python3` / `python`。谁先能 `import octop_gateway` 就用谁，尊重你已有的环境；`runtime.pythonBin` 一填就跳过整段探测。
2. **都没有就自举**：在 `<dataDir>/runtime/venv` 建托管 venv 并装上 `octop-gateway`（PATH 上有 `uv` 就用 uv，否则 `python3 -m venv` + pip；跨进程用锁避免两个 profile 同时装）。`runtime.pythonRuntime: system` 可以关掉这一步。
3. **不阻塞宿主启动**：解析/安装跑在 sidecar 启动路径上，宿主启动不被拖慢；首次安装可能花一两分钟，页面会显示进度阶段，失败则显示原因并退避重试。

页面顶部的状态条会显示当前运行时（来源 · Python 版本）与这个部署支持的平台，右侧两个按钮：「重建运行时」（重新探测解释器并重建托管 venv，用于修坏环境）与「重启 sidecar」（只重启 Python 进程，不动运行时）。

### 部署形态：装配顺序与覆盖点

一个 profile 的插件条目是这样叠出来的（由外到内，后者覆盖前者）：

```
profile 的 package.json: dsh.profile.bundles  →  每个 bundle 自带的 cordis.patch.yml
       →  ~/.dsh/profiles/<name>/cordis.patch.yml  →  ~/.dsh/cordis.patch.yml（全局，所有 profile 继承）
       →  命令行 --patch 叠加
```

所以本插件的生效配置 = **包内 `cordis.patch.yml` 的默认值**，除非 profile 层显式覆盖（覆盖写法见上一节）。核对生效值用 `dsh --profile <name> --dump-config`：它把各层合成后的条目表打出来（顺带重写 profile 下的 `cordis.yml`，那是合成产物，不要去手改，要改的是 `cordis.patch.yml`）。

数据目录默认落在 **`<DSH_HOME>/dsh-gateway`**（与 `storages/`、`sessions/` 同一层级，按 DSH home 走，不按 profile），所以同一台机器上多个 profile 共用一个托管 venv、一份媒体与中性会话目录——venv 的安装有跨进程锁，不会互相踩。

### 配置按 profile 隔离

通道配置属于**配置它的那个 profile**：每个 profile 打开自己的存储单元 `<DSH_HOME>/storages/dsh_gateway_<profile>.json`（profile 名里的 `-` 写成 `_`，例如 `web-test` → `dsh_gateway_web_test.json`），所以 A profile 配的通道在 B profile 里**根本不会被加载**，更不会去接管同一个 IM 账号；装了本插件的另一个 profile 默认看到的是空列表。插件在这里只做**薄薄一层**：把配置按 profile 分开、把平台事件翻译成 DSH 会话，跨 profile 的协调交给"一处一配"这个前提，而不是自己造租约或归属仲裁。

据此，「一机多 profile」的规则是：

- 两个 profile 可以各管各的通道（哪怕同时开着）——它们读写的是不同的存储单元；
- **同一个 IM 账号不要在两个 profile 里各配一次**。平台侧对"同一机器人被两处连接"的处理是**平台自己的规则**，我们改不了，而且各平台表现不同：
  - QQ / 飞书 / 钉钉是**有握手的连接**（QQ 的 WS `session_id`、飞书的 `bot/v3/info` + WS endpoint、钉钉的 stream `ticket`）：平台按"一个账号一条有效连接"处理，新的那条会把旧的挤掉，旧的那处**收不到消息**（QQ 收到 op=9 `INVALID_SESSION`、飞书/钉钉 WS 断开）；
  - **微信没有握手**（HTTP 长轮询 + 客户端游标）：两个进程用同一份 token 更可能是**两边都收**，只有重新扫码登录才会让旧 token 失效（`errcode -14`，库的处置是暂停轮询并要求重新扫码）。
  - 因为双方都不会主动退让（库没有"发现另一处在线就退出"的逻辑），两处同时跑会表现成**忽有忽无 / 互相踢的拉锯**。所以接管或迁移通道时，正确做法是**先把旧宿主停掉或先在旧那边停用通道**，再在别处配置。
- 要确认当前有几个 sidecar 在跑：

```bash
pgrep -af dsh_gateway_sidecar.py
```

- DSH 自己的 `sessions/`、`storages/`（工作区等）与凭据库，以及本插件的运行时数据目录（托管 venv / 媒体 / 中性会话目录）都按 DSH home 共享——**托管 venv 共享是有意的**（省一份安装，安装有跨进程锁）。要让运行时数据也按 profile 分家，就在 profile 的 patch 里把它指到 profile 目录：

  ```yaml
  - id: dsh-gateway
    name: '@slothtron/dsh-gateway'
    config:
      runtime:
        dataDir: !!js new URL('dsh-gateway', baseUrl).pathname   # baseUrl = 本 profile 目录
      sessions:
        defaultWorkspacePath: ''
        replyTimeoutSec: 240
  ```

  代价是每个 profile 各装一份托管 venv（首次一两分钟）。
- **通道绑定的标识**取 profile 目录名（`-` 写成 `_`）。profile 目录改名后，旧单元就没人读了：把 `dsh_gateway_<旧名>.json` 复制成 `dsh_gateway_<新名>.json` 即可继续用。（同理：如果有过把配置写在全局 `dsh_gateway.json` 的版本，复制成当前 profile 的单元名即可。）

## 验收（A1–A6）

- A1 `install_bundle` 后 `application: applied`，工具目录见 `im_list_channels` / `im_push_text`
- A2 侧边栏出现一级条目「IM 网关」，点开是中栏页面（明暗主题正常）；插件被停用后该条目消失
- A3 一步表单新建通道 + 测试连接（凭据只进 credentials store）
- A4 实通道消息 → 新 DSH 会话（工作区分组）→ IM 收到回复
- A5 压缩阈值调低后演示**就地压缩**（同一会话继续、会话日志出现 `compaction/summary`）；`/new` 演示手动换会话（第 2 段）
- A6 编辑器规则抽查（脏检查 / 不重填 / 凭据不回显 / 在线锁定）

## 边界（v1）

- 入站仅文本；媒体到文本标记（v2 落地）。
- 流式 DELTA 未接（回复为整段 MESSAGE；v2 接 `agent/assistant-stream`）。
- 复杂结构配置字段（如 weixin 多账号）暂不支持表单编辑。
- 修改 kind / 凭据需先停用通道（停机字段在线锁定）。
