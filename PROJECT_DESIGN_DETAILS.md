# Context Branch AI Chatbot：完整设计与实现细节

> 更新时间：2026-08-23  
> 文档性质：当前代码的统一设计说明，不是未来规划。  
> 事实来源：项目现有源码、数据库迁移、单元/组件测试、E2E 测试及 CI 配置。  
> 阅读目的：帮助理解“为什么要这样设计、为了解决什么问题做了什么工作、关键链路如何闭环、当前边界在哪里”。

---

## 1. 项目定位

这是一个基于 Next.js App Router 和 AI SDK 构建的全栈 AI 对话项目。项目最初参考 Vercel AI Chatbot 的聊天形态，但目前的核心数据关系、消息身份、分支对话、异常恢复、图片上传、安全边界、数据库迁移和测试体系均围绕本项目重新设计。

项目要解决的核心产品问题是：

> 在长对话中，用户经常只想临时追问某一条 AI 回答。如果直接在主对话中继续提问，临时问题会污染主线消息列表和后续模型上下文；如果另开一个普通对话，又会失去原对话中已有的背景。

因此，项目的第一核心亮点是“单向继承上下文的分支对话”：

1. 分支继承主对话从开头到锚点 assistant 消息为止的上下文；
2. 分支不读取锚点之后新增的主对话消息；
3. 主对话永远不自动读取分支内容；
4. 一个分支内部可以继续多轮追问；
5. 一条已完成的 assistant 消息最多对应一个分支。

```text
主对话：M1 → A1 → M2 → A2 → M3
                    └→ 分支：B1 → BA1 → B2 → BA2

A2 分支模型上下文：M1、A1、M2、A2、B1、BA1、B2
主对话后续上下文：M1、A1、M2、A2、M3
```

除了分支功能，项目还完成了流式生成状态管理、停止与重试、消息身份一致性、滚动跟随控制、结构化图片消息、认证与资源归属校验、数据库迁移、自动化测试和 CI 等工程闭环。

---

## 2. 技术栈及其职责

| 技术                                  | 在项目中的职责                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| Next.js 16 App Router               | 页面路由、Server Component、Client Component、Route Handler、Server Action、缓存刷新与动态路由 |
| React 19                            | 聊天界面、状态管理、表单交互、分支面板、焦点和滚动控制                                                  |
| TypeScript                          | 统一消息、分支、错误与组件 Props 契约                                                       |
| AI SDK 6 / `@ai-sdk/react`          | `useChat` 聊天运行时、流式 UI 消息、停止、重新生成、模型消息转换                                      |
| DeepSeek OpenAI-Compatible API      | 标题生成和聊天回答模型                                                                  |
| Auth.js 5                           | Credentials 登录、JWT、Session、认证路由和登录/退出                                        |
| PostgreSQL                          | 用户、主对话、分支、消息、消息状态和结构化消息内容持久化                                                 |
| postgres.js                         | Next.js 服务端、迁移脚本和 E2E 连接 PostgreSQL 的客户端                                     |
| Zod                                 | 表单、Route Handler、Server Action、消息 parts、模型 ID 和环境变量运行时校验                     |
| Vercel Blob                         | 保存用户上传的图片并返回可持久化的公网 HTTPS URL                                                |
| Tailwind CSS                        | 桌面端、移动端、状态和可访问性交互样式                                                          |
| React Markdown / GFM / Highlight.js | assistant Markdown、表格、列表和代码高亮渲染                                              |
| Vitest / Testing Library            | 函数、组件、Server Action、数据层和 Route Handler 测试                                    |
| Playwright                          | 真实 Chromium 中验证认证页面和分支完整链路                                                   |
| GitHub Actions                      | 自动执行质量检查、数据库迁移、构建和 E2E                                                       |

---

## 3. 总体架构与职责边界

### 3.1 页面与组件层次

```text
RootLayout
└── ChatLayout（服务端认证）
    ├── Sidebar
    │   ├── 新对话入口
    │   ├── Suspense + ChatList
    │   └── 用户信息与退出
    └── Chat
        ├── 主 useChat
        ├── Suggestions / Messages
        ├── ChatInput
        └── BranchPanel
            ├── loading / draft / ready / error
            ├── BranchChat（独立 useChat）
            └── BranchComposer
```

### 3.2 Server Component 与 Client Component 分工

项目没有把所有逻辑都放进客户端：

- Server Component 负责认证、查询历史记录、验证页面资源归属以及生成初始消息；
- Client Component 负责流式聊天、输入、滚动、URL 交互、分支面板和即时状态；
- Server Action 负责短请求式的注册、删除、反馈、分支查找、创建、读取和删除；
- Route Handler 负责 AI 流式响应和文件上传，因为两者需要处理 HTTP 流或 `FormData`；
- 数据层负责复杂 SQL、事务、所有权条件和数据库行到应用类型的转换。

这种划分的目的，是让浏览器只持有交互所需状态，把身份、所有权和权威上下文保留在服务端。

### 3.3 主聊天请求总链路

```text
ChatInput / Suggestions
→ Chat.handleSubmit
→ 生成用户 messageId
→ useChat.sendMessage
→ DefaultChatTransport POST /api/chat
→ 认证 + Zod 校验
→ 验证或创建当前用户的 chat
→ 保存/幂等确认用户消息
→ streamText
→ AI SDK 流式更新浏览器 messages
→ onFinish 保存 assistant 消息及 completed/interrupted 状态
→ router.refresh 更新服务端侧边栏
```

### 3.4 分支请求总链路

```text
点击已完成 assistant 消息的“分支”按钮
→ 只读查询锚点及已有分支
→ 没有分支：打开内存草稿，不写数据库、不写 URL
→ 第一次提交：事务创建 branch + 首条 user 消息
→ 写入 ?branch=branchId
→ 读取继承前缀和分支历史
→ 挂载独立 BranchChat
→ 浏览器只上传最新分支问题
→ 服务端验证关系并重建权威上下文
→ streamText + 保存 assistant 消息
```

---

## 4. 统一消息契约与稳定消息身份

### 4.1 为什么必须统一消息 ID

原始风险是：浏览器里的用户消息、AI SDK 生成的 assistant 消息和数据库插入记录可能分别生成 ID。页面实时显示时看起来正常，但点赞、重试、分支锚点和刷新恢复使用的是数据库资源，一旦 ID 不一致，就会出现“页面上有这条消息，服务端却找不到”的问题。

项目建立了以下不变量：

```text
前端 UI messageId = AI SDK 流消息 ID = PostgreSQL messages.id
```

具体做法：

- 用户消息在 `Chat.handleSubmit` 或分支提交入口中通过 `crypto.randomUUID()` 生成；
- ID 通过 `sendMessage({ id, role, parts })` 进入 AI SDK；
- `/api/chat` 使用 `lastMessage.id` 写入数据库 UUID 主键；
- assistant 在开始 `streamText` 之前由服务端生成 UUID；
- `generateMessageId` 把同一 assistant UUID 交给 UI 流；
- `onFinish` 再使用同一 UUID 保存数据库记录；
- 历史页直接读取数据库 ID 并恢复成 `ChatMessage`。

这里特意使用 AI SDK 的 `id`，没有错误地使用 `messageId`。后者表示替换已有消息，用新 UUID 传入会产生 `message not found`。

### 4.2 请求状态与消息持久化状态分离

项目区分两类状态：

```text
ChatRuntimeStatus：ready / submitted / streaming / error
MessagePersistenceStatus：completed / interrupted
```

- `ChatRuntimeStatus` 描述当前浏览器请求运行到哪一步，用于禁用输入、显示“思考中”和切换停止按钮；
- `MessagePersistenceStatus` 描述某条 assistant 消息最终如何结束，写入数据库并在刷新后恢复。

不能把两者混在一起，因为 `ready` 不代表上一条消息一定完整落库，而 `completed` 也不表示当前没有其他请求。

### 4.3 统一辅助函数

`app/lib/ai/message.ts` 集中提供：

- `isChatRequestInProgress`：统一判断 `submitted` 和 `streaming`；
- `getMessagePersistenceStatus`：把是否主动停止映射为持久化状态；
- `getMessageText`：从结构化 `parts` 中提取纯文本；
- `isMessageStableForActions`：只允许完整落库的 assistant 消息点赞或创建分支；
- `getUnansweredUserMessage`：识别最后一条尚未得到 assistant 回答的用户消息。

把规则集中起来，可以避免主聊天、分支聊天、输入框和消息操作各自形成不同判断。

### 4.4 `content` 与 `parts` 双存储

`messages` 同时保存：

- `content`：从文本 part 提取的纯文本，用于标题、摘要和简单查询；
- `parts JSONB`：保存 AI SDK 的结构化内容，例如文本、图片、推理或步骤边界。

只保存 `content` 会导致图片 URL 在刷新后消失；只保存 `parts` 又会让生成标题和简单文本处理变复杂。双存储是针对当前功能范围的折中。

---

## 5. 用户认证、注册和访问控制

### 5.1 Credentials 登录

项目使用 Auth.js Credentials Provider 实现邮箱密码登录：

1. Zod 校验邮箱和密码格式；
2. 按邮箱查询 PostgreSQL 用户；
3. 使用 bcrypt 比较明文密码和数据库哈希；
4. 验证成功后把用户 ID 写入 JWT；
5. Session 回调再把 ID 放进 `session.user.id`。

用户 ID 必须进入 Session，因为后续所有聊天、消息、反馈和分支查询都要以它作为所有权边界，而不能只依赖邮箱或浏览器传入的 ID。

### 5.2 注册流程

注册由 Server Action 完成：

```text
FormData
→ Zod 校验
→ 查询邮箱是否存在
→ bcrypt.hash(password, 10)
→ INSERT users
→ signIn('credentials') 自动登录
```

密码不会以明文写入数据库。数据库对 `users.email` 还有唯一约束，作为并发情况下的最终防线。

登录和注册表单使用 React `useActionState` 接收 Server Action 的字段错误、通用错误和 pending 状态。提交期间按钮禁用并切换为“登录中/注册中”，避免用户在服务端处理期间重复提交；注册表单可以把 Zod 的邮箱、密码错误显示在对应字段附近。

### 5.3 两层认证边界

项目同时使用：

- `proxy.ts`：对页面路由做早期保护，未登录用户跳转登录页；
- `requireUser`：在页面、Route Handler 和 Server Action 内再次取得并验证 Session。

第二层不是重复劳动。API 被 proxy matcher 排除，而且服务端函数可能被独立调用，因此每个敏感入口仍必须自行认证。`requireUser` 统一了“页面需要跳转”和“接口需要返回 401”两种行为。

### 5.4 认证不等于授权

Auth.js 只证明“当前用户是谁”，不能自动证明“这个 chat 是不是他的”。因此项目把 `user_id` 所有权条件直接写进 SQL：

```sql
WHERE chat.id = requestedId
  AND chat.user_id = currentUserId
```

消息反馈、主对话删除、分支读取和分支删除还会同时验证 chat、message、parent chat 和 branch 的完整关系。找不到和无权访问统一返回资源不存在，减少资源枚举和信息泄露。

---

## 6. 请求校验、环境变量和错误模型

### 6.1 为什么 TypeScript 之外还需要 Zod

TypeScript 类型在编译后不会自动保护运行时。浏览器、脚本或恶意请求都可以发送任意 JSON，因此所有外部输入在服务端重新校验：

- chatId、messageId、branchId 必须是 UUID；
- role 只能是允许的消息角色；
- messages 不能为空；
- 分支首条问题去空格后不能为空，最大 20,000 字符；
- modelId 只能来自服务端白名单；
- file part 只能是允许的图片 MIME 类型；
- 图片 URL 必须来自 `.public.blob.vercel-storage.com`；
- 生命周期状态不能冒充消息持久化状态。

`parseInput` 和 `parseJsonRequest` 把 Zod issue 转换成统一字段错误详情，例如 `messages.9.parts.0`，方便客户端定位问题。

### 6.2 结构化消息 parts 兼容

AI SDK 多轮消息不仅有文本，还可能包含：

- `text`；
- `file`；
- `step-start`；
- `reasoning`。

项目显式校验这些当前允许的 part，并拒绝未知类型。这样既能支持 DeepSeek Reasoner 或 AI SDK 的历史消息结构，又不会用无限制的 `any` 放开请求体。

### 6.3 模型白名单与集中 Provider

`app/lib/ai/provider.ts` 集中配置 DeepSeek OpenAI-Compatible Provider，并导出允许的模型映射。前端选择器只负责选择，服务端 Zod 枚举才是最终边界。

这样可以防止客户端传入任意模型名称，也让以后切换 provider 时只需修改集中配置，而不需要在多个组件中复制 API 地址和密钥。

### 6.4 环境变量启动即校验

`POSTGRES_URL`、`AUTH_SECRET` 和 `DEEPSEEK_API_KEY` 在服务端模块加载时统一校验：

- 数据库地址必须是合法 URL；
- Auth Secret 至少 32 个字符；
- 模型密钥不能为空。

目标是让配置错误尽早失败，而不是等用户发消息后才以模糊的 500 暴露。

`BLOB_READ_WRITE_TOKEN` 只在上传 Route 中按需检查，因为它只影响可选的图片上传链路。

### 6.5 统一公开错误模型

项目定义四类公开错误：

- `UNAUTHENTICATED`；
- `VALIDATION_ERROR`；
- `RESOURCE_NOT_FOUND`；
- `INTERNAL_ERROR`。

Route Handler 返回统一 JSON，Server Action 返回 `{ ok: true }` 或 `{ ok: false, error }`。未预期异常只在服务端记录，对客户端统一显示“服务器暂时无法处理请求”，避免数据库和内部堆栈泄露。

### 6.6 当前资源消耗边界

项目没有建设复杂的限流和计费平台，但在真实入口保留了最小边界：

- 聊天模型回答设置 `maxOutputTokens: 1000`，避免单次生成无限增长；
- 标题生成设置更小的 50 Token 上限；
- 分支首条文本最大 20,000 字符；
- 图片最大 4MB 且只允许四种图片 MIME；
- 前端请求忙碌时禁止重复发送；
- 模型 ID 只能来自服务端白名单。

当前没有实现按用户频率限流、每日 Token 配额或分布式并发控制，因此不能把这部分描述成完整的生产级资源治理。

---

## 7. PostgreSQL 数据模型与迁移设计

### 7.1 基础表

```text
users
├── id UUID PK
├── name
├── email UNIQUE
└── password（bcrypt hash）

chats
├── id UUID PK
├── user_id → users.id
├── title
├── created_at
├── parent_chat_id → chats.id nullable
└── branch_from_message_id → messages.id nullable

messages
├── id UUID PK
├── chat_id → chats.id
├── role user | assistant
├── content TEXT
├── parts JSONB
├── status completed | interrupted
├── likes
└── created_at
```

### 7.2 为什么分支复用 `chats` 表

分支本质上仍是一段可以多轮追问、拥有独立消息列表的 chat，因此没有额外建立 `branches` 和 `branch_messages` 两套重复表，而是在 `chats` 增加来源关系。

优点：

- 复用消息查询和级联删除；
- 主对话与分支使用同一 ID 和消息模型；
- 数据关系直观；
- 不复制主对话历史。

代价：

- 所有普通主对话查询都要明确加 `parent_chat_id IS NULL`；
- 分支查询必须验证它与 parent chat、anchor message 的完整关系。

### 7.3 数据库约束承担最终一致性

分支关系由数据库约束保护：

- `parent_chat_id` 与 `branch_from_message_id` 必须同时为空或同时存在；
- parent 不能指向自身；
- `branch_from_message_id UNIQUE` 保证一个锚点最多一个分支；
- parent chat 删除时级联删除分支；
- anchor message 删除时级联删除对应分支；
- chat 删除时级联删除自己的 messages；
- message status 只能是 `completed` 或 `interrupted`；
- `parts` 必须是 JSON 数组。

这些规则不能只依赖前端按钮，因为并发请求、脚本和服务端 bug 都可能绕开 UI。

### 7.4 索引设计

当前索引围绕已有访问路径：

- `chats(user_id, created_at DESC)`：用户历史对话列表；
- `messages(chat_id, created_at ASC)`：按时间读取聊天消息；
- `chats(parent_chat_id)`：定位某个主对话下的分支；
- 锚点唯一约束自带唯一索引。

### 7.5 可复现迁移

迁移脚本会：

1. 优先读取外部环境变量，否则加载 `.env.local` 或 `.env`；
2. 创建 `app_migrations` 记录表；
3. 按文件名排序扫描 `migrations/*.sql`；
4. 跳过已经执行的文件；
5. 每个迁移和迁移记录在同一事务中执行；
6. 失败时整体回滚，避免数据库只改了一半。

本地 PostgreSQL 默认关闭 TLS，远程数据库开启 `ssl: require`。这一判断由应用、迁移和 E2E 共同复用，解决“远程可以连接、本地却因强制 SSL 失败”的配置分裂。

---

## 8. 主对话创建、流式生成与持久化

### 8.1 新对话采用懒创建

首页 Server Component 先生成稳定 chatId，但不立即写数据库。只有用户真正发送第一条消息时，`/api/chat` 才创建 chat。

这样做可以避免用户只是点击“新对话”或反复打开首页时制造大量空会话。

第一条用户消息进入本地消息列表后，浏览器通过 `history.replaceState` 把 `/` 改为 `/chat/[id]`：

- 使用 replace，不在历史栈里增加无意义的空首页记录；
- 不触发整页导航，当前流式请求不会因页面卸载而中断；
- 刷新或重新打开 URL 时，再由历史页 Server Component 从数据库恢复。

### 8.2 首次并发和 ID 冲突处理

Route Handler 先查询当前用户是否拥有 chat。主对话不存在时执行：

```sql
INSERT INTO chats ... ON CONFLICT (id) DO NOTHING
```

如果插入没有返回行，再按“当前用户 + chatId”重新查询。这既兼容同一用户的并发首条请求，也不会覆盖或泄露其他用户占用的同名资源。

分支请求绝不允许走这条主对话自动创建路径。一个不存在的 branchId 必须由分支首次提交事务创建，不能降级成普通 chat。

### 8.3 自动生成标题与降级

新主对话创建后使用第一条文字调用轻量标题生成：

- system prompt 要求返回简短标题；
- 输出设置较小 Token 上限；
- 最终再次截断，防止模型不遵守要求；
- 模型失败时直接使用用户首条文本前缀；
- 纯图片对话使用“图片对话”作为可读输入。

标题属于辅助能力，因此失败不能阻塞聊天主链路。

### 8.4 统一发送入口与重复提交锁

输入框和建议词最终都调用 `Chat.handleSubmit`。该函数同时检查：

- 当前请求是否忙碌；
- 同步锁是否已经占用；
- 文本和图片是否都为空。

仅依赖 `useChat.status` 不够，因为 `sendMessage` 到 React 状态更新之间存在极短窗口。`submissionLockRef` 在真正发送前同步上锁，覆盖连续 Enter、快速点击和不同发送入口并发触发。

### 8.5 用户消息写入与幂等

服务端只取最后一条用户消息作为本轮新增消息，使用 `INSERT ... SELECT`：

- `SELECT` 同时要求 chat 属于当前用户；
- 使用客户端已生成的 UUID；
- 同时保存纯文本和 JSONB parts；
- `ON CONFLICT DO NOTHING` 支持重试。

发生 ID 冲突时不会直接认为成功，而是再次校验 ID、chat、role、content、parts 和用户归属完全一致。只有完全一致才视为同一请求的幂等续接，否则按资源错误处理。

### 8.6 assistant 流式消息与保存

服务端在调用模型前生成 assistant UUID，随后：

```text
streamText
→ toUIMessageStreamResponse
→ generateMessageId 返回预生成 UUID
→ 浏览器实时显示同一个 ID
→ onFinish 使用同一个 ID 写数据库
```

结束策略：

- 正常完成且有文本：保存为 `completed`；
- 用户主动停止且已有部分文本：保存为 `interrupted`；
- 首个文本片段之前停止：不保存空 assistant 气泡；
- 普通模型错误：即使有临时部分文本也不伪装成完成记录。

同时把 `req.signal` 传入 `streamText`，使前端停止请求能够真正中止模型调用。

### 8.7 实时状态回填

数据库状态只能在生成结束后确定，而浏览器不应等待刷新才知道结果。因此 `useChat.onFinish` 把当前 assistant 的 `completed/interrupted` 写入本地映射，再通过 `displayMessages` 合并到 UI 消息 metadata。

这种方式没有直接修改 AI SDK 内部 `messages`，也不会把请求状态误写成消息状态。刷新后 metadata 则来自数据库。

### 8.8 错误恢复与重新生成

用户消息可能已落库，但模型请求没有得到回答。主聊天和分支都检查“最后一条是否是 user”：

- 请求进行中不显示重试；
- 回到 ready/error 后显示“上一条问题尚未获得回答”；
- `regenerate({ messageId })` 复用原用户消息；
- 服务端幂等检查避免为了重试插入第二条 user 记录；
- 普通错误可以关闭，不需要刷新页面恢复输入能力。

### 8.9 历史恢复

`/chat/[id]` 页面在服务端：

1. 验证登录；
2. 校验动态路由是 UUID；
3. 验证 chat 属于当前用户且是主对话；
4. 按 `created_at` 读取历史消息；
5. 把数据库 `id/status/parts` 转换成统一 `ChatMessage`；
6. 作为 `useChat` 初始消息交给客户端。

无法访问的 chat 使用统一 not-found 页面，不泄露该 ID 是否属于别人。

### 8.10 模型选择

输入区提供 DeepSeek Chat 与 DeepSeek Reasoner 两个模型选项，模型状态由主 `Chat` 持有，并传给输入区和分支面板。服务端拥有 `models` 映射和 Zod 白名单，API Key、baseURL 与 provider 实例也全部位于服务端集中配置。

需要准确说明当前接线状态：

- 分支 transport 会携带当前 modelId，因此分支请求可以使用选择结果；
- 主对话 transport 当前只携带 chatId 和 `chatMode: main`，没有携带 modelId，所以服务端会使用默认的 `deepseek-chat`；
- 前端选择器在主对话中的切换目前属于学习性实验，并没有形成完整的主聊天模型切换闭环。

因此这项能力不能在简历中描述成完整的多模型路由系统；项目也没有扩展成多供应商动态路由平台。

---

## 9. 消息渲染、Markdown 与消息操作

### 9.1 结构化 parts 渲染

`Messages` 遍历每条消息的 `parts`：

- user 文本使用保留换行的普通文本；
- assistant 文本交给 Markdown；
- image file part 使用 Next Image 展示；
- 当前不认识的 part 不强行渲染。

这种设计为后续 reasoning、工具调用等结构留出了扩展点，不再假设“一条消息只有一个 content 字符串”。

### 9.2 Markdown 和代码高亮

assistant 消息通过：

- `react-markdown` 解析 Markdown；
- `remark-gfm` 支持表格、任务列表等 GFM；
- `rehype-highlight` 处理代码高亮；
- 自定义 code 渲染区分行内代码和代码块。

用户消息不解析 Markdown，避免普通输入被意外解释为富文本。

### 9.3 “思考中”与停止提示

- `submitted` 表示请求已经发出但尚未收到首个片段，显示“思考中”；
- `streaming` 阶段显示实时 assistant 内容；
- `interrupted` assistant 显示“已停止生成”。

这比用一个 `loading` 布尔值更准确地表达 AI 请求生命周期。

### 9.4 稳定消息才允许操作

点赞和分支入口只在：

```text
role === assistant
且 persistenceStatus === completed
```

时出现。生成中、被停止或保存失败的回答不能作为外键锚点，也不应该让用户对一个刷新后可能不存在的资源操作。

分支内部调用 `Messages` 时不传 `onOpenBranch`，因此不会显示新的分支入口，从组件边界上禁止第一版分支嵌套。

### 9.5 点赞的乐观更新与回滚

点击点赞后 UI 先变更，再调用 Server Action：

- 成功时保留即时反馈；
- 失败时恢复原状态并显示服务端错误；
- `isLoading` 防止同一组件快速重复点击；
- 服务端再次验证 message 属于 chat、chat 属于用户、角色为 assistant 且状态为 completed；
- 数据库使用 `GREATEST(0, ...)` 防止计数降为负数。

当前点赞是轻量计数能力，不是完整的“每用户唯一反馈”系统：没有单独的 feedback 表，页面刷新后也不恢复个人点赞状态。这是明确范围，不应在面试中描述成完整社交反馈系统。

### 9.6 空对话建议和输入键盘语义

没有消息时不显示空白消息列表，而是展示四个示例问题。建议词与输入框共用 `Chat.handleSubmit`，因此同样受到空内容检查、同步提交锁、消息 ID 和错误清理规则保护。

主输入框和分支输入框都遵守：

- Enter 发送；
- Shift + Enter 换行；
- 空文本不能发送；
- 生成中输入禁用并把发送按钮切换为停止按钮。

主输入框额外允许“只有图片没有文字”的消息；分支输入框保持纯文本范围。

---

## 10. 流式生成期间的滚动体验

### 10.1 原始问题

如果每次 token 到达、`messages` 更新后都强制滚到底部，用户想向上阅读历史时会不断被拉回。单纯使用“距离底部小于某个阈值”仍有问题：用户刚开始向上滚时仍处于阈值内，下一个 token 会再次把页面拉到底部。

### 10.2 三类状态

滚动逻辑使用 ref 保存高频、不需要每次触发渲染的状态：

- `isNearBottomRef`：当前是否允许自动跟随；
- `userPausedAutoScrollRef`：用户是否主动向上滚动并暂停跟随；
- `hasDownwardWheelIntentRef`：暂停后是否出现过向下滚轮意图。

React state `isNearBottom` 只用于控制“回到底部”按钮是否显示。

### 10.3 立即识别向上意图

`wheel` 事件比 `scroll` 更早发生。当 `deltaY < 0` 时立刻：

- 标记用户主动暂停；
- 关闭自动跟随；
- 显示回到底部按钮。

因此不需要等页面真正离开 80px 区域才停止，下一个流式 token 也不会抢回滚动位置。

### 10.4 恢复自动跟随的双条件

暂停后不能只靠位置恢复，必须同时满足：

1. 用户产生一次向下滚轮动作；
2. 当前距离底部不超过 80px。

这表达的是“用户明确想回到底部”，而不是布局变化碰巧让距离变小。向下意图只参与紧随其后的判断，之后立即清空，避免旧意图残留。

用户也可以点击“回到底部”，此时平滑滚动并重置所有暂停状态。

### 10.5 80px 阈值与动画策略

80px 是交互容错区，不是要求滚动条精确到最后 1px。浏览器可能存在小数布局、图片加载和内容增长，过小阈值会让用户明明已经回到底部却无法恢复。

- 流式阶段使用 `behavior: auto`，避免每个 token 都启动一次平滑动画；
- 非流式新消息和手动回到底部使用 `smooth`，保留自然过渡。

消息区域使用 `role="log"`、`aria-live="polite"` 和 `aria-relevant`，让新增内容可以被辅助技术感知。

---

## 11. 图片上传与结构化消息

### 11.1 为什么上传和聊天分两步

浏览器本地 `File` 和 `blob:` 预览 URL 只能被当前页面访问，模型服务和刷新后的页面无法读取。因此发送图片必须先得到公网 URL：

```text
本地 File
→ POST /api/upload
→ Vercel Blob
→ 公网 HTTPS URL
→ text part + file part
→ useChat 发送一条组合消息
```

不需要第二个 `useChat`。上传使用普通 `fetch`，成功后仍由主聊天的同一个 `useChat` 发送最终消息。

### 11.2 本地预览生命周期

选择文件后通过 `URL.createObjectURL(file)` 立即预览，不需要等待上传。

Object URL 会占用浏览器内存，因此在以下时机调用 `URL.revokeObjectURL`：

- 用户移除图片；
- 重新选择文件替换旧预览；
- 消息成功提交并清空附件；
- 输入组件卸载时清理所有残留预览。

### 11.3 两阶段提交与草稿保护

`submitMessage` 先上传所有待发送附件，再调用主聊天 `onSubmit(text, fileParts)`：

- 上传失败：不发送聊天消息，保留文本和附件供重试；
- 上传中：禁用输入和发送，显示“上传中”；
- 聊天入口因为另一请求正在生成而拒绝：保留草稿并提示稍后重试；
- 只有真正进入 `useChat` 后才清空文本和预览。

`uploadLockRef` 处理连续 Enter 或点击造成的上传并发窗口。

### 11.4 服务端上传边界

`/api/upload` 在写入 Blob 前：

- 要求用户已经登录；
- 要求 `file` 确实是 File；
- 只允许 JPEG、PNG、WebP 和 GIF；
- 限制文件必须非空且不超过 4MB；
- 要求服务端存在 `BLOB_READ_WRITE_TOKEN`；
- 使用随机后缀避免同名文件覆盖；
- 只把 URL、MIME 和文件名返回客户端，Token 永远不发给浏览器。

### 11.5 URL 信任边界与持久化

聊天请求的 Zod schema 不接受任意远程地址，只允许 Vercel Blob 的公开域名。这样可以避免客户端伪造 `file part`，让模型提供方访问任意 URL。

图片 URL 保存进 `messages.parts JSONB`，因此页面刷新、历史恢复和主对话上下文都能保留图片。Next Image 的 `remotePatterns` 也只开放 Blob 公网域名。

### 11.6 当前图片能力边界

- 当前文件选择器只允许选择一张图片；
- 分支输入框当前只支持文本；
- DeepSeek 当前文本模型不能真正理解图片；要实现视觉问答需更换支持图片输入的 provider；
- 上传成功但最终聊天消息没有创建时，Blob 中可能形成少量孤儿文件；项目当前没有实现对象存储清理任务。

这些是部署后的可选增强，不应把它们描述成已经完成。

---

## 12. 分支对话：产品不变量与数据设计

### 12.1 锚点资格

分支只能从完整持久化的 assistant 消息创建：

- 前端通过 `isMessageStableForActions` 决定是否显示入口；
- 服务端查询再次要求 `role = 'assistant'`；
- 服务端再次要求 `status = 'completed'`；
- 锚点必须属于当前用户的主对话。

前端隐藏按钮只负责体验，服务端 SQL 才是安全和数据一致性的最终保证。

### 12.2 保存引用而不是复制历史

分支只保存：

```text
parent_chat_id
branch_from_message_id
```

读取时再查询主对话截至锚点的前缀。没有把主消息复制进分支，避免：

- 一份内容出现两个副本；
- 主消息更新或删除时副本不一致；
- 每创建一个分支就复制大量数据。

代价是每次分支生成前需要额外读取数据库上下文。

### 12.3 固定上下文截止位置

查询通过 `created_at` 与 UUID 共同确定锚点位置：

```sql
message.created_at < anchor.created_at
OR (message.created_at = anchor.created_at AND message.id <= anchor.id)
```

因此即使多条消息时间戳相同也有稳定顺序。主对话后来新增的消息时间位置在锚点之后，不会进入已存在的分支。

### 12.4 继承消息与分支消息必须分开

`BranchConversation` 返回两个数组：

- `inheritedMessages`：只作为模型背景；
- `branchMessages`：分支面板真正显示的内容。

如果一开始就把它们合成不可区分的数组，前端容易把主历史重复显示在分支里，也难以证明主线与分支边界。

---

## 13. 分支创建：点击不落库，首次提交才创建

### 13.1 为什么点击时不创建

用户可能只是点开看看，然后立即关闭。如果点击按钮就插入 branch，会产生大量没有消息的空分支，还需要额外清理逻辑。

因此点击入口只调用 `findBranchByAnchor`：

- 锚点非法：返回统一错误；
- 锚点合法且没有分支：返回 `branch: null`，进入 draft；
- 已有分支：返回摘要并恢复原分支；
- 整个查询没有 INSERT。

草稿只存在于 React 内存，也不写入 URL。

### 13.2 第一次提交的事务

用户真正提交第一条问题时，`createBranchOnFirstSubmit` 在同一事务中：

1. 通过 `valid_anchor` CTE 验证用户、主对话、锚点角色和完成状态；
2. 创建 branch chat；
3. 保存第一条 user message；
4. 任一步失败时整体回滚。

因此不会出现“branch 创建成功，但第一条消息写入失败”的空分支。

### 13.3 一个锚点一个分支与并发

数据库唯一约束保证 `branch_from_message_id` 唯一。插入使用：

```sql
ON CONFLICT (branch_from_message_id) DO UPDATE
```

这是一个无副作用的更新，目的是让并发或重试拿到已经存在的同一分支。`WHERE` 仍要求用户和 parent 完全一致，不能借冲突复用别人的资源。

### 13.4 首条消息 ID 的幂等衔接

首次提交有两个动作：

1. Server Action 事务先保存 branch 和第一条 user 消息；
2. `BranchChat.sendMessage` 再触发 AI 流。

为了避免两条用户消息：

- 浏览器先生成 `firstMessage.id`；
- 事务使用该 ID 落库；
- `buildBranchInitialMessages` 从初始化数组临时移除这条消息；
- `sendMessage` 再用同一 ID 加入 UI 并发请求；
- Route Handler 发现记录已存在后，核对归属和内容并视为幂等续接。

网络重试时，如果草稿内容没变，`pendingFirstMessageRef` 复用原 ID；内容改变才生成新 ID。

---

## 14. 分支面板状态机与异步竞态

### 14.1 面板状态

`BranchPanel` 使用可辨识联合类型表达四种状态：

```text
loading：正在查询或从 URL 恢复
draft：合法锚点，但数据库分支尚未创建
ready：分支、继承前缀和分支历史已加载
error：查找、读取或创建失败
```

相比多个互相组合的布尔值，联合类型可以避免“既 loading 又 ready”这类非法状态，也让每种 UI 有明确数据结构。

### 14.2 两种打开来源统一

面板支持：

- `anchor`：用户从某条消息点击；
- `branchId`：刷新、直接链接、前进或后退恢复。

点击已有分支时，先查到 branchId，再把它写入父组件和 URL，随后统一走 branchId 读取路径。这样没有为“点击恢复”“刷新恢复”“历史导航恢复”维护三套逻辑。

### 14.3 防止旧请求覆盖新面板

用户可能快速切换锚点。前一个异步读取如果晚返回，不应该覆盖新锚点状态。`loadBranch` effect 使用 `isCurrent` 标记，在清理后忽略旧结果。

它没有强行取消 Server Action，但保证旧响应不再修改当前 UI。

### 14.4 URL 状态与本地过渡状态

持久化分支使用：

```text
/chat/mainChatId?branch=branchId
```

`activeBranch` 的优先级是：

```text
当前点击的 anchor
→ 刚查到/创建但 URL 尚未同步的 localBranchId
→ useSearchParams 读取的 branchId
```

需要 `localBranchId` 是因为 `router.push` 不是同步完成。如果立即只依赖 URL，首次提交时面板可能短暂卸载，导致 pending 首条消息 ref 丢失。

### 14.5 push、replace 和浏览器历史

- 打开持久化分支使用 `router.push`，让浏览器后退可以关闭分支、前进可以重新打开；
- 关闭分支使用 `router.replace` 移除参数，不额外增加一个“关闭页面”历史记录；
- 构造 URL 时保留其他查询参数；
- 监听 `popstate` 清理本地临时覆盖，让 URL 重新成为持久化状态来源；
- 所有路由更新使用 `scroll: false`，不破坏主聊天滚动位置。

草稿没有 branchId，因此不写 URL。刷新草稿页面不会恢复一个并不存在的数据库资源。

---

## 15. 主对话与分支运行时隔离

### 15.1 两个独立 `useChat`

主对话和分支各自拥有：

- messages；
- status；
- error；
- stop；
- regenerate；
- 输入值和持久化状态映射。

这样一个聊天的停止、错误或流式更新不会覆盖另一个聊天。主 `Chat` 只保存当前分支来源，不接管分支消息数组。

### 15.2 分支本地上下文和可见消息

`BranchChat` 初始化时仍保留：

```text
inheritedMessages + branchMessages
```

这是稳定的本地聊天快照。但渲染给 `Messages` 前，通过固定的 `inheritedMessageCount` 截取，只展示 branchMessages。

主对话历史因此只参与上下文，不会重复出现在右侧面板。

### 15.3 网络只发送最新问题

分支的 `prepareSendMessagesRequest` 使用：

```ts
messages.slice(-1)
```

浏览器不再把完整继承历史当作权威数据上传。服务端根据 branchId 查询：

```text
主对话截至锚点的前缀
+ 分支自己的全部历史
```

最新用户消息已经在本轮开始时写入分支，所以自然位于分支历史末尾。

该设计同时解决：

- 客户端伪造锚点后的主消息；
- 客户端混入其他分支消息；
- 重复上传长继承前缀；
- 前端状态 bug 破坏上下文边界。

代价是每次分支生成需要额外查询数据库。当前项目选择可信隔离优先。

### 15.4 主对话为何暂时保留完整消息协议

主对话当前仍由客户端发送完整 `useChat.messages`，主要为了保持已有 AI SDK 流程和图片 parts 兼容。分支是需要严格固定锚点边界的核心能力，因此优先采用服务端权威重建。

这是有意的范围控制，不代表两条链路被误认为完全相同。未来长对话出现明确请求体或性能问题时，主对话也可以迁移到服务端组装，但当前没有为了架构形式统一而扩大改造范围。

---

## 16. 分支异常恢复、关闭和删除

### 16.1 未回答消息重试

分支最后一条 user 消息如果已经落库但没有 assistant 回答，会显示重新生成入口。重试复用原 messageId，避免重复插入。

这尤其覆盖首次创建成功、随后 AI 请求没有成功完成的失败窗口。

### 16.2 关闭生成中的分支

直接卸载生成中的 `BranchChat` 可能让网络请求在不可见界面中继续。面板通过 `forwardRef + useImperativeHandle` 只暴露两个最小生命周期能力：

- `isBusy()`；
- `stopGeneration()`。

关闭时先等待 stop，再卸载面板。已经生成的部分内容会按 `interrupted` 策略保存，主对话运行时不受影响。

没有把分支 messages 提升到主组件，继续保持状态隔离。

### 16.3 删除分支

删除按钮只在 ready 状态显示，生成中和删除中禁用，并要求二次确认。

服务端删除 SQL 同时匹配：

- branchId；
- parentChatId；
- 当前 userId；
- parent 必须是主对话。

数据库级联删除分支自己的 messages，但不会命中主对话或锚点消息。删除成功后清理 URL、关闭面板；再次点击原锚点会回到 draft。

### 16.4 删除后的导航竞态

Server Action 已经通过 `revalidatePath` 刷新主对话缓存。客户端成功后只调用 `closeBranch()`，不再紧接着 `router.refresh()`。

原因是 refresh 可能抢在清除 `branch` 参数的 replace 之前完成，使已删除的查询参数短暂保留并重新挂载空面板。E2E 测试曾真实捕获该竞态，最终通过移除重复刷新解决。

---

## 17. 分支面板响应式与可访问性

### 17.1 响应式布局

- 桌面端作为右侧固定宽度面板，主聊天仍然可见；
- 移动端使用覆盖全屏的 dialog；
- 移动端打开时锁定 `body` 滚动，避免背景页面跟随；
- 关闭时恢复原有 body overflow，而不是粗暴固定成某个值。

### 17.2 Dialog 语义和键盘操作

面板使用：

- `role="dialog"`；
- `aria-modal="true"`；
- 标题 ID 与 `aria-labelledby`；
- 挂载后把焦点移入面板；
- Escape 走统一异步关闭流程；
- Tab / Shift+Tab 在面板首尾循环；
- 加载区使用 `aria-live`；
- 删除确认使用 `alertdialog`；
- 错误使用 `role="alert"`；
- 按钮拥有明确 aria-label。

### 17.3 关闭后焦点恢复

如果关闭时立刻 focus，`router.replace` 可能替换旧 DOM，焦点随之丢失。因此主 `Chat`：

1. 记录需要恢复焦点；
2. 保存锚点消息 ID；
3. 等 URL 和本地分支状态都清理完成；
4. 优先使用原按钮 ref；
5. 刷新恢复场景没有 ref 时，通过 `data-branch-anchor-id` 查找按钮；
6. 最后再 focus。

这解决的是路由更新和 DOM 生命周期之间的真实时序问题。

---

## 18. 对话历史、删除与侧边栏

### 18.1 服务端加载和 Suspense

侧边栏由 Server Component 查询数据库，并放在 Suspense 中显示 Skeleton。主页面的客户端流式更新与侧边栏的数据读取因此保持职责分离。

生成完成后 `router.refresh()` 只刷新服务端组件数据，不丢失当前客户端聊天状态。

### 18.2 历史分组

对话按创建时间分为：

- 今天；
- 昨天；
- 最近七天；
- 最近三十天；
- 更早。

查询只返回 `parent_chat_id IS NULL` 的主对话，分支不会污染普通历史列表。

### 18.3 删除主对话

客户端使用 `useTransition` 表达正在删除的条目，避免整个侧边栏冻结。服务端只删除：

```text
id 匹配
+ user_id 匹配
+ parent_chat_id IS NULL
```

因此普通删除入口不能误删分支。主对话删除后，数据库外键级联清理分支和所有相关消息。如果用户正在查看被删除的对话，客户端跳回首页。

### 18.4 加载和无权访问反馈

动态聊天路由提供专用 `loading.tsx` 骨架屏，历史对话服务端读取期间不会显示完全空白页面。侧边栏查询也通过 Suspense 使用独立 Skeleton。

不存在、已删除或无权访问的主对话统一进入 `not-found.tsx`，页面只提示“对话不存在或没有访问权限”并提供返回首页入口，不区分资源到底属于谁。

---

## 19. 测试策略与工程基线

### 19.1 为什么分层测试

AI 项目如果所有测试都调用真实模型，会遇到费用、速度和不稳定性问题。因此项目把测试拆成：

- 纯函数测试：消息状态、URL 构造、分支数组边界、Schema；
- 组件测试：输入上传、滚动、反馈回滚、主聊天、分支面板、分支运行时；
- 服务端测试：Server Action、数据层 SQL 意图、聊天和上传 Route；
- E2E：真实浏览器、真实 Next.js 生产服务和真实 PostgreSQL，但不调用付费模型。

### 19.2 Vitest 覆盖重点

当前 15 个测试文件、55 个用例覆盖：

- 请求状态和消息持久化状态分离；
- 稳定消息操作资格；
- 未回答 user 消息识别；
- 统一消息 ID；
- 快速重复提交锁；
- 错误后重新生成；
- URL 分支恢复；
- 上传成功后组合消息以及上传失败保留草稿；
- 向上滚动暂停、向下意图加 80px 恢复；
- 点赞乐观更新失败回滚；
- 草稿点击不创建、首次提交才创建；
- 首条消息 ID 复用；
- 服务端重建分支上下文而不信任客户端历史；
- 模型错误部分内容不落库；
- 图片类型、大小、Blob URL 和身份边界；
- 分支数据归属、删除和数组隔离；
- URL 参数增加、替换、移除和其他参数保留。

### 19.3 Playwright E2E

当前 2 个浏览器用例：

1. 登录页表单可见性；
2. 分支完整链路。

分支 E2E 会：

- 通过注册 UI 创建独立测试用户；
- 事务准备稳定的主对话、锚点和分支历史；
- 同时写入 `content` 和 `parts`，保证 UIMessage 能正确恢复；
- 验证点击打开与 URL；
- 验证 Escape 关闭和焦点恢复；
- 验证刷新恢复；
- 验证后退关闭、前进重新打开；
- 切换 390×844 移动视口验证全宽面板；
- 删除分支并验证主回答仍存在；
- 再次点击锚点验证回到草稿；
- 最后删除测试用户，利用外键级联清理数据。

测试不依赖固定 sleep，关键状态使用 Playwright 显式等待。

### 19.4 CI

GitHub Actions 分成两个 Job：

- `quality`：固定 Node 24、pnpm 11.6，执行 frozen lockfile 安装、Lint、类型检查、Vitest 和生产构建；
- `e2e`：启动独立 PostgreSQL 17 服务，安装 Chromium，执行数据库迁移和生产构建，再运行 Playwright。

CI 使用占位模型 Key，E2E 不调用真实模型，避免把外部模型网络和费用引入核心验收。

当前基线：

```text
ESLint：通过
TypeScript：通过
Vitest：15 个测试文件、55 个用例通过
Next.js production build：通过
Playwright：2 个关键浏览器用例通过
```

---

## 20. 关键设计决策与权衡汇总

| 问题       | 当前选择                         | 主要收益                     | 代价/边界                |
| -------- | ---------------------------- | ------------------------ | -------------------- |
| 临时追问污染主线 | 单向继承分支                       | 保留背景且不反向污染               | 暂不支持自动合并回主线          |
| 分支如何存储   | 复用 chats 自关联                 | 复用消息和生命周期                | 主查询必须区分主线与分支         |
| 是否复制主历史  | 保存锚点引用，读取时查询                 | 无重复数据和副本不一致              | 分支请求需额外查库            |
| 点击是否建分支  | 首次提交才创建                      | 不产生空分支                   | 第一次提交多一个事务步骤         |
| 一个锚点几个分支 | 数据库唯一约束一个                    | UI 简单、并发一致               | 暂不支持多方向探索            |
| 主线和分支状态  | 两个独立 useChat                 | stop/error/messages 天然隔离 | 有少量重复运行时代码           |
| 分支上下文来源  | 服务端权威重建                      | 防篡改、固定锚点边界               | 依赖数据库可用性             |
| 消息内容     | content + parts 双存储          | 兼顾文本处理与结构化恢复             | 有少量数据冗余              |
| 图片发送     | 先 Blob 上传，再组合消息              | 模型和刷新都能访问 URL            | 两阶段存在孤儿文件风险          |
| 停止生成     | 保存非空部分为 interrupted          | 用户内容不丢失、语义明确             | interrupted 不允许点赞/分支 |
| 自动滚动     | 意图 + 位置双条件                   | 不抢夺用户阅读位置                | 当前精细意图主要针对滚轮         |
| 删除后刷新    | Action revalidate，客户端只 close | 避免 replace/refresh 竞态    | 需要理解服务端缓存与客户端导航      |
| 测试模型调用   | Mock/数据库夹具                   | 稳定、快速、无费用                | 不验证第三方模型实际可用性        |

---

## 21. 当前明确没有实现的内容

下面内容不属于当前第一版完成范围：

- 选中文字创建分支；
- 一条 assistant 消息创建多个分支；
- 分支中的分支；
- 自动或手动把分支结论合并回主对话；
- 分支图片输入；
- 完整多模态视觉问答；
- Blob 孤儿文件定时回收；
- 按用户记录唯一点赞状态；
- 长对话分页、虚拟列表或经过 Profiler 证明的性能优化；
- Redis 分布式限流、Token 计费、复杂配额、队列和监控平台；
- RAG、Agent、知识库和多人协作。

这些边界是为了让项目聚焦前端岗位更有价值的流式交互、复杂状态、上下文隔离和工程质量，而不是无限扩大成后端平台。

---

## 22. 核心文件索引

### 22.1 认证与安全

- `auth.ts`：Credentials、bcrypt、JWT 和 Session 用户 ID；
- `auth.config.ts`：登录页与页面路由保护规则；
- `proxy.ts`：页面访问的早期认证；
- `app/lib/auth/require-user.ts`：服务端统一认证入口；
- `app/lib/validation/request.ts`：消息、分支、模型和附件运行时契约；
- `app/lib/errors.ts`：Route 与 Action 统一错误模型；
- `app/lib/env-schema.ts`：服务端环境变量校验。

### 22.2 主聊天

- `app/(chat)/chat.tsx`：主 useChat、统一发送、重试、分支 URL 和面板控制；
- `app/(chat)/chat-input.tsx`：文本输入、图片预览、上传锁和组合提交；
- `app/(chat)/messages.tsx`：消息渲染、滚动、状态提示、点赞和分支入口；
- `app/(chat)/api/chat/route.ts`：认证、持久化、模型调用和流式响应；
- `app/lib/ai/message.ts`：统一消息与状态契约；
- `app/lib/ai/provider.ts`：DeepSeek Provider 与模型白名单；
- `app/(chat)/markdown.tsx`：Markdown/GFM/代码高亮。

### 22.3 图片

- `app/(chat)/chat-input.tsx`：选择、预览、Object URL 清理和上传；
- `app/(chat)/api/upload/route.ts`：认证、文件校验和 Vercel Blob；
- `migrations/0003_add_message_parts.sql`：结构化 parts 持久化；
- `next.config.ts`：Blob 图片域名白名单。

### 22.4 分支

- `app/lib/branches/types.ts`：分支应用层契约；
- `app/lib/branches/data.ts`：查找、事务创建、上下文读取和删除；
- `app/lib/branches/messages.ts`：初始化上下文和可见消息切分；
- `app/lib/branches/url.ts`：分支查询参数构造；
- `app/(chat)/branch-actions.ts`：分支 Server Action 边界；
- `app/(chat)/branch/branch-panel.tsx`：状态机、URL 恢复、删除、焦点和关闭；
- `app/(chat)/branch/branch-chat.tsx`：独立 useChat、增量请求和异常恢复；
- `app/(chat)/branch/branch-composer.tsx`：分支纯文本输入和重复提交保护；
- `migrations/0002_add_branch_relations.sql`：分支关系及约束。

### 22.5 数据库与工程化

- `app/lib/db/client.ts`：统一 postgres.js 客户端；
- `app/lib/db/options.ts`：本地/远程 SSL 规则；
- `migrations/*.sql`：可从空库恢复的版本化结构；
- `scripts/migrate.mjs`：幂等迁移执行器；
- `vitest.config.ts`：单元和组件测试配置；
- `playwright.config.ts`：真实浏览器测试配置；
- `tests/e2e/*.spec.ts`：认证和分支 E2E；
- `.github/workflows/ci.yml`：质量与 E2E CI。

---

## 23. 面试时最值得深入讲述的四条主线

### 23.1 分支上下文为何不是“前端隐藏几条消息”

真正的隔离发生在数据关系和服务端上下文组装：锚点固定主线截止位置，分支请求只提交增量，服务端从数据库重新查询继承前缀和分支历史。前端隐藏只是展示层结果，不是安全边界。

### 23.2 为什么统一消息 ID 是分支的前置条件

分支锚点、点赞和重试操作的都是数据库资源。如果实时 UI ID 和数据库 ID 不同，任何针对实时回答的操作都会失败。项目让 user 和 assistant ID 在写入前确定，并贯穿 UI、流和数据库。

### 23.3 如何处理 AI 流式异步状态

项目没有只使用一个 loading：区分 submitted、streaming、error 与 completed、interrupted；同步 ref 锁处理 React 状态更新窗口；主动停止保存部分回答；未回答 user 消息复用原 ID 重新生成；滚动用用户意图和位置共同控制。

### 23.4 如何证明功能不是只在正常路径工作

数据约束处理并发和级联，SQL 内置所有权条件，组件测试覆盖状态和失败回滚，Route 测试证明服务端不信任客户端分支历史，Playwright 在真实浏览器中验证 URL、刷新、历史导航、移动端、焦点和删除。

---

## 24. 总结

本项目的设计重点不是简单接入一个模型 API，而是围绕 AI 聊天真实存在的问题建立完整闭环：

```text
稳定消息身份
→ 可解释的流式生命周期
→ 可恢复的结构化持久化
→ 单向继承的分支上下文
→ 服务端认证、校验和资源归属
→ URL、响应式与可访问性交互
→ 数据库约束、迁移和自动化测试证明
```

最终结果是：主对话和分支既共享必要背景，又在数据、请求、运行时和展示四个层面保持隔离；正常生成、主动停止、请求失败、刷新恢复、历史导航、删除和移动端操作都有明确处理策略，并由当前测试基线持续验证。
