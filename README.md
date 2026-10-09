# dsh-gateway

把 [octop-gateway](https://github.com/TencentCloud/octop-gateway) 的多平台 IM 通道桥接为 DeepSeek Harness（DSH）会话的插件 bundle。

## 形态

```
IM 平台 ── octop-gateway（Python sidecar 子进程）── NDJSON stdio ── Host 插件 ── DSH 会话
                                                                    │
设置页（settings.section「IM 网关」）◀── /api/dsh-gateway ──────────┘
```

- **Host 半**（`index.js` + `lib/`）：sidecar 进程管理（崩溃退避重启、启动重放通道）、通道与路由的 storage domain（`dsh-gateway`）、凭据走 `ctx.credentials`（ref 形式，值不落 domain）、`im_list_channels` / `im_push_text` 工具、`/api/dsh-gateway` 控制面。
- **Client 半**（`client.js`）：设置页。通道列表 + 常驻编辑器（脏检查控保存、状态推送不冲表单、凭据不回显、在线锁定停机字段）+ 一步式新增通道表单（WorkBuddy 口径）+ 测试连接。
- **sidecar**（`sidecar/dsh_gateway_sidecar.py`）：持有 `ChannelManager`，processor 把每条入站消息转发给插件、把插件回复 yield 回通道。限流/去重/typing/群策略全部留在 octop-gateway。

## 会话模型

- 路由键 `${channelId}:${subjectId}`；subject 即会话目标（私聊=用户，群=会话 ID）。
- **工作区**：只有显式绑定才算绑定——通道选「指定工作区」（`pinned`）或部署级 `defaultWorkspacePath`。未绑定的通道跑在 `<dataDir>/workspace` 这个中性目录里，该目录**不注册成工作区**，会话因此落在侧边栏「未分组」（插件不替用户创建任何工作区）。
- 绑定过的会话在建好后调用 `workspaceRegistry.attachSession(sessionId)`，与 GUI 建会话走同一套归属登记。
- **模型**：插件不选、不写默认模型。普通会话像 GUI 新建会话一样跟随 DSH 的当前默认选择（模型选择器每次选中的模型会被 DSH 自己持久化为默认）；只有用户显式发过 `/model <x>` 时才 pin 该覆盖。
- **上下文轮换**：turn 静默后按 `tokenMeter` 水位（默认 80%）标记可轮换，下一条消息创建新会话（同工作区、generation+1），旧会话保留。
- **不注入任何 prompt / 人设**：入站文本原样作为 user message 提交，系统提示一律由 DSH 自身装配。

## 内置路由命令

IM 里直接发（由插件应答，不消耗 agent turn）：

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令一览 |
| `/model` | 查看当前会话模型 |
| `/model list` | 按 provider 分组编号列出可用模型 |
| `/model <序号\|模型ID>` | 切换模型（下一条消息开新会话） |
| `/model default` | 清除覆盖，回到跟随 DSH 默认选择 |
| `/workspace` | 列出已注册工作区（带序号与当前标记） |
| `/workspace <序号>` | 绑定工作区（下一条消息开新会话） |
| `/workspace default` | 清除绑定（未绑定通道的会话归入「未分组」） |

`/model list` 与 DSH 模型选择器同源（`llm.listProviders()` × `llm.listModels()`），空目录的 provider（例如被 `models: []` 屏蔽的官方模型）会自动消失。

## 安装与配置

```bash
dsh plugin --profile <name> add /path/to/dsh-gateway
```

装完即用：插件的 Python 运行时自己解决，不需要你先准备虚拟环境。

### Python 运行时怎么来的

sidecar 是 Python 程序，npm 只能把脚本装到位；解释器和 `octop-gateway` 依赖在 Python 自己的生态里，插件把这步自动化了：

1. **按顺序探测**：`config.pythonBin`（显式）→ 包内 `.venv/bin/python`（开发检出场景）→ PATH 上的 `python3` / `python` → 托管 venv。谁先能 `import octop_gateway` 就用谁，尊重你已有的环境。
2. **都没有就自举**：在 `<dataDir>/runtime/venv` 建托管 venv 并装上 `octop-gateway`（PATH 上有 `uv` 就用 uv，否则 `python3 -m venv` + pip；跨进程用锁避免两个 profile 同时装）。
3. **不阻塞宿主启动**：解析/安装跑在 sidecar 启动路径上，宿主启动不被拖慢；首次安装可能花一两分钟，设置页会显示进度阶段，失败则显示原因并退避重试。

设置页「IM 网关」顶部会显示当前运行时（来源 · Python 版本 · octop-gateway 版本），并有「初始化运行时」按钮（重新探测 + 重建托管 venv，用于修复坏环境）。

配置项（profile patch 覆盖，见 `cordis.patch.yml`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `pythonBin` | 空 | 显式指定解释器，跳过全部探测与自动安装 |
| `pythonRuntime` | `auto` | `auto` = 能用就用、没有就自举；`system` = 只探测不安装；`managed` = 只用托管 venv |
| `pipIndexUrl` | 空 | 托管 venv 的包源（内网镜像用） |
| `gatewayVersion` | 空 | 安装 `octop-gateway` 的版本后缀，如 `==1.0.0`（空 = 最新） |
| `dataDir` | `~/.dsh/dsh-gateway` | 数据目录（托管运行时也在其下） |
| `defaultWorkspacePath` | 空 | 未绑定通道的工作区；空 = 未绑定 → 会话进「未分组」 |
| `replyTimeoutSec` | 240 | 等一轮 turn 的上限（秒） |

通道凭据不写进任何配置文件：设置页提交后存入 DSH credentials store，domain 只保存 ref。

### 跑在哪个 profile（重要）

sidecar 生命周期跟 dsh 进程绑定，**同一台机器只应有一个 profile 装本插件**（`~/.dsh/storages/` 与 `~/.dsh/sessions/` 是按 DSH home 共享的，装两份会重复接管同一通道）。

而工作区注册表是**每进程内存态**（`dsh-storage-json` 不 watch 文件，`domain/changed` 只在写进程内广播），所以：

- 桥接进程与 GUI 进程**同 profile** 时，桥接新建/绑定的会话会实时出现在侧边栏（同一进程内的事件）；
- 若桥接跑在 A profile、GUI 跑在 B profile，B 的侧边栏看不到 A 侧新建的工作区与会话（且 A 写 workspace.json 会整文件覆盖 B 的写入），要重启 B 才看得到。

## 验收（A1–A6）

- A1 `install_bundle` 后 `application: applied`，工具目录见 `im_list_channels` / `im_push_text`
- A2 设置面板出现「IM 网关」页（明暗主题正常）
- A3 一步表单新建通道 + 测试连接（凭据只进 credentials store）
- A4 实通道消息 → 新 DSH 会话（工作区分组）→ IM 收到回复
- A5 水位阈值调低后演示轮换（同工作区第 2 段会话）
- A6 编辑器规则抽查（脏检查 / 不重填 / 凭据不回显 / 在线锁定）

## 边界（v1）

- 入站仅文本；媒体到文本标记（v2 落地）。
- 流式 DELTA 未接（回复为整段 MESSAGE；v2 接 `agent/assistant-stream`）。
- 复杂结构配置字段（如 weixin 多账号）暂不支持表单编辑。
- 修改 kind / 凭据需先停用通道（停机字段在线锁定）。
