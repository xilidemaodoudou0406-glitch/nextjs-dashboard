# 分支对话功能实现说明

> 更新时间：2026-07-31  
> 当前范围：记录分支对话阶段一、阶段二、阶段三的实际实现。  
> 本文档描述的是当前代码，而不是尚未落地的未来规划。

## 1. 功能要解决的问题

普通 AI 长对话中，用户经常需要针对某条回答临时追问一个概念。如果直接在主对话中追问，会产生两个问题：

1. 临时问题和主任务混在同一个消息列表里，阅读结构变乱；
2. 临时问题会进入主对话后续的模型上下文，干扰主任务。

如果重新打开一个普通对话，新的 AI 又无法获得原对话中的项目背景。

本项目实现的分支对话需要同时做到：

- 继承主对话已有语境；
- 临时追问不进入主对话消息列表；
- 分支消息不反向进入主对话上下文；
- 一个分支内部可以继续多轮追问；
- 同一条 assistant 回答最多只有一个分支。

## 2. 三条核心不变量

下面三条规则贯穿数据库、服务端查询和前端状态，后续修改时不能破坏：

1. **分支继承主对话从第一条消息到锚点 assistant 消息为止的上下文。**
2. **分支不读取锚点之后新增的主对话消息。**
3. **主对话永远不自动读取分支消息。**

示例：

```text
主对话：M1 → A1 → M2 → A2 → M3
                    └→ 分支：B1 → BA1 → B2 → BA2

A2 分支的模型上下文：
M1、A1、M2、A2、B1、BA1、B2

主对话继续提问时的上下文：
M1、A1、M2、A2、M3
```

## 3. 当前整体架构

```text
主对话 Chat
├── 主 useChat
├── Messages
│   └── 已完成 assistant 消息的分支按钮
└── BranchPanel
    ├── loading：正在查询
    ├── draft：合法锚点，但尚未创建分支
    ├── ready：已经加载持久化分支
    ├── error：查询或创建失败
    └── BranchChat
        ├── 独立 useChat
        ├── 继承上下文（只给模型）
        ├── 分支消息（显示在面板）
        └── BranchComposer
```

服务端边界：

```text
Client Component
    ↓ Server Action
认证 + Zod 参数校验
    ↓
branch data 数据层
所有权查询 + PostgreSQL 事务
    ↓
chats / messages
```

AI 流式请求仍统一经过：

```text
MainChat / BranchChat
    ↓
POST /api/chat
    ↓
保存用户消息
    ↓
streamText
    ↓
保存 assistant 消息
```

## 4. 阶段一：统一消息身份和持久化状态

阶段一没有创建任何分支数据。它解决的是分支功能的前置问题：

> 分支锚点必须引用一条真实存在于数据库中的 assistant 消息，因此浏览器中的消息 ID、流式响应 ID 和数据库 ID 必须一致。

### 4.1 统一消息契约

文件：`app/lib/ai/message.ts`

#### `ChatRuntimeStatus`

它是 AI SDK `ChatStatus` 的类型别名，描述当前浏览器请求的瞬时状态：

```text
ready / submitted / streaming / error
```

它只用于控制输入框、停止按钮和加载提示，不写入数据库。

#### `MessagePersistenceStatus`

它描述一条 assistant 消息最终怎样结束，目前只有：

```text
completed   完整生成并成功持久化
interrupted 用户主动停止，保留已生成的部分内容
```

它会写入 `messages.status`。它和 `ChatRuntimeStatus` 解决的是不同问题：

```text
ChatRuntimeStatus        一次请求现在进行到哪一步
MessagePersistenceStatus 一条消息最终以什么状态保存
```

#### `ChatMessage`

统一项目中前端、服务端和历史消息使用的消息类型：

```ts
UIMessage<{
  persistenceStatus: 'completed' | 'interrupted'
}>
```

因此实时消息和数据库恢复的历史消息使用同一种结构，不再维护两套不兼容的消息类型。

#### `isChatRequestInProgress(status)`

判断一次聊天请求是否还在进行：

```ts
status === 'submitted' || status === 'streaming'
```

主要用于：

- 禁止重复发送；
- 禁用输入框；
- 在发送按钮和停止按钮之间切换。

把判断集中到函数中，可以避免不同组件对“忙碌状态”产生不同理解。

#### `getMessagePersistenceStatus(wasInterrupted)`

把结束原因转换为数据库状态：

```text
wasInterrupted = true  → interrupted
wasInterrupted = false → completed
```

主对话和分支对话的 `onFinish` 都复用该规则。

#### `getMessageText(message)`

从 AI SDK 的 `parts` 数组中提取全部文本并拼接成字符串。

使用位置：

- 把用户 UI 消息转成数据库中的纯文本；
- 把 assistant 流式结果转成数据库中的纯文本；
- 显示分支锚点摘要。

它会忽略文件、推理和工具等非文本 part。

#### `isMessageStableForActions(message)`

判断一条消息能否执行点赞、创建分支等依赖数据库 ID 的操作。

只有同时满足下面两个条件才返回 `true`：

```text
message.role === 'assistant'
message.metadata.persistenceStatus === 'completed'
```

设计原因：

- 正在流式生成的消息还不稳定；
- `interrupted` 消息不是完整回答；
- 尚未落库的消息不能安全地作为外键锚点；
- 点赞和分支入口必须共享同一套可操作规则。

### 4.2 用户消息 ID 的生成

文件：`app/(chat)/chat.tsx`

#### `handleSubmit(text, fileParts)`

职责：

1. 拦截空文本且没有附件的请求；
2. 在浏览器中提前生成用户消息 UUID；
3. 调用 `sendMessage`；
4. 清空输入框。

当前正确调用方式：

```ts
const userMessageId = crypto.randomUUID()

sendMessage({
  id: userMessageId,
  role: 'user',
  parts,
})
```

这里必须使用 `id`，不能使用 AI SDK 的 `messageId`：

```text
id        给一条新消息指定身份
messageId 查找并替换一条已经存在的用户消息
```

最终保证：

```text
浏览器 UI message.id
= 请求 messages[].id
= 数据库 messages.id
```

用户消息在浏览器中最先产生，所以由浏览器生成 ID，可以立即乐观显示，并且网络重试时能够继续复用同一个身份。

### 4.3 assistant 消息 ID 的生成和持久化

文件：`app/(chat)/api/chat/route.ts`

#### `generateTitle(firstMessage)`

这是聊天接口原有的标题生成辅助函数：

- 新建主对话时根据第一条消息生成标题；
- 模型调用失败时退化为截取用户输入；
- 分支已经由 `createBranchOnFirstSubmit` 创建，因此分支请求不会走新建主对话标题流程。

#### `POST(req)`

这是主对话和分支对话共用的 AI 流式 Route Handler。

完整职责：

1. 通过 `requireUser` 认证；
2. 使用 `chatRequestSchema` 校验请求；
3. 取得最后一条用户消息；
4. 验证 chat 属于当前用户；
5. 保存用户消息；
6. 在流式生成前创建 assistant UUID；
7. 调用 `streamText`；
8. 把同一个 assistant UUID交给 UI 流和数据库；
9. 根据正常完成或主动停止保存不同状态。

核心设计：

```ts
const assistantMessageId = crypto.randomUUID()
```

这个 ID 在开始生成前就确定，随后同时用于：

```text
AI SDK generateMessageId()
数据库 messages.id
前端实时 assistant message.id
```

因此 assistant 消息也满足 UI 与数据库身份一致。

#### `POST` 中的用户消息幂等处理

用户消息使用：

```sql
ON CONFLICT (id) DO NOTHING
```

如果插入没有返回记录，接口不会立刻把它当作成功，而会查询并确认：

- ID 相同；
- chat 相同；
- role 是 user；
- content 相同；
- chat 属于当前用户。

只有全部一致才认为是同一次请求的幂等续接。

这一逻辑在阶段三承担了额外作用：第一次分支提交时，首条消息已经随创建分支的事务落库，随后 `/api/chat` 再收到同一 ID 时不会重复插入。

#### `POST` 中的 `onFinish`

`streamText` 完成后的回调负责保存 assistant 消息：

- 空白 assistant 内容不保存；
- 用户主动停止时保存部分文本并标记 `interrupted`；
- 普通模型错误产生的残缺内容不保存；
- 正常完成时保存为 `completed`；
- 数据库 ID 继续使用生成前确定的 `assistantMessageId`。

### 4.4 实时状态回填

文件：`app/(chat)/chat.tsx`

#### 主 `useChat.onFinish`

AI SDK 返回的流式消息最初可能没有持久化状态。`onFinish` 根据：

- `isAbort`
- `isDisconnect`
- `isError`
- `finishReason`

更新 `livePersistenceStatuses`。

这样实时生成的 assistant 消息不需要等待整页刷新，也可以立即获得：

```text
completed / interrupted
```

#### `displayMessages`

这是一个 `useMemo` 派生值：

- 遍历 `useChat.messages`；
- 查找对应的实时持久化状态；
- 如果存在，就把状态合并进 `message.metadata`；
- 不直接修改 AI SDK 管理的原消息数组。

### 4.5 历史消息恢复

文件：`app/(chat)/chat/[id]/page.tsx`

#### `ChatPage`

与分支功能有关的职责：

1. 验证访问的是当前用户的主对话；
2. 使用 `parent_chat_id IS NULL` 排除分支；
3. 从数据库读取消息原始 UUID 和 `status`；
4. 转换为统一 `ChatMessage`；
5. 作为 `initialMessages` 传给客户端 `Chat`。

因此刷新后不会重新生成消息 ID。

### 4.6 消息操作和点赞

文件：`app/(chat)/messages.tsx`

#### `Messages`

它负责：

- 渲染 user 和 assistant 消息；
- 渲染文本 Markdown；
- 显示 `submitted` 状态的“思考中”；
- 自动滚动到底部；
- 对 `interrupted` 消息显示“已停止生成”；
- 只有 `isMessageStableForActions` 返回 true 时才显示消息操作区。

文件：`app/components/message-feedback.tsx`

#### `MessageFeedback`

它使用稳定的数据库消息 ID 发送点赞请求。

#### `handleLiked(like)`

采用乐观更新：

1. 保存旧值；
2. 立即更新 UI；
3. 调用 `addLikes`；
4. 服务端失败时恢复旧值；
5. 显示错误；
6. 使用 `isLoading` 防止快速重复提交。

文件：`app/(chat)/action.ts`

#### `addLikes(chatIdInput, messageIdInput, isLikeInput)`

服务端会同时校验：

- 消息属于目标 chat；
- chat 属于当前用户；
- 消息角色是 assistant；
- 消息状态是 completed。

这意味着隐藏按钮只是交互限制，真正的安全边界仍在服务端查询中。

### 4.7 阶段一数据库迁移

文件：`migrations/0001_add_message_status.sql`

迁移完成：

- 为 `messages` 增加 `status`；
- 旧数据回填为 `completed`；
- 默认值设为 `completed`；
- 设置非空；
- CHECK 约束只允许 `completed` 和 `interrupted`。

## 5. 阶段二：分支数据关系和上下文隔离

阶段二的目标是：

- 用最小数据库关系表达分支来源；
- 保证一个锚点最多一个分支；
- 点击只查询，首次提交才创建；
- 在数据层固定上下文截止位置；
- 所有查询包含用户和资源归属。

### 5.1 数据模型

主对话和分支复用 `chats` 表：

```text
chats
├── id
├── user_id
├── title
├── parent_chat_id
├── branch_from_message_id
└── created_at
```

主对话：

```text
parent_chat_id = null
branch_from_message_id = null
```

分支：

```text
parent_chat_id = 主对话 ID
branch_from_message_id = 锚点 assistant 消息 ID
```

分支自己的消息继续保存在 `messages`：

```text
messages.chat_id = branch.id
```

### 5.2 为什么复用 `chats` 表

分支本质上仍然是一段可以多轮进行的聊天，它与普通 chat 共用：

- 消息持久化；
- AI 流式接口；
- `useChat`；
- 停止和错误状态；
- 点赞等消息操作。

如果再创建一套 `branches` 和 `branch_messages`，会复制大量逻辑。当前方案只增加来源关系，代码和数据模型更简单。

### 5.3 阶段二类型

文件：`app/lib/branches/types.ts`

#### `BranchSummary`

分支的最小摘要：

- 分支 ID；
- 主对话 ID；
- 锚点消息 ID；
- 标题；
- 创建时间。

用于列表查找、面板状态和创建结果，不包含完整消息。

#### `BranchFirstMessage`

第一次创建分支时必须同时提交：

```text
id      浏览器生成的用户消息 UUID
content 第一条分支问题
```

把首条消息放进创建契约，是为了避免数据库中出现空分支。

#### `BranchAnchorLookup`

用户点击分支按钮时的只读查询结果：

- 主对话 ID；
- 锚点 ID；
- 锚点摘要；
- 继承消息数量；
- 已有分支摘要或 `null`。

`branch: null` 不代表锚点非法，而是：

> 锚点合法，但用户还没有真正提交第一个分支问题。

#### `BranchConversation`

完整分支读取结果：

```text
branch
anchorMessage
inheritedMessages
branchMessages
```

最重要的设计是把 `inheritedMessages` 和 `branchMessages` 保留为两个数组，而不是提前混成一个数组。这样模型上下文和 UI 展示可以使用不同视图。

### 5.4 分支输入校验

文件：`app/lib/validation/request.ts`

#### `branchAnchorSchema`

校验：

- `parentChatId`
- `anchorMessageId`

用于只读点击查询。

#### `branchFirstSubmitSchema`

在锚点参数基础上增加：

- `firstMessage.id` 必须是 UUID；
- `firstMessage.content` 去除首尾空白后不能为空；
- 最大长度为 20,000。

#### `branchIdentitySchema`

校验：

- `parentChatId`
- `branchId`

读取和删除分支时必须同时携带两者，不能只相信一个孤立的 `branchId`。

### 5.5 分支数据层辅助函数

文件：`app/lib/branches/data.ts`

#### `toBranchSummary(row)`

把数据库 snake_case row 转换成应用层 camelCase：

```text
parent_chat_id         → parentChatId
branch_from_message_id → anchorMessageId
created_at Date        → createdAt ISO string
```

它隔离了数据库字段命名和前端类型。

#### `toChatMessage(row)`

把数据库消息转换为统一 `ChatMessage`：

- 保留数据库 ID；
- 保留角色；
- 把 `status` 放入 metadata；
- 把纯文本放入 `parts`。

### 5.6 只读查找分支

#### `findBranchByAnchor({ userId, parentChatId, anchorMessageId })`

这是点击分支按钮时使用的数据函数。

它通过一条 SQL 同时验证：

- parent chat 属于当前用户；
- parent chat 是主对话；
- anchor 属于 parent chat；
- anchor 角色是 assistant；
- anchor 状态是 completed。

然后通过 `LEFT JOIN` 查找已有分支。

为什么使用 `LEFT JOIN`：

- 合法锚点可能还没有分支；
- 需要返回锚点摘要和继承数量；
- 不能因为没有 branch row 就失去合法锚点信息；
- 整个函数不执行任何 INSERT。

函数还使用锚点的 `created_at + id` 统计截至锚点的消息数量，供草稿面板展示。

返回：

```text
null          锚点非法、越权或不存在
branch: null  锚点合法，但还没有分支
branch: {...} 已经存在分支
```

### 5.7 首次提交事务

#### `createBranchOnFirstSubmit(...)`

这是阶段二最核心的写入函数。

输入：

- 当前用户 ID；
- 主对话 ID；
- 锚点消息 ID；
- 第一条分支用户消息。

它在一个 PostgreSQL 事务中执行：

```text
验证锚点
→ 创建或取得唯一分支
→ 保存第一条用户消息
→ 返回分支摘要
```

#### `valid_anchor` CTE 的设计

CTE 先证明：

- parent 属于用户；
- parent 是主对话；
- anchor 属于 parent；
- anchor 是 assistant；
- anchor 已 completed。

只有 CTE 返回记录，后面的 `INSERT INTO chats ... SELECT` 才能插入。

这比先查询、再用第二条无条件 INSERT 更安全，因为权限和资源关系直接写进了产生副作用的 SQL。

#### 一个锚点一个分支

数据库有：

```sql
UNIQUE (branch_from_message_id)
```

创建时使用：

```sql
ON CONFLICT (branch_from_message_id) DO UPDATE
```

这里的 UPDATE 不改变真实业务数据，只用于让并发冲突的请求也能 `RETURNING` 已存在的分支。

因此即使两个请求同时为同一个锚点创建分支：

```text
请求 A 候选 branchId-A
请求 B 候选 branchId-B
```

数据库最终只保留一个，两个请求都取得同一个真实分支 ID。

#### 为什么分支和首条消息必须在同一事务

如果先创建分支，再单独保存消息：

```text
创建分支成功
→ 保存消息失败
→ 数据库留下用户从未真正使用过的空分支
```

放进同一事务后，任意一步失败都会回滚。

#### 首条消息的幂等校验

首条消息插入使用：

```sql
ON CONFLICT (id) DO NOTHING
```

如果发生 ID 冲突，函数会确认现有记录的：

- ID；
- branch；
- role；
- content；
- 用户归属。

全部一致才当作网络重试，否则抛错并回滚事务。

### 5.8 读取分支上下文

#### `getBranchConversation({ userId, parentChatId, branchId })`

这是阶段二最核心的读取函数。

它分成三次有明确职责的查询。

第一步：验证完整关系

```text
branch 属于当前用户
branch.parent_chat_id 等于请求中的 parentChatId
parent 属于当前用户且是主对话
anchor 属于 parent
anchor 是 completed assistant
```

第二步：读取继承前缀

截止条件：

```sql
message.created_at < anchor.created_at
OR (
  message.created_at = anchor.created_at
  AND message.id <= anchor.id
)
```

排序和截止都使用：

```text
created_at ASC, id ASC
```

这样定义了稳定顺序，并且锚点之后新增的主对话消息不会被读取。

第三步：读取分支自己的消息

只查询：

```text
messages.chat_id = branch.id
```

最后分别返回：

```text
inheritedMessages
branchMessages
```

这种设计实现了：

- 分支读取主线前缀；
- 分支不读取锚点之后的主线；
- 主线查询不需要读取分支；
- UI 可以隐藏继承前缀；
- 不复制主对话消息。

### 5.9 删除分支

#### `deleteBranchById({ userId, parentChatId, branchId })`

删除 SQL 必须同时命中：

- branch ID；
- parent chat ID；
- 当前用户 ID；
- parent 是主对话。

因此不能用它删除主对话或其他用户的分支。

删除 branch chat 后，分支自己的消息由外键级联清理；主对话和主消息不受影响。

### 5.10 Server Actions

文件：`app/(chat)/branch-actions.ts`

Server Action 层负责：

```text
unknown 输入
→ Zod 校验
→ requireUser
→ 调用数据层
→ 统一 ActionResult
```

它不重复编写复杂 SQL。

#### Action `findBranchByAnchor(input)`

- 校验主对话 ID 和锚点 ID；
- 获取登录用户；
- 调用数据层同名只读函数；
- 非法锚点返回统一错误；
- 合法但没有分支时成功返回 `branch: null`。

#### Action `createBranchOnFirstSubmit(input)`

- 校验锚点和首条消息；
- 获取登录用户；
- 调用数据层事务；
- 创建成功后 `revalidatePath`；
- 点击按钮不会调用它，只有首次提交调用。

#### Action `readBranchConversation(input)`

- 校验 parentChatId 和 branchId；
- 获取登录用户；
- 调用数据层读取隔离上下文；
- 不存在和越权统一表现为“分支不存在”。

#### Action `deleteBranch(input)`

- 校验 parentChatId 和 branchId；
- 获取登录用户；
- 调用 `deleteBranchById`；
- 删除成功后刷新主对话路径缓存。

### 5.11 主对话与分支列表隔离

下面这些查询都增加了：

```sql
parent_chat_id IS NULL
```

#### `deleteChat(input)`

文件：`app/(chat)/action.ts`

普通聊天删除入口只能删除主对话。分支使用单独 Action，避免两种资源生命周期混淆。

#### `fetchChatsByUserId(userId)`

文件：`app/lib/data.ts`

只返回用户的主对话，不把分支混进历史聊天。

#### `fetchMessagesByChatId(chatId, userId)`

只读取属于当前用户的主对话消息。

#### `ChatList({ userId })`

文件：`app/(chat)/chat-list.tsx`

服务端侧边栏查询只获取主对话。它调用的 `groupChatsByDate(chats)` 仍只负责把查询结果分成今天、昨天、最近七天等时间分组。

#### `ChatPage`

动态路由 `/chat/[id]` 只允许打开主对话。分支目前通过右侧面板加载，不作为普通页面直接打开。

### 5.12 阶段二数据库迁移

文件：`migrations/0002_add_branch_relations.sql`

包含：

#### `parent_chat_id` 外键

```text
branch.parent_chat_id → chats.id
ON DELETE CASCADE
```

删除主对话时自动删除其分支。

#### `branch_from_message_id` 外键

```text
branch.branch_from_message_id → messages.id
ON DELETE CASCADE
```

锚点消息被删除时，其分支失去存在依据，因此级联删除。

#### 成对检查

两个字段必须同时为空或同时非空：

```text
主对话：都为空
分支：都非空
```

#### 防止自引用

```text
parent_chat_id 不能等于自身 id
```

#### 锚点唯一约束

```text
UNIQUE(branch_from_message_id)
```

数据库层保证一条 assistant 消息最多一个分支。

#### 父对话索引

```text
INDEX(parent_chat_id)
```

用于按主对话查找和级联处理分支。

## 6. 阶段三：分支 UI 和独立聊天运行时

阶段三把阶段一的消息身份和阶段二的数据接口真正接入前端。

### 6.1 主消息中的分支入口

文件：`app/(chat)/messages.tsx`

#### `Messages`

阶段三为它增加：

- `emptyLabel`：允许主聊天和分支聊天显示不同空状态；
- `onOpenBranch`：可选的打开分支回调。

只有满足 `isMessageStableForActions(message)` 且传入 `onOpenBranch` 时才显示分支按钮。

设计作用：

- 主 `Chat` 传入 `onOpenBranch`，所以主对话有分支按钮；
- `BranchChat` 不传该回调，所以分支消息没有分支按钮；
- 不需要在 `Messages` 中加入“当前是不是分支”的全局判断。

### 6.2 主 Chat 的面板控制

文件：`app/(chat)/chat.tsx`

#### `openBranch(message, trigger)`

职责：

- 保存当前锚点消息；
- 保存触发按钮 DOM 引用；
- 挂载 `BranchPanel`。

主 `Chat` 只保存“当前选中了哪个锚点”，不保存分支 messages。

#### `closeBranch()`

职责：

- 清空当前锚点；
- 卸载分支面板；
- 下一帧把焦点还给原来的分支按钮。

焦点恢复让键盘用户关闭面板后可以继续从原位置操作。

### 6.3 BranchPanel 状态控制器

文件：`app/(chat)/branch/branch-panel.tsx`

#### `PanelState`

这是前端临时状态，不写数据库：

```text
loading 正在查询
draft   锚点合法，但还没有数据库分支
ready   已读取分支上下文
error   查询或创建失败
```

使用判别联合后，每个状态只携带自己需要的数据：

```text
draft → lookup
ready → conversation + 可选 pendingFirstMessage
error → message
```

避免出现多个互相矛盾的布尔变量，例如：

```text
isLoading=true
isDraft=true
hasBranch=true
```

#### `getUnexpectedErrorMessage(error)`

把未知异常转换成用户可显示的字符串：

- Error 返回原 message；
- 其他值返回统一兜底文案。

#### `BranchPanel(...)`

它是整个分支 UI 的流程控制器，负责：

- 首次只读查询；
- 草稿与已有分支分流；
- 第一次提交；
- 错误和重试；
- 锚点摘要；
- 继承消息数量；
- 响应式面板；
- 关闭按钮和 Escape 关闭；
- 挂载独立 `BranchChat`。

它不直接管理分支的流式消息。

#### `loadBranch()`（`useEffect` 内部函数）

执行流程：

```text
findBranchByAnchor
    ↓
branch === null → draft
    ↓
branch 存在
    ↓
readBranchConversation
    ↓
ready
```

`isCurrent` 是防竞态标记：

- 用户切换锚点或关闭面板时 effect 清理；
- 旧请求即使更晚返回，也不能更新已经失效的面板；
- 避免点击 A 后迅速点击 B，最后却显示 A 的结果。

#### Escape 监听 effect

面板挂载时注册 `keydown`，Escape 调用 `onClose`；卸载时移除监听，防止泄漏和重复响应。

#### `submitFirstMessage(content)`

这是阶段三最有特点的前端函数之一。

流程：

```text
生成或复用 firstMessage.id
→ createBranchOnFirstSubmit
→ 分支和首条消息持久化
→ readBranchConversation
→ ready
→ 把 pendingFirstMessage 交给 BranchChat
```

`pendingFirstMessageRef` 的作用：

- 相同草稿发生网络重试时复用同一个 ID；
- 防止一次逻辑消息因为重试变成多个数据库消息；
- ref 更新不需要触发界面渲染。

创建成功后即使上下文读取失败，也不会退回“未创建”语义，因为数据库中已经存在分支和首条消息。此时界面进入错误状态，通过重新加载恢复。

#### `BranchDraft`

只在 `draft` 状态渲染。

职责：

- 保存草稿输入；
- 保存创建中状态；
- 保存创建错误；
- 告诉用户“只有发送后才会创建数据库分支”；
- 复用 `BranchComposer`。

#### `BranchDraft.submit(content)`

流程：

1. 设置创建中；
2. 清理旧错误；
3. 调用父级 `submitFirstMessage`；
4. 失败时保留输入、显示错误并解锁；
5. 成功时父组件切换为 `BranchChat`，草稿组件卸载。

### 6.4 BranchChat 独立运行时

文件：`app/(chat)/branch/branch-chat.tsx`

#### `BranchChat(...)`

它拥有一套完全独立的：

- `useChat`；
- `messages`；
- `status`；
- `stop`；
- `error`；
- `clearError`；
- 输入值；
- 实时持久化状态。

主对话和分支对话只共用 `/api/chat`，不共用可变消息数组。

#### `initialMessages`

通过 `useState` 初始化一次：

```ts
buildBranchInitialMessages(conversation, pendingFirstMessage)
```

使用稳定快照的原因：

- `useChat` 的初始化消息代表该分支实例挂载时的数据库状态；
- 普通 React 重渲染不应该重置聊天内部状态；
- 切换分支时通过不同 `key` 创建新的 `BranchChat` 实例。

#### 独立 `transport`

`DefaultChatTransport` 携带：

```text
id = branch.id
modelId
```

所以 `/api/chat` 把新消息写入分支 chat，而不是主 chat。

#### 分支 `useChat.onFinish`

逻辑与主对话一致：

- 主动停止 → `interrupted`；
- 正常完成 → `completed`；
- 普通错误不伪装成完成。

它只更新分支自己的 `livePersistenceStatuses`。

#### `submitBranchMessage(content)`

处理第二轮及之后的普通分支追问：

1. 忙碌时拒绝重复发送；
2. 清理旧错误；
3. 清空输入；
4. 浏览器生成新用户消息 UUID；
5. 使用 `sendMessage({ id, role, parts })`。

这里同样必须使用 `id`，而不是用于替换已有消息的 `messageId`。

#### 首条消息触发 effect

第一次创建分支时：

- `createBranchOnFirstSubmit` 已经把首条用户消息写入数据库；
- 但还没有调用模型；
- `BranchChat` 必须再调用 `sendMessage` 触发 AI。

effect 使用：

```text
pendingMessageSentRef
```

保证同一组件实例只触发一次，并复用：

```text
pendingFirstMessage.id
```

`/api/chat` 通过阶段一的幂等查询确认它就是已经落库的同一条消息，然后继续生成 assistant 回答。

#### 分支 `displayMessages`

与主对话相同，把实时完成状态合并进消息 metadata，不修改 `useChat.messages`。

#### `visibleMessages`

调用 `getVisibleBranchMessages`，剥离继承前缀，只把分支消息交给展示组件。

### 6.5 分支消息组装辅助函数

文件：`app/lib/branches/messages.ts`

#### `buildBranchInitialMessages(conversation, pendingFirstMessage?)`

普通已有分支：

```text
inheritedMessages + branchMessages
```

第一次创建分支时，数据库读取结果中的 `branchMessages` 已经包含首条用户消息，但随后还要调用 `sendMessage` 触发 AI。

如果不处理：

```text
initialMessages 中有一次
sendMessage 又追加一次
→ UI 出现两条相同用户消息
```

所以该函数会先从初始化数组中移除 pending 首条消息，再让 `sendMessage` 使用同一个 ID 添加一次。

#### `getVisibleBranchMessages(messages, inheritedMessageCount)`

`useChat.messages` 的结构固定为：

```text
[继承前缀, 分支消息]
```

函数使用：

```ts
messages.slice(inheritedMessageCount)
```

得到只用于面板展示的分支消息。

这是“继承但不展示”的关键实现：

```text
模型看到完整上下文
用户只看到分支自己的问答
```

### 6.6 BranchComposer

文件：`app/(chat)/branch/branch-composer.tsx`

#### `BranchComposer(...)`

这是草稿分支和持久化分支共用的纯文本输入组件。

它只负责：

- 受控输入；
- Enter 发送；
- Shift + Enter 换行；
- 空输入拦截；
- 创建中或流式生成时禁用；
- 发送/停止按钮切换；
- 基础可访问性 label。

它不负责：

- 创建分支；
- 保存消息；
- 调用 Server Action；
- 管理 `useChat`；
- 处理模型上下文。

#### `submit()`

流程：

1. trim 输入；
2. 拦截空内容；
3. 拦截忙碌状态；
4. 使用 `submittingRef` 拦截同一渲染周期中的快速连点；
5. 把文本交给父组件。

当 `isBusy` 从 true 恢复 false 时，effect 释放提交锁。

### 6.7 响应式和可访问性

阶段三当前实现：

- 移动端：fixed 全屏分支对话层；
- 桌面端：主聊天右侧 420–480px 面板；
- `role="dialog"`；
- `aria-modal`；
- 标题通过 `aria-labelledby` 关联；
- loading 使用 `aria-live`；
- error 使用 `role="alert"`；
- 关闭按钮有明确 `aria-label`；
- 支持 Escape 关闭；
- 关闭后焦点回到触发分支按钮。

## 7. 三个阶段如何串成一条完整链路

### 7.1 打开一个尚不存在的分支

```text
Messages 判断 assistant 已 completed
→ 用户点击分支按钮
→ Chat.openBranch
→ 挂载 BranchPanel
→ Action findBranchByAnchor
→ data.findBranchByAnchor 只读查询
→ 返回 branch: null
→ PanelState = draft
```

此时数据库没有新增分支。

### 7.2 第一次提交

```text
BranchDraft
→ BranchComposer.submit
→ BranchPanel.submitFirstMessage
→ 浏览器生成 firstMessage.id
→ Action createBranchOnFirstSubmit
→ data.createBranchOnFirstSubmit
→ 同一事务创建 branch + 保存首条 user message
→ readBranchConversation
→ BranchChat 挂载
→ buildBranchInitialMessages 移除 pending 消息
→ sendMessage 使用同一个 id 添加消息并请求 /api/chat
→ /api/chat 识别为已持久化的同一消息
→ streamText
→ 保存 assistant 回答
```

### 7.3 再次打开已有分支

```text
点击同一锚点
→ findBranchByAnchor 返回已有 BranchSummary
→ readBranchConversation
→ 得到 inheritedMessages 和 branchMessages
→ BranchChat 独立 useChat
→ 模型上下文使用两者
→ 面板只显示 branchMessages
```

不会创建第二个分支。

### 7.4 在分支内继续追问

```text
BranchComposer
→ BranchChat.submitBranchMessage
→ 新用户消息使用新 UUID
→ 分支 useChat.messages =
   inheritedMessages + 已有 branchMessages + 新问题
→ /api/chat 使用 branch.id 保存新消息
→ 返回并保存新的 assistant 回答
```

### 7.5 主对话继续提问

主 `Chat` 的 `useChat.messages` 从未加入分支消息，所以仍然是：

```text
主对话自己的历史 + 新问题
```

这保证主线不反向读取分支。

## 8. 关键设计选择和权衡

### 8.1 保存锚点引用，不复制主对话消息

当前方案：

```text
branch 保存 branch_from_message_id
读取时查询主对话前缀
```

优点：

- 不重复存储；
- 不会出现主消息两个副本；
- 数据关系清晰；
- 锚点定义了固定截止位置。

代价：

- 每次恢复分支需要额外查询继承前缀；
- 查询必须拥有稳定的消息排序规则。

### 8.2 一个锚点只有一个分支

这不是只靠前端禁用按钮，而是由数据库唯一约束保证。

优点：

- 并发请求也不会产生两个分支；
- 用户重复点击可以恢复原分支；
- 产品结构保持简单。

代价：

- 暂时不支持同一回答探索多个不同方向；
- 以后要支持多分支时需要修改唯一约束和 UI 信息架构。

### 8.3 点击不创建，首次提交才创建

优点：

- 用户只是查看入口不会制造空数据；
- 关闭草稿不需要清理数据库；
- “是否存在分支”代表用户是否真正开始过追问。

代价：

- 第一次发送需要先调用 Server Action，再启动 AI 请求；
- 首条消息必须设计幂等衔接。

### 8.4 两个独立 `useChat`

优点：

- 主线和分支请求状态天然隔离；
- 一个聊天的 stop 不会停止另一个；
- error、messages、streaming 不会互相覆盖；
- 更容易解释和测试。

代价：

- 两套聊天运行时有部分重复逻辑；
- 后续可以抽取共享 Hook，但当前不为了抽象而提前重构。

### 8.5 当前由客户端携带完整分支上下文

当前第一版沿用 AI SDK 现有协议：

```text
客户端 useChat 发送完整 messages
```

优点：

- 不需要同时重写整个 `/api/chat` 协议；
- 能先验证分支产品交互；
- 复用现有流式链路。

代价：

- 请求体随历史增长；
- 服务端没有自行重新组装每次模型上下文。

后续如果需要更严格的服务端上下文权威性，可以改成客户端只发送最新问题，由服务端根据 branchId 查询并组装上下文。

## 9. 测试如何证明实现

### 阶段一

- `app/lib/ai/message.test.ts`：请求状态、持久化状态和稳定消息判断；
- `app/(chat)/api/chat/route.test.ts`：用户/assistant ID、completed/interrupted、首条分支消息幂等；
- `app/(chat)/chat.test.tsx`：新消息使用 AI SDK 的 `id`，不是替换语义的 `messageId`；
- `app/(chat)/messages.test.tsx`：只有稳定 assistant 消息显示操作；
- `app/components/message-feedback.test.tsx`：乐观更新失败回滚。

### 阶段二

- `app/lib/branches/data.test.ts`：
  - 点击只读；
  - completed assistant 锚点限制；
  - 首次提交事务；
  - 继承数组与分支数组隔离；
  - 删除归属边界。
- `app/(chat)/branch-actions.test.ts`：
  - 打开草稿不调用创建；
  - 只有显式首次提交调用创建。
- `app/lib/validation/request.test.ts`：分支 ID 和首条消息运行时校验。

### 阶段三

- `app/lib/branches/messages.test.ts`：
  - 继承消息保留在模型上下文；
  - 面板只显示分支消息；
  - 首条 pending 消息不会重复。
- `app/(chat)/branch/branch-panel.test.tsx`：
  - 打开草稿不创建；
  - 首次提交才创建；
  - 首条消息 ID 复用；
  - 已有分支直接加载。
- `app/(chat)/branch/branch-chat.test.tsx`：
  - 独立 `useChat` 使用分支 ID；
  - 上下文包含继承前缀；
  - 展示只包含分支消息；
  - 首条消息使用同一 `id` 触发 AI。
- `app/(chat)/messages.test.tsx`：
  - 主消息可以显示分支入口；
  - 不传回调时不显示入口，避免分支嵌套。

当前完整工程检查结果：

```text
ESLint：通过
TypeScript：通过
Vitest：12 个测试文件、36 个测试通过
Next.js production build：通过
```

## 10. 当前尚未完成的范围

下面内容属于阶段四或未来扩展，本文档不能把它们描述成已经完成：

- 使用 `?branch=` 保存当前打开的分支；
- 刷新后恢复分支面板；
- 浏览器前进/后退恢复；
- 直接链接定位分支；
- 更完整的真实浏览器桌面端和移动端 E2E；
- 分支删除 UI；
- 服务端根据 branchId 重新组装每次模型上下文；
- 分支中的分支；
- 选中文字创建分支；
- 把分支结论合并回主对话；
- 分支图片输入。

## 11. 阅读代码的推荐顺序

第一次复盘建议按下面顺序阅读：

1. `app/lib/ai/message.ts`
2. `app/lib/branches/types.ts`
3. `migrations/0002_add_branch_relations.sql`
4. `app/lib/branches/data.ts`
5. `app/(chat)/branch-actions.ts`
6. `app/(chat)/messages.tsx`
7. `app/(chat)/chat.tsx`
8. `app/(chat)/branch/branch-panel.tsx`
9. `app/lib/branches/messages.ts`
10. `app/(chat)/branch/branch-chat.tsx`
11. `app/(chat)/branch/branch-composer.tsx`
12. 对应测试文件

重点不是记住每一行，而是能够独立讲清：

- 为什么必须先统一消息 ID；
- 为什么新消息向 AI SDK 传 `id` 而不是 `messageId`；
- 为什么分支和第一条消息需要同一事务；
- 为什么数据库唯一约束比前端判断更可靠；
- 怎样通过锚点截断主对话上下文；
- 为什么继承消息要参与模型请求但不能显示；
- 为什么主对话和分支必须拥有独立 `useChat`。

## 12. 面试表达参考

可以把功能概括为：

> 我针对 AI 长对话中临时追问污染主线的问题，实现了单向继承上下文的分支对话。分支以已完成并持久化的 assistant 消息作为锚点，继承主对话截至锚点的上下文，但主线不会反向读取分支消息。实现上，我先统一了 UI、流式响应和数据库消息 ID，再用自关联 chat 数据模型和唯一锚点约束保证一条消息一个分支，通过事务实现首次提交才创建且不留下空分支。前端使用独立 `useChat` 隔离主线与分支状态，同时把继承前缀保留在模型上下文中、从界面展示中剥离，并用组件测试和数据层测试验证上下文边界、幂等和创建时机。
