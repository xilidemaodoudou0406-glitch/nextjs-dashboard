# Context Branch AI Chatbot

一个基于 Next.js App Router 和 AI SDK 构建的全栈 AI 对话应用。项目针对长对话中“临时追问污染主线语境”的问题，实现了**单向继承上下文的分支对话**。

本项目最初参考 Vercel AI Chatbot 的聊天形态，之后重新设计了消息身份、分支数据关系、上下文组装、异常恢复和测试体系；它不是原仓库的直接复制。

## 核心问题

用户在主对话中经常需要临时追问某个概念：直接追问会把临时问题加入后续主线，另开普通对话又会丢失已有语境。

本项目的分支对话遵守三条不变量：

1. 分支继承主对话从开头到锚点 assistant 消息为止的上下文；
2. 分支不读取锚点之后新增的主对话消息；
3. 主对话永远不会自动读取分支消息。

```text
主对话：M1 → A1 → M2 → A2 → M3
                    └→ 分支：B1 → BA1 → B2 → BA2

A2 分支上下文：M1、A1、M2、A2、B1、BA1、B2
主对话后续上下文：M1、A1、M2、A2、M3
```

## 已实现能力

### 分支对话

- 只有完整持久化的 assistant 消息可以作为锚点；
- 一条 assistant 消息最多关联一个可多轮追问的分支；
- 点击入口只打开草稿，第一次提交问题时才创建数据库分支；
- 分支与第一条用户消息在同一个事务中落库，不会产生空分支；
- 主对话和分支使用两个独立的 `useChat` 运行时；
- 浏览器只发送最新分支问题，服务端依据 `branchId` 权威重建上下文；
- `?branch=` 保存活动分支，支持刷新、前进和后退恢复；
- 支持停止、重试、删除、移动端全屏面板、焦点陷阱和关闭后焦点恢复。

### AI 聊天与工程边界

- DeepSeek 流式回答、Markdown/GFM 和代码高亮；
- 图片先上传到 Vercel Blob，再以公网 HTTPS URL 与文字组成同一条消息；
- 用户消息、AI SDK 消息和数据库记录共用同一个 UUID；
- 区分浏览器请求状态与 `completed / interrupted` 消息持久化状态；
- 主动停止后保留并标记部分回答，失败后可重新生成；
- 用户向上阅读历史时暂停自动滚动，并提供“回到底部”入口；
- Auth.js 凭证登录、Zod 运行时校验、统一公开错误模型；
- 所有权条件直接写入聊天、消息、反馈和分支数据库查询；
- Vitest 覆盖消息契约、组件、Server Action、数据层和聊天接口；
- Playwright 验证登录页以及分支的恢复、导航、移动端和删除闭环。

## 关键设计

### 稳定消息身份

```text
前端 UI messageId = AI SDK 流消息 ID = 数据库 messages.id
```

用户消息在发送前生成 UUID，assistant 消息在开始流式输出前生成 UUID。点赞、分支锚点、重试和历史恢复因此始终引用同一条资源。

### 服务端权威上下文

主对话沿用完整消息请求；分支请求只携带最新用户消息。服务端校验分支归属后查询：

```text
主对话截至锚点的前缀
+ 分支自己的历史消息
+ 当前最新问题
```

客户端无法把锚点之后的主消息或其他分支消息注入模型上下文。

### 最小数据关系

分支复用 `chats` 表，通过两个可空外键表达来源：

```text
chats.parent_chat_id
chats.branch_from_message_id
```

数据库使用外键、成对检查、禁止自引用和锚点唯一约束维护关系；删除主对话会级联清理分支，删除分支不会影响主对话。

更完整的实现说明见 [BRANCH_CONVERSATION_IMPLEMENTATION.md](./BRANCH_CONVERSATION_IMPLEMENTATION.md)。

## 技术栈

- Next.js 16、React 19、TypeScript
- AI SDK 6、`@ai-sdk/react`
- Auth.js 5
- PostgreSQL、postgres.js
- Zod
- Vercel Blob
- Tailwind CSS
- Vitest、Testing Library、Playwright

## 本地运行

### 环境要求

- Node.js 24
- pnpm 11.6
- PostgreSQL 13 或更高版本

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

根据 `.env.example` 创建 `.env.local`：

```env
POSTGRES_URL=postgresql://user:password@localhost:5432/ai_chatbot
AUTH_SECRET=至少32个字符的随机字符串
AUTH_TRUST_HOST=true
DEEPSEEK_API_KEY=你的API密钥
BLOB_READ_WRITE_TOKEN=你的Vercel Blob读写令牌
```

图片上传使用 Vercel Blob 服务端认证：浏览器只请求本项目的
`/api/upload`，Blob 写入令牌不会暴露到客户端。当前 DeepSeek 文本模型本身
不能理解图片；完整视觉问答需要把 AI provider 换成支持图片输入的模型。

### 3. 初始化数据库

先创建一个空的 PostgreSQL 数据库，然后执行：

```bash
pnpm db:migrate
```

迁移脚本会按文件名顺序执行 `migrations/*.sql`，并通过 `app_migrations` 记录已完成版本。重复运行会安全跳过已经执行的迁移。

### 4. 启动开发服务器

```bash
pnpm dev
```

访问 `http://localhost:3000`，注册账号后即可开始对话。

## 质量检查

```bash
pnpm lint       # ESLint
pnpm typecheck  # TypeScript
pnpm test       # Vitest
pnpm build      # 生产构建
pnpm check      # 依次执行以上全部检查
pnpm test:e2e   # Playwright，需要可用的测试数据库
```

GitHub Actions 会为 E2E 启动独立 PostgreSQL 服务，执行同一套迁移，再运行浏览器测试，避免依赖开发者已经准备好的远程数据库。

## 目录说明

```text
app/(auth)                 注册与登录
app/(chat)                 主聊天、分支面板和聊天接口
app/lib/ai                 消息契约与 AI provider
app/lib/branches           分支数据访问、类型和消息组装
app/lib/db                 统一数据库连接
app/lib/validation         请求运行时校验
migrations                 可从空数据库执行的版本化迁移
scripts/migrate.mjs        迁移执行器
tests/e2e                  真实浏览器关键链路
```

## 功能边界

第一版刻意不实现分支嵌套、一条消息多个分支、自动合并回主线、RAG 或复杂配额平台。项目重点是把上下文隔离、流式交互和异常恢复做成稳定且可验证的闭环。
