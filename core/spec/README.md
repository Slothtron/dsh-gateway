# core/spec —— 语言中立的通道契约

本目录是 dsh-gateway 的**契约层**：通道能力的声明在这里，不由任何一侧实现裁定。

## `channels.json`

一份声明式目录，两侧都读它：

- **Python sidecar**（`sidecar/dsh_gateway_sidecar.py`）：按它裁剪 `introspect` 的输出，即页面能选哪些平台、每个平台显示哪些控件；并在启动时用它对照已装 octop-gateway 做漂移检查。
- **浏览器半边**（`client.js`）：按它渲染表单（`text` / `password` / `switch` / `number` / `segmented`）、新建通道的平台卡片与卡片样式，自己**不带**字段清单、标签表或凭据判定。平台卡片上的品牌图形按 `kind` 查表、查不到退化为缩写字形。

### 字段含义

顶层：

| 键 | 含义 |
| --- | --- |
| `kinds` | 提供的平台集合。**键即白名单**：不在这里的平台不会出现在新建选择器里，已存在的记录会被保留但不再启动 |
| `groups` | 所有平台共用的附加控件组（消息展示、群聊策略） |

每个平台：

| 键 | 含义 |
| --- | --- |
| `label` | 中文显示名。**只用于新建**：通道的 `label` 在创建时就固化成 `<label>-<6 位 id>`，之后目录改名不会追溯已有记录 |
| `blurb` | 平台卡片上的一句话说明（这个平台怎么配，与宿主无关） |
| `color` | 品牌色，页面用它给平台图形着色 |
| `credentialUrl` | 「前往获取凭据」的跳转地址 |
| `identity` | 哪个控件承载**账号标识**（平台侧的应用/机器人 id：QQ 与飞书的 `app_id`、微信的 `bot_uin`、钉钉的 `client_id`）。宿主按键值判定"这个账号已经配过了"，同一账号不会被建成第二个通道；不写则这个平台不做这种合并 |
| `connection` | 该平台连接配置的控件清单 |
| `fixed` | 保存时强制写入的值（平台必须开的开关） |
| `acceptsExtraKeys` | 数据类没声明、但该平台 `from_dict` 确实接受的键（微信的单账号扁平写法） |

每个控件：

| 键 | 含义 |
| --- | --- |
| `name` | 写入 `config` 的键名。取 octop-gateway 接受的写法，含它的 `field_aliases`（钉钉用 `client_id` → `app_key`） |
| `label` | 面向人的字段名 |
| `type` | `text` / `password` / `switch` / `number` / `segmented` |
| `secret` | 真为凭据：值只进 DSH credentials store，`config` 里只留 ref |
| `required` | 表单标 `*` 并参与保存前检查。**判定权在 octop-gateway**：它按 `required_credentials` 抛错 |
| `placeholder` / `hint` | 输入提示与说明 |
| `visibleWhen` / `disabledWhen` / `disabledUnless` | 同组内按其他控件取值决定显示与禁用 |
| `warnWhen` | 命中该取值时给出的警示文案 |
| `default` | **不在文件里**：由 sidecar 从已装数据类的默认值读出，写入 introspect 结果 |

### 控件组（`groups`）

顶层 `groups` 是追加给各平台的控件组，sidecar 按平台裁剪后再交给页面：

| 键 | 含义 |
| --- | --- |
| `id` / `title` / `description` | 组的标识、标题与一句话说明（页面每张卡片都有一句说明，读法一致） |
| `order` | 卡片在设置页上的位置，数字小的在上。当前：10 连接配置（sidecar 合成）、20 工作区与会话（宿主侧，不进本文件）、30 群聊策略、40 消息展示；原则是**按影响范围从大到小**——接入 → 会话归属 → 平台行为 → 展示，删除操作永远最后 |
| `path` | 组内控件的取值落在 `config` 的这个子对象里（群聊策略 → `group_context`）；不写则落在 `config` 顶层 |
| `kinds` | 这组控件适用的平台。**不写 = 所有平台**；某平台根本做不到的事（微信没有群）整组不出现，而不是出现却无效 |
| `kindNotices` | `{kind: 文案}`：只在该平台的面板里多显示一条警示 |
| `controls` | 控件清单，键的含义与上表相同 |

**文案的作用域规则**：一句话里只要有平台名，就只能放在**只属于那个平台**的位置——该平台的 `blurb` / `quickConfig` / `connection`，或 `kindNotices[那个平台]`。写进共用组的 `label` / `hint` / `description` 里，它会同时出现在另外几个平台上（"微信表单里出现 QQ 提示"就是这么来的）。`comment` 不受这条规则约束：它是给人看的备注，页面不渲染。两个门禁机械执行这条规则：`spec-copy-scope.test.mjs` 查整份目录，`client-render-smoke.mjs` 在渲染出的面板上再查一遍。

### 不放进本文件的东西

- **字段默认值**：一律从已装 octop-gateway 的数据类读取，版本升级不会让文件里的默认值过期。
- **平台私有字段清单的原始形态**：`connection` 是**暴露面**，可以比数据类字段少（QQ 的流式调参、`sandbox`、`intents` 等不暴露，由库默认值兜住）。
- **`group_context` 里不暴露的键**（`history`、`history_ttl_seconds`、`groups`）：它们不进表单，但会随整套 `group_context` 对象一起保存，不会被抹掉。
- **通道的名字与公开 id**：不是配置项，由宿主在工作区/通道创建时派生（`<label>-<6 位 id>`），页面不发送也不渲染成可编辑字段。**名字不承担唯一性**：同平台可以有多份通道（两个机器人），唯一的判据是 `identity` 指向的那个账号。
- **工作区访问范围**：宿主侧的能力（`all` / `selected` 白名单），与平台无关，所以不在 `channels.json` 里。

### 漂移检查

sidecar 每次 `introspect` 都会核对：`kinds` 里的平台在已装 octop-gateway 里存在、每个控件的 `name` 被该平台接受。不一致时：

- 记一条 `logger.warning`；
- 把问题列表放进 `introspect` 的 `drift` 字段；
- 宿主转发到 `GET /api/dsh-gateway/state` 的 `drift`，页面以黄色提示条显示。

这样"库改了字段名"会立刻可见，而不是静默丢值。
