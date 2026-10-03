# agent-base

valuz-agent 的 Node.js 重写：后端不再有 Python，架构从 local-first 改为 **cloud-first + 团队协作**。

- 云端服务器（PostgreSQL + Redis）是唯一的数据源：组织、成员、资源库、会话、消息、事件都在云端。
- 桌面端是一个**执行节点**：把本机链接到服务器，在本机跑智能体会话，可以共享给组织或指定成员，被授权的人可以远程控制它。
- 智能体、技能、连接器、模型渠道、项目、文件都是可共享的组织资源；文件存到组织自己配置的对象存储。

## 结构

```
packages/protocol   领域类型 + 设备链路线协议（zod）
packages/kernel     内核：Session / Message / Event、编排器、三个运行时
apps/server         部署服务端：Fastify + PostgreSQL + Redis
apps/host           桌面宿主进程（取代 PyInstaller 打包的 valuz-server sidecar）
apps/web            Web 界面（React + Vite），建立在 @valuz/ui 之上；服务端直接托管其构建产物
apps/desktop        Electron 桌面壳：加载服务器上的界面，并监管本机的 agent-base-host
frontend/packages   从 valuz-agent 原样搬来的设计系统：@valuz/ui、@valuz/shared、@valuz/a2ui
deploy/             Dockerfile、生产 compose、开发用 PG/Redis
```

```
 浏览器 / 桌面 UI ──HTTP + SSE──┐
                               ▼
                    ┌──────────────────────┐      ┌────────────┐
                    │  server（可多副本）    │◀────▶│ PostgreSQL │ 数据源
                    │  鉴权 · ACL · 审计     │      └────────────┘
                    │  设备中枢 · 事件扇出    │◀────▶ Redis：事件 pub/sub、设备在线、
                    └──────────▲───────────┘        跨副本 RPC 中继、refresh token
                               │ WebSocket 设备链路（RPC 下行，状态上行，至少一次 + 去重）
                    ┌──────────┴───────────┐
                    │  host（每台桌面一个）   │  内核 + 运行时在这里执行
                    │  本机策略：共享目录     │  Claude Agent SDK / Codex SDK / 原生 Valuz Agent
                    └──────────────────────┘
```

## 运行时

| runtime | 实现 | 模型协议 |
|---|---|---|
| `claude_agent` | `@anthropic-ai/claude-agent-sdk` | anthropic |
| `codex` | `@openai/codex-sdk` | openai_response |
| `valuz_agent` | 原生 Node 工具循环（取代 DeepAgents + LangChain），内置文件/搜索/shell/todo 工具 + MCP，JSON 检查点，自动压缩 | openai_completion |

Python 版导出的 `deepagents` 行按 `valuz_agent` 执行。

## 协作与权限

每个资源归属一个成员，**默认私有**。共享走同一条权限阶梯，可授予 组织 / 团队 / 个人：

| 级别 | 含义 |
|---|---|
| `view` | 可见（可旁观会话） |
| `use` | 可引用：运行智能体、装备技能、通过模型渠道调用、在设备上开会话 |
| `edit` | 可修改定义；对项目是"可驱动项目内的会话" |
| `control` | 远程控制：驱动设备上任意会话、浏览共享目录、执行命令 |
| `admin` | 再共享与删除（所有者和组织 owner/admin 恒有） |

远程控制有两道闸：

1. **服务端 ACL**：没有 `control` 的人拿不到设备；看不到的资源一律 404。
2. **设备本机策略**（服务器无法覆盖）：非设备所有者只能进入所有者用 `share add` 明确共享的目录（解析符号链接后判断），远程命令默认关闭（`share exec on` 才开）。

每一次远程控制动作（读写文件、执行命令、代发消息、审批）都写入审计日志，带操作者。

## 任务（lead / member 多智能体编排）

任务的编排逻辑在服务端：计划 DAG、邮箱、时间线都在 PostgreSQL。lead 会话在任意设备、任意运行时上执行，通过服务端的 MCP 端点调用任务工具（`plan_task` `dispatch` `await_members` `review_subtask` `finish_task` 等）；成员只管干活，最后一条消息就是它的汇报。

- 计划是带依赖的 DAG；节点状态转移和任务状态机都有表驱动的校验，`done` 不可回退，没有任何路径能写入 `failed`（失败一律停在 `rework`，可重新派发）。
- 返工直接回到原来的成员会话，保留它的上下文。
- lead 结束回合但任务没做完、也没有成员在跑时，会被提醒两次；仍不推进则任务标记为“受阻”，而不是无声地挂着。
- 人可以暂停、恢复、停止任务，或给 lead 留言；已完成的任务可以重新打开。

## 定时自动化

让项目里的某个智能体按 cron 计划运行一条指令。调度由 BullMQ 承担（Redis 上的 job scheduler），多副本部署时每个时刻只触发一次。

## 知识库

文件上传到云存储后在服务端后台解析（BullMQ 队列），解析用 `officeparser`（PDF / Word / Excel / PPT / ODF）和纯文本直读，切块用 `@langchain/textsplitters`，检索用 PostgreSQL 的 `pg_trgm`（中文无空格的问句也能命中）。文档分两种范围：某个项目的知识库，和全组织可见的组织知识库。范围内有文档的会话会自动获得 `docs` 工具，并且只能读到自己范围内的文档。

没有做的：OCR（扫描件会明确报“未能提取文本”）、向量检索、文件夹自动发现与重扫、引用溯源。

## 飞书渠道

把一个飞书机器人绑定到项目里的某个智能体：私聊机器人、或在群里 @ 它，就是在和这个智能体对话；每个聊天对应一个会话，回答发回原聊天，发 `/new` 开新会话。飞书侧（令牌、长连接、事件解密、发消息）用官方 SDK `@larksuiteoapi/node-sdk`。接收事件有两种方式：

- **长连接**（默认）：服务器用 SDK 的 `WSClient` 主动连到飞书，不需要公网回调地址。渠道的创建、启停、删除会同步到所有副本；多副本时飞书把每个事件只投给其中一条连接，另有按事件 ID 的去重兜底。
- **HTTP 回调**：飞书调用本服务器的公网地址。事件的真实性校验是强制的：配了 Encrypt Key 就验签并解密，否则校验 Verification Token；两者都不配的回调渠道不允许创建。

**验证范围**：自动化测试对着一个本地的假开放平台跑。HTTP 回调验证了整条链路（地址校验、伪造请求拒绝、重复投递去重、群聊 @、加密 + 验签、回复发回聊天）。长连接验证了连接的生命周期（用应用凭据申请接入点并建立连接，停用时断开，启用时重连，删除时断开）；经长连接收到一条真实消息事件这一步没有覆盖——那需要飞书的二进制帧协议，只能用真实应用验证。两种方式都没有用真实的飞书应用联调过。只支持文本消息；企业微信尚未实现。

## 桌面端

`apps/desktop` 是 Electron 壳，取代 valuz-agent 的 "Electron + Python sidecar"：

- 首次启动填服务器地址（会先探测 `/health`），之后窗口加载服务器托管的界面。
- 主进程把 `agent-base-host` 作为子进程运行并监管（意外退出 3 秒后重启；设备被吊销则不再重试；退出应用时一并结束）。
- 界面在"设备"页多出"这台电脑"面板：一键把本机链接为设备、用系统文件夹选择器挑要共享的目录、开关远程命令、解除链接。
- 关窗口不退出（macOS 下留在托盘继续执行会话）。
- 界面只能通过一个受限的桥调用这些能力：仅接受来自服务器同源的顶层页面，窗口不会被导航到别的站点，外链在系统浏览器里打开。

```bash
pnpm build && pnpm --filter @agent-base/desktop start
```

**没有做的**：安装包（electron-builder 打包、签名、自动更新）；全局快捷键、系统通知。

## 会话分叉

`POST /v1/sessions/:id/fork` 从一个会话的当前位置分出一个新会话：历史记录复制过去，之后各走各的，原会话不受影响。Claude 运行时用 SDK 的原生分叉，原生 Valuz 运行时复制检查点；Codex 的 SDK 不支持分叉，会明确拒绝。只能在末尾分叉，不能选中间某一回合。

## 项目记忆、技能历史、Agent Pack

- **项目记忆**：人可以在项目页记下事实，智能体也会用 `remember` 自己记；每条都会带进该项目之后的每个会话。删除后下一回合即不再带入。
- **聊天里发起任务**：项目里的普通会话可以用 `create_task` 把目标交给团队，用 `get_task` / `inject_into_task` 跟进。任务自己的 lead 和成员不能再套娃发起任务。
- **技能版本历史**：每次内容修改都保留一个版本；“恢复”是把旧内容写成一个新版本，历史只增不改。
- **Agent Pack**：把智能体连同它们用到的技能、连接器导出成一个 JSON 文件，导入到另一个组织。Pack 里不含模型渠道和任何凭据；同名的已有资源会跳过而不是覆盖。

## 通知、排队、反馈

- 任务完成 / 停止 / 受阻、自动化运行结束、文档解析失败会通知到人（存库 + 实时推送）。
- 回合运行中发送的消息进入队列，回合正常结束后按顺序发出；出错或被中断后队列停住，由人决定是否继续。
- 每个人可以对每个回合点赞 / 点踩并留言。

## 快速开始

```bash
pnpm install
pnpm infra:up                         # 开发用 PG(:55432) + Redis(:56379)
export APP_SECRET=$(openssl rand -base64 48)
pnpm dev:server                       # 启动时自动迁移，监听 :8787

# 在要共享的桌面上
pnpm --filter @agent-base/host build
AGENT_BASE_PASSWORD=... node apps/host/dist/cli.js login --server http://127.0.0.1:8787 --email you@example.com
node apps/host/dist/cli.js share add /abs/path/to/workspace
node apps/host/dist/cli.js run
```

生产部署：

```bash
cp deploy/.env.example deploy/.env    # 填 APP_SECRET / POSTGRES_PASSWORD / PUBLIC_URL
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

`APP_SECRET` 同时用于签发令牌和加密库里的凭据（模型 key、连接器凭据、存储桶密钥）。丢失或更换它，已存的凭据全部无法解密。前面必须放 TLS。

数据库迁移可逆：`pnpm migrate up` / `pnpm migrate down <步数>`。

## API 概览（`/v1`，组织上下文用 `X-Org-Id`）

| 领域 | 路由 |
|---|---|
| 账号 | `auth/register` `auth/login` `auth/refresh` `auth/logout` `me` `invites/accept` |
| 组织 | `orgs` `org/members` `org/invites` `org/teams` `org/audit-logs` |
| 资源库 | `providers` `skills` `connectors` `agents`（+ `agents/:slug/copy`），每个都有 `/:key/shares` |
| 项目 | `projects` `projects/:id/agents:deploy` `projects/:id/shares` |
| 设备 | `devices`（注册返回一次性设备令牌）`devices/link`(WS) `devices/:id/shares` |
| 远程控制 | `devices/:id/fs/{list,stat,read,write,mkdir}` `devices/:id/exec` |
| 会话 | `sessions` `sessions/:id/messages` `…/events` `…/events/stream`(SSE) `…/interrupt` `…/actions` `…/shares` |
| 任务 | `projects/:id/tasks` `tasks` `tasks/:id` `tasks/:id/plan` `tasks/:id/events(/stream)` `tasks/:id:intervene` `:inject` `:commit` `:abandon` |
| 任务工具 | `mcp/tasks`（MCP over HTTP，仅 lead 会话的令牌可用） |
| 自动化 | `projects/:id/automations` `automations/:id` `automations/:id/run` `automations/:id/runs` |
| 知识库 | `documents` `documents/search` `documents/:id` `documents/:id/reindex`；智能体侧 `mcp/docs`（`doc_search` `doc_read` `list_doc_scope`） |
| 通知 | `notifications` `notifications/stream` `notifications/read-all` `notifications/:id/read` |
| 会话排队与反馈 | `sessions/:id/queue` `sessions/:id/queue/resume` `sessions/:id/feedback` |
| 飞书渠道 | `channels` `channels/:id` `channels/:id/test` `projects/:id/channels`；平台回调 `channels/feishu/:id/callback` |
| 技能历史 | `skills/:slug/versions` `skills/:slug/versions/:n` `skills/:slug/versions/:n/restore` |
| Agent Pack | `agent-packs/export` `agent-packs/import` |
| 项目记忆 | `projects/:id/memory`；智能体侧 `mcp/project`（`remember` `list_memory` `create_task` `list_tasks` `get_task` `inject_into_task`） |
| 实时 | `stream`（组织级：设备上下线、会话状态） |
| 云存储 | `storage/config`（local / S3 兼容：AWS、COS、OSS、MinIO、R2）`files` `files/:id/complete` `files/:id/download` |

会话行里不存任何密钥：模型凭据、连接器凭据、技能包都在每次派发回合时从资源库实时解析后下发给设备。

## 测试

```bash
pnpm infra:up && pnpm test     # 47 个用例
pnpm typecheck
```

端到端用例不 mock 任何自家组件：真实 PG + Redis、真实服务端、真实宿主进程经 WebSocket 链接、原生运行时对着一个假的模型网关跑真实 SSE；装了 `minio` 时还会对真实 S3 桶做上传下载。

## 已知边界

**安全模型上要知道的事**

- 模型 key 在派发回合时会解密下发到执行设备。把模型渠道以 `use` 共享给某人，等于允许他的设备在运行期间拿到这把 key（API 响应里永远不返回）。需要"成员完全接触不到 key"时，要在服务端加模型代理，目前没有。
- Codex 运行时会读取设备所有者本机的 `~/.codex` 配置（登录态在那里），所有者的个人 Codex 技能会进入共享会话。Claude 运行时已隔离（不加载所有者的个人设置）。
- Codex SDK 的 exec 通道没有审批回调：非 `full_access` 模式降级为 workspace-write 沙箱，而不是逐次审批。
- "远程控制"指远程驱动会话、文件和命令，不是屏幕像素级的远程桌面。

**相对 valuz-agent 尚未移植的模块**

valuz-agent 后端约 12.5 万行 Python、41 个模块。这里移植的是主干：内核、智能体、项目与成员部署、模型渠道、技能、连接器、会话/消息/事件流、审批、中断。以下**尚未移植**：

- 任务专属 git worktree；聊天里的任务草稿（`draft_task` / `commit_task`）
- 自动化的事件触发、结果契约与代码执行器（目前只有 cron 触发）；Playbooks
- 知识库的 OCR、向量检索、文件夹自动发现、引用溯源；项目记忆的后台自动总结（目前靠智能体主动 `remember`）
- 引用/声明审计（citation、claim audit、evidence）
- 企业微信渠道；飞书的富文本/卡片/图片消息、流式回复
- 市场、插件、Project Pack（整个项目的导入导出）、备份
- 从中间某一回合分叉、重新生成（需要运行时的原生线程回退）；GenUI / Artifacts；worktrees；内置浏览器；PTC
- 桌面网络出口管理、`deepseek_harness` 运行时

**前端与桌面壳**

`apps/web` 的页面是对准本服务端能力新写的（valuz-agent 的页面约 6.8 万行，绑定旧契约的 162 条路由，没有照搬），但建立在 valuz-agent 的设计系统之上：`frontend/packages/{ui,shared,a2ui}` 与 `i18n/locales` 是从 valuz-agent 原样搬来的 `@valuz/ui`、`@valuz/shared`、`@valuz/a2ui`（去掉了测试和 demo，包名与目录布局不变，可随上游重新同步）。

目前用到的设计系统组件：主题令牌与 Tailwind 主题、`Button`、`Dialog`、`Badge`、`EmptyState`、`MarkdownContent`（streamdown）、`ToolCallCard`、`AppToaster`。还没有换过去的：输入框/下拉框/标签页仍是原生控件加少量样式，消息输入框没有用 `Composer`，审批卡片没有用 `ApprovalCard`，侧边栏没有用它的 `Sidebar`。

浏览器直传 S3 时，存储桶需要给本站来源配置 CORS（允许 `PUT`）。
