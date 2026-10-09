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
# 1. Python 环境：sidecar 需要已安装 octop-gateway 的解释器
cd <package>
uv venv .venv && uv pip install -e /path/to/octop-gateway   # 或 pip install octop-gateway

# 2. 安装到某个 profile
dsh plugin --profile <name> add /path/to/dsh-gateway
```

配置项（profile patch 覆盖，见 `cordis.patch.yml`）：`pythonBin`（空 = 包内 `.venv/bin/python`，再退 `python3`）、`dataDir`、`defaultWorkspacePath`、`replyTimeoutSec`。

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
