# 分支对话功能实现说明

> 更新时间：2026-08-04
> 当前范围：记录分支对话阶段一至阶段四的实际实现。
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
├── URL 状态：?branch=branchId
├── Messages
│   └── 已完成 assistant 消息的分支按钮
└── BranchPanel
    ├── anchor 来源：点击消息后查找或创建
    ├── branchId 来源：刷新、直接链接和历史导航恢复
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

AI 流式请求统一经过 `/api/chat`，但主对话和分支的上下文来源不同：

```text
MainChat → 发送主 useChat.messages

BranchChat → 只发送 branchId 和最新用户消息
             ↓
       服务端验证分支归属
             ↓
       主线截至锚点的前缀 + 分支自己的消息
             ↓
          streamText
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

## 7. 阶段四：路由恢复、异常恢复和最终验收

阶段四没有增加分支嵌套等新产品能力，而是把前三阶段的核心链路补成一个可恢复、可验证的闭环：

- 使用 URL 表达当前持久化分支；
- 刷新、直接链接和浏览器前进后退可以恢复；
- 主对话和分支中的未回答消息可以原地重试；
- 关闭、停止和删除拥有明确生命周期；
- 分支模型上下文由服务端权威组装；
- 通过桌面端和移动端真实浏览器测试。

### 7.1 URL 构造工具

文件：`app/lib/branches/url.ts`

#### `buildBranchUrl({ pathname, searchParams, branchId })`

职责：

- 写入或替换 `branch` 查询参数；
- 关闭面板时只删除 `branch`；
- 保留页面上的其他查询参数；
- 没有查询参数时不留下多余的 `?`。

```text
草稿：/chat/main-id
持久化分支：/chat/main-id?branch=branch-id
```

只有数据库中已经存在的分支才拥有 branchId。因此，单纯打开草稿不会修改 URL，
首次提交成功或找到已有分支后才会写入。

### 7.2 `Chat` 中的活动分支状态

文件：`app/(chat)/chat.tsx`

#### `activeBranchAnchor`、`localBranchId` 和 `branchIdFromUrl`

三种状态分别表示：

```text
activeBranchAnchor → 用户刚点击的锚点，可能仍是草稿
localBranchId      → 已查到或创建、URL 尚未完成更新的分支
branchIdFromUrl    → URL、刷新、直接链接或历史导航提供的分支
```

活动面板来源按下面的优先级计算：

```text
activeBranchAnchor
?? localBranchId
?? branchIdFromUrl
```

需要 `localBranchId` 是因为 `router.push` 不会同步完成。首次创建后先保存本地 ID，
可以保持同一个 `BranchPanel` 实例，防止首条消息的 `pendingFirstMessageRef` 在路由更新期间丢失。

#### 浏览器 `popstate` effect

用户执行前进或后退时，effect 会清理临时锚点和本地分支 ID，让
`useSearchParams()` 中的 `branch` 重新成为持久化状态来源。

这支持：

- 后退关闭分支；
- 前进重新打开分支；
- 在不同分支 URL 之间切换。

#### `persistBranchInUrl(branchId)`

已有分支和首次创建分支都通过这个函数进入 URL：

1. 清理临时锚点；
2. 立即保存 `localBranchId`；
3. 从当前地址复制其他查询参数；
4. 使用 `router.push` 写入 `branch`；
5. 使用 `scroll: false` 保持主聊天滚动位置。

#### `closeBranch(anchorMessageId?)`

职责：

- 清理本地锚点和 branchId；
- 使用 `router.replace` 删除 `branch`，不新增一个“关闭页面”的历史记录；
- 记录待恢复焦点的锚点 ID；
- URL 和面板状态完成关闭后，把焦点还给触发按钮。

普通点击打开时优先使用保存的按钮 ref；同一 Chat 实例没有 ref 时，
通过消息按钮上的 `data-branch-anchor-id` 查找对应按钮。

### 7.3 BranchPanel 的双来源恢复

阶段四增加了判别联合：

```ts
type BranchPanelSource =
  | { kind: 'anchor'; anchorMessage: ChatMessage }
  | { kind: 'branch'; branchId: string }
```

设计原因：

- 点击消息时拥有 anchor，但可能还没有 branchId；
- 刷新和直接链接时只拥有 branchId，不能依赖旧 React 状态；
- 两种来源最终都收敛为同一个 `BranchConversation`。

#### `loadBranch()` 的两条路径

```text
source.kind === anchor
→ findBranchByAnchor
→ branch === null：进入 draft
→ branch 存在：onBranchPersisted(branchId)

source.kind === branch
→ readBranchConversation
→ 验证用户、父对话、分支和锚点关系
→ 进入 ready
```

URL 中的非法 UUID、其他主对话的分支和其他用户的分支都会在 Schema、认证或
数据库归属查询中被拒绝。错误只显示在分支面板中，主对话仍然可以正常阅读和关闭面板。

### 7.4 未回答消息的统一恢复

文件：`app/lib/ai/message.ts`

#### `getUnansweredUserMessage(messages)`

如果消息数组最后一条是 user，就返回该消息，否则返回 null。

正常流式生成开始时消息列表也会暂时以 user 结尾，所以调用方还必须确认：

```text
status 不是 submitted 或 streaming
```

主 `Chat` 和 `BranchChat` 复用同一个函数，避免形成两套错误恢复语义。

#### `retryLastResponse()`

流程：

```text
确认存在未回答 user
→ clearError()
→ regenerate({ messageId: 原 user.id })
→ /api/chat 核对同 ID、chat、角色和内容
→ 不重复插入 user
→ 重新生成 assistant
```

它同时处理：

- 主对话保存用户消息后模型失败；
- 分支创建成功但首次 AI 请求没有完成；
- 刷新后恢复到一条没有 assistant 回答的持久化用户消息。

### 7.5 关闭生成中的分支

#### `BranchChatHandle`

`BranchChat` 使用 `forwardRef` 向面板暴露：

```text
isBusy()
stopGeneration()
```

这里只暴露生命周期能力，没有把分支 messages、error 或 status 提升给主对话，
所以两个 `useChat` 仍然保持隔离。

#### `requestClose()`

关闭按钮、遮罩点击和 Escape 都进入同一个异步流程：

```text
防止重复关闭
→ stopGeneration()
→ 等待停止完成
→ onClose(anchorMessageId)
```

如果已经产生部分 assistant 内容，现有 Route Handler 会把它保存为 `interrupted`，
避免面板卸载后请求仍在后台隐藏运行。

### 7.6 分支删除 UI

文件：`app/(chat)/branch/branch-panel.tsx`

#### `deleteCurrentBranch()`

删除入口只在 `ready` 状态显示，生成中或正在删除时禁用。

流程：

```text
显示二次确认
→ deleteBranch({ parentChatId, branchId })
→ 数据层重新验证用户和父对话
→ 删除 branch chat
→ 外键级联删除分支 messages
→ 清理 URL 并关闭面板
```

删除 Server Action 已通过 `revalidatePath` 刷新主对话路径缓存，因此客户端成功后只调用
`closeBranch()` 清理本地状态和 URL。这里不能再紧接着调用 `router.refresh()`：刷新可能与
`router.replace()` 竞争，使已经删除的 `branch` 查询参数短暂保留并重新挂载空面板。

主对话和锚点消息不会命中删除条件。删除完成后再次点击原锚点，会重新进入草稿状态。

### 7.7 服务端权威组装分支上下文

涉及文件：

- `app/lib/validation/request.ts`
- `app/(chat)/branch/branch-chat.tsx`
- `app/(chat)/api/chat/route.ts`
- `app/lib/branches/data.ts`

#### `chatMode`

聊天请求增加：

```text
main   → 主对话请求
branch → 已经绑定父对话和锚点的分支请求
```

服务端读取 `chats.parent_chat_id` 后，会验证请求声明和数据库真实关系一致。
不存在的 branch 请求不能被错误地创建成普通主对话。

#### `prepareSendMessagesRequest`

分支的 `DefaultChatTransport` 在发送前只保留：

```text
messages.slice(-1)
```

浏览器中的完整 `useChat.messages` 仍负责即时渲染，但不再被服务端当作权威历史。

#### `/api/chat` 中的 `modelContextMessages`

服务端先保存或幂等确认最新用户消息，然后调用：

```text
getBranchConversation({ userId, parentChatId, branchId })
```

真正传给模型的内容固定为：

```text
branchConversation.inheritedMessages
+ branchConversation.branchMessages
```

最新用户消息已经写入分支，因此会自然出现在 `branchMessages` 末尾，不需要再从请求体追加。

这样，即使客户端伪造锚点之后的主消息、其他分支消息或修改过的继承历史，
也不会改变模型实际读取的上下文。

主对话暂时保留完整 UI messages 协议，因为主输入仍支持 file parts；阶段四没有为了
分支加固而重写图片链路。

### 7.8 可访问性和响应式收尾

阶段四补充：

- 面板挂载后焦点进入 dialog；
- Escape 使用统一异步关闭流程；
- Tab 和 Shift+Tab 在面板内部首尾循环；
- 移动端打开时锁定背景页面滚动；
- 删除、确认、关闭和重试都有明确的可访问名称；
- 删除和请求错误使用 alert 语义；
- 用户从锚点按钮打开后，关闭会恢复触发按钮焦点。

### 7.9 阶段四自动化测试

新增或扩展：

- `app/lib/branches/url.test.ts`：URL 添加、替换、移除和其他参数保留；
- `app/lib/ai/message.test.ts`：识别未回答的用户消息；
- `app/(chat)/chat.test.tsx`：主对话重新生成和 URL 直接恢复；
- `app/(chat)/branch/branch-panel.test.tsx`：branchId 恢复、删除、关闭前停止；
- `app/(chat)/branch/branch-chat.test.tsx`：只上传最新消息和原 ID 重新生成；
- `app/(chat)/api/chat/route.test.ts`：服务端数据库上下文覆盖客户端历史；
- `tests/e2e/branch-conversation.spec.ts`：真实登录、URL、刷新、前进后退、Escape、焦点、移动端和删除。

E2E 使用独立测试用户和独立聊天数据，不调用真实模型；测试结束后删除测试用户，
由外键级联清理对应的主对话和分支。

测试夹具会同时写入 `messages.content` 和结构化 `messages.parts`。这是刷新恢复的必要条件：
页面从 `parts` 还原 `UIMessage`，只写旧的 `content` 会让数据库记录存在但界面没有可渲染文本。
真实 E2E 还验证了删除后清理 URL 的导航时序，防止 `replace` 与额外刷新发生竞态。

## 8. 四个阶段如何串成一条完整链路

### 8.1 打开一个尚不存在的分支

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

### 8.2 第一次提交

```text
BranchDraft
→ BranchComposer.submit
→ BranchPanel.submitFirstMessage
→ 浏览器生成 firstMessage.id
→ Action createBranchOnFirstSubmit
→ data.createBranchOnFirstSubmit
→ 同一事务创建 branch + 保存首条 user message
→ persistBranchInUrl 写入 ?branch=
→ branchId 路径 readBranchConversation
→ BranchChat 挂载
→ buildBranchInitialMessages 移除 pending 消息
→ sendMessage 使用同一个 id 添加消息并请求 /api/chat
→ /api/chat 识别为已持久化的同一消息
→ streamText
→ 保存 assistant 回答
```

### 8.3 再次打开已有分支

```text
点击同一锚点
→ findBranchByAnchor 返回已有 BranchSummary
→ URL 写入 branchId
→ readBranchConversation
→ 得到 inheritedMessages 和 branchMessages
→ BranchChat 独立 useChat
→ 模型上下文使用两者
→ 面板只显示 branchMessages
```

不会创建第二个分支。

### 8.4 在分支内继续追问

```text
BranchComposer
→ BranchChat.submitBranchMessage
→ 新用户消息使用新 UUID
→ 浏览器只发送 branchId + 最新问题
→ /api/chat 使用 branch.id 保存新消息
→ 服务端读取 inheritedMessages + branchMessages
→ 返回并保存新的 assistant 回答
```

### 8.5 主对话继续提问

主 `Chat` 的 `useChat.messages` 从未加入分支消息，所以仍然是：

```text
主对话自己的历史 + 新问题
```

这保证主线不反向读取分支。

## 9. 关键设计选择和权衡

### 9.1 保存锚点引用，不复制主对话消息

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

### 9.2 一个锚点只有一个分支

这不是只靠前端禁用按钮，而是由数据库唯一约束保证。

优点：

- 并发请求也不会产生两个分支；
- 用户重复点击可以恢复原分支；
- 产品结构保持简单。

代价：

- 暂时不支持同一回答探索多个不同方向；
- 以后要支持多分支时需要修改唯一约束和 UI 信息架构。

### 9.3 点击不创建，首次提交才创建

优点：

- 用户只是查看入口不会制造空数据；
- 关闭草稿不需要清理数据库；
- “是否存在分支”代表用户是否真正开始过追问。

代价：

- 第一次发送需要先调用 Server Action，再启动 AI 请求；
- 首条消息必须设计幂等衔接。

### 9.4 两个独立 `useChat`

优点：

- 主线和分支请求状态天然隔离；
- 一个聊天的 stop 不会停止另一个；
- error、messages、streaming 不会互相覆盖；
- 更容易解释和测试。

代价：

- 两套聊天运行时有部分重复逻辑；
- 后续可以抽取共享 Hook，但当前不为了抽象而提前重构。

### 9.5 客户端运行时与服务端上下文分离

阶段三曾让浏览器携带完整分支 `messages`。阶段四调整为：

```text
浏览器完整 messages → 负责 useChat 状态和即时渲染
网络最新 user       → 表达本次用户意图
数据库分支关系       → 提供权威模型上下文
```

优点：

- 请求体不再反复携带整个继承前缀；
- 服务端固定锚点截止位置；
- 客户端不能伪造历史破坏分支隔离；
- 前端仍保留 AI SDK 的流式体验。

代价：

- 每次分支生成前需要查询数据库上下文；
- Route Handler 必须明确区分 main 和 branch；
- 数据库不可用时不能只依靠浏览器历史继续生成。

## 10. 测试如何证明实现

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

### 阶段四

- `app/lib/branches/url.test.ts`：持久化分支 URL 的增加、替换和移除；
- `app/lib/ai/message.test.ts`：主线与分支共用的未回答消息判断；
- `app/(chat)/chat.test.tsx`：主对话重新生成和 URL 分支恢复；
- `app/(chat)/branch/branch-panel.test.tsx`：直接恢复、删除和关闭前停止；
- `app/(chat)/branch/branch-chat.test.tsx`：只上传最新问题并复用原 user ID 重新生成；
- `app/(chat)/api/chat/route.test.ts`：服务端使用数据库上下文而不是客户端历史；
- `tests/e2e/branch-conversation.spec.ts`：桌面端和移动端真实浏览器闭环。

当前完整工程检查结果：

```text
ESLint：通过
TypeScript：通过
Vitest：15 个测试文件、55 个测试通过
Next.js production build：通过
Playwright：2 个浏览器用例通过
```

## 11. 当前尚未完成的范围

下面内容属于未来扩展，本文档不能把它们描述成已经完成：

- 分支中的分支；
- 选中文字创建分支；
- 把分支结论合并回主对话；
- 分支图片输入。

这些内容不属于当前第一版分支闭环的完成条件。

## 12. 阅读代码的推荐顺序

第一次复盘建议按下面顺序阅读：

1. `app/lib/ai/message.ts`
2. `app/lib/branches/types.ts`
3. `migrations/0002_add_branch_relations.sql`
4. `app/lib/branches/data.ts`
5. `app/(chat)/branch-actions.ts`
6. `app/(chat)/messages.tsx`
7. `app/(chat)/chat.tsx`
8. `app/lib/branches/url.ts`
9. `app/(chat)/branch/branch-panel.tsx`
10. `app/lib/branches/messages.ts`
11. `app/(chat)/branch/branch-chat.tsx`
12. `app/(chat)/api/chat/route.ts`
13. `app/(chat)/branch/branch-composer.tsx`
14. 对应测试文件

重点不是记住每一行，而是能够独立讲清：

- 为什么必须先统一消息 ID；
- 为什么新消息向 AI SDK 传 `id` 而不是 `messageId`；
- 为什么分支和第一条消息需要同一事务；
- 为什么数据库唯一约束比前端判断更可靠；
- 怎样通过锚点截断主对话上下文；
- 为什么继承消息要参与模型请求但不能显示；
- 为什么主对话和分支必须拥有独立 `useChat`；
- 为什么草稿不能立即写入 URL；
- 为什么未回答消息要复用原 user ID 重新生成；
- 为什么分支历史最终由服务端根据 branchId 组装。

## 13. 面试表达参考

可以把功能概括为：

> 我针对 AI 长对话中临时追问污染主线的问题，实现了单向继承上下文的分支对话。分支以已完成并持久化的 assistant 消息作为锚点，继承主对话截至锚点的上下文，但主线不会反向读取分支消息。实现上，我先统一了 UI、流式响应和数据库消息 ID，再用自关联 chat 数据模型和唯一锚点约束保证一条消息一个分支，通过事务实现首次提交才创建且不留下空分支。前端使用独立 `useChat` 隔离主线与分支状态，并用 `?branch=` 恢复刷新和浏览器历史；分支请求只上传最新问题，服务端根据 branchId 重新组装继承前缀和分支历史。最后通过单元、组件、数据层和真实浏览器测试验证上下文边界、幂等、异常恢复和桌面/移动端交互。





# 附录：四个阶段的原始规划记录（历史材料）

> 以下内容保留了实施前的阶段规划和讨论原文，便于回顾设计演进，其中“当前”“将要”和
> “尚未完成”等措辞指当时状态，不代表现在的项目状态。当前实现请以前文第 1—13 节为准。

# 阶段一

第一阶段的目标可以压缩成一句话：

> 让一条消息从创建、流式展示、数据库保存到点赞和未来创建分支，始终使用同一个可信 ID，并且能够判断它是完整回答还是中断回答。

这一阶段暂时不创建分支表，也不写分支侧栏。
一、当前项目的问题
---------

### 用户消息 ID 不一致

现在客户端调用：
    sendMessage({
      role: 'user',
      parts: [...]
    })

没有主动提供 ID，所以 AI SDK 会生成一个客户端消息 ID。

服务端写数据库时又没有使用这个 ID：
    INSERT INTO messages (chat_id, role, content)

数据库重新生成一个 UUID。

因此：
    客户端用户消息 ID ≠ 数据库用户消息 ID

### assistant 消息 ID 也不一致

AI SDK 流式生成 assistant 消息时生成一个 UI ID，但服务端完成后插入数据库时，又让数据库生成新的 UUID：
    AI SDK assistant ID ≠ 数据库 assistant ID

这就是为什么刚生成完的消息直接点赞，可能提示“消息不存在”。

未来分支按钮也会遇到同样的问题：
    用户点击 UI 消息 A
        ↓
    拿 UI messageId 创建分支
        ↓
    数据库中找不到这个 ID
二、我们最终要建立的消息 ID 流程
------------------

### 用户消息

    浏览器生成 UUID
        ↓
    AI SDK 使用这个 UUID
        ↓
    请求把这个 UUID 发给服务端
        ↓
    数据库使用这个 UUID 插入用户消息

### assistant 消息

    服务端在生成开始前生成 UUID
        ├→ AI SDK 流式消息使用这个 UUID
        └→ 数据库存储使用这个 UUID

最终达到：
    UI message.id
    =
    AI SDK 流消息 ID
    =
    数据库 messages.id
三、阶段 A1：定义统一消息契约
----------------

首先需要明确消息 ID 和持久化状态。

### 消息 ID

所有消息 ID 都必须是标准 UUID。

当前 Zod 只要求：
    id: z.string().min(1)

要改成 UUID 校验：
    id: z.string().uuid()

这样客户端不能传入：
    {
      "id": "abc"
    }

避免未来拿非法 ID 查询、点赞或创建分支。

### 持久化状态

这里要区分两种不同的状态。

AI SDK 的运行时状态：
    ready
    submitted
    streaming
    error

它们只描述当前浏览器请求。

数据库消息状态描述这条 assistant 回答最终是什么结果：
    completed     完整生成并成功保存
    interrupted   用户主动停止，保存了部分回答

建议给 `messages` 增加：
    status VARCHAR(20) NOT NULL DEFAULT 'completed'

并限制：
    completed
    interrupted

旧消息全部自动视为 `completed`。

不建议在数据库里存 `streaming` 状态，因为流式消息还没有最终内容。我们不需要在生成开始时插入一条空 assistant 消息。

换句话说：
    浏览器负责 submitted / streaming / error
    数据库负责 completed / interrupted

两套状态不要混在一起。
四、阶段 A2：统一用户消息 ID
-----------------

每次真正提交用户消息之前生成：
    const userMessageId = crypto.randomUUID()

然后明确传给 AI SDK：
    sendMessage({
      messageId: userMessageId,
      role: 'user',
      parts: [...]
    })

输入框发送和建议词发送都必须走同一个函数，否则：

* 输入框消息使用 UUID；
* 建议词仍由 AI SDK 自动生成 ID；
* 系统里又会出现两种 ID 规则。

所以这一步顺便完成最小范围的统一发送入口：
    输入框 ─┐
            ├→ submitMessage → 生成 UUID → sendMessage
    建议词 ─┘

服务端收到请求后，写入时使用：
    lastMessage.id

而不是数据库重新生成：
    INSERT INTO messages (
      id,
      chat_id,
      role,
      content
    )
    SELECT
      用户消息 ID,
      ...

数据库主键继续负责防止相同 ID 重复插入。
五、阶段 A3：统一 assistant 消息 ID
--------------------------

服务端调用模型前生成：
    const assistantMessageId = crypto.randomUUID()

然后把这个 ID 同时交给两个地方。

### 交给 AI SDK 流式响应

AI SDK 6 的 `toUIMessageStreamResponse` 支持：
    generateMessageId

我们会把服务端生成的 UUID作为这条 assistant UI 消息的 ID。

### 交给数据库

生成结束后插入：
    INSERT INTO messages (
      id,
      chat_id,
      role,
      content,
      status
    )

其中：
    id = assistantMessageId

这样刚生成的 assistant 消息无需刷新，UI 上的 ID 就已经是数据库 ID。
六、阶段 A4：调整 assistant 的保存位置
--------------------------

当前 assistant 数据库写入发生在：
    streamText({
      onFinish: ...
    })

这个回调适合处理模型正常完成，但无法完整表达 UI 流是否被用户中止。

AI SDK 的 UI Message Stream 层可以提供：
    responseMessage
    isAborted
    finishReason

因此建议把消息持久化移动到：
    toUIMessageStreamResponse 的 onFinish

它能同时拿到：

* 最终 assistant UI 消息；
* 服务器生成的统一消息 ID；
* 完整 parts；
* 是否被中止；
* 最终结束原因。

正常完成：
    status = completed
    content = 完整回答

用户停止：
    status = interrupted
    content = 已经生成的部分回答

原来 `streamText.onFinish` 中的插入要移除，避免 assistant 被写入两次。
七、停止后的处理规则
----------

用户点击停止后：

1. AI SDK 终止请求；
2. UI 保留已收到的部分文字；
3. 服务端使用同一个 assistant UUID 保存部分文字；
4. 数据库标记为 `interrupted`；
5. 刷新页面后部分回答仍然存在；
6. 页面显示“已停止生成”；
7. 这条消息不允许点赞；
8. 这条消息不允许创建分支。

为什么不允许对中断回答创建分支？

因为分支锚点应该是语义完整、稳定的回答。否则用户停止在半句话：

> 这个项目可以采用前端……

然后基于它创建分支，继承的上下文本身就是残缺的。

以后如果确实需要，可以再放宽；第一版只允许 `completed`。
八、请求失败如何处理
----------

如果模型在没有产生有效 assistant 内容之前失败：

* 用户消息已经保存；
* 不创建空 assistant 数据库记录；
* 页面显示错误；
* 用户可以重试。

如果已经产生了一部分内容后异常失败，第一版可以按保守策略处理：

* 当前页面暂时显示部分内容；
* 不将其标记为 `completed`；
* 不允许点赞和创建分支。

暂时不增加 `failed` 数据库状态，避免第一阶段扩展过多。以后完善错误恢复时再决定是否保存失败的部分回答。
九、阶段 A5：历史消息加载状态
----------------

当前历史页面只查询：
    id, role, content, created_at

需要同时查询：
    status

转换为 `UIMessage` 时，放进消息 metadata：
    {
      id,
      role,
      parts,
      metadata: {
        persistenceStatus: status
      }
    }

建议定义项目自己的消息类型：
    type ChatMessageMetadata = {
      persistenceStatus: 'completed' | 'interrupted'
    }

    type ChatMessage = UIMessage<ChatMessageMetadata>

这样后面组件不再使用完全无约束的普通 `UIMessage`。
十、阶段 A6：限制消息操作出现的时机
-------------------

当前 `Messages` 只要发现：
    message.role === 'assistant'

就显示点赞按钮。

要改成：
    assistant
    +
    已经完成流式生成
    +
    status === completed
    =
    可以操作

生成中的最后一条 assistant 消息：
    不显示点赞
    不显示分支

主动停止的消息：
    显示“已停止生成”
    不显示点赞
    不显示分支

正常完成的消息：
    显示点赞
    以后显示分支

第一阶段还不真正显示分支按钮，但要把判断能力准备好。
十一、阶段 A7：修复点赞链路
---------------

统一 ID 后，点赞调用：
    addLikes(chatId, message.id, true)

其中 `message.id` 就是数据库主键，不再出现：
    前端有这个 ID
    数据库没有这个 ID

服务端现有的资源归属查询可以继续使用：
    message.id
    + message.chat_id
    + chat.user_id

另外应该补一个小问题：当前点赞先乐观变绿，如果服务端失败，并没有回滚。第一阶段可以顺手调整为：
    点击点赞
        ↓
    立即变绿
        ↓
    服务端失败
        ↓
    恢复原状态并显示错误

不在这个阶段设计复杂的用户点赞表。当前 `likes` 计数逻辑先保留。
十二、数据库改动范围
----------

这一阶段只改 `messages`：
    增加 status 字段
    增加 status CHECK 约束
    旧消息默认为 completed

不增加：

* `parent_chat_id`；
* `branch_from_message_id`；
* 分支表；
* 上下文查询；
* 复杂迁移平台。

分支字段属于第二阶段。
十三、需要修改的文件
----------

预计会涉及：

* [request.ts](D:/前端练习/nextjs-practise/nextjs-dashboard/app/lib/validation/request.ts)  
  统一 UUID 校验和消息 metadata 类型。

* [chat.tsx](D:/前端练习/nextjs-practise/nextjs-dashboard/app/(chat\)/chat.tsx)  
  统一发送入口，为用户消息生成 UUID，读取完成/中止结果。

* [route.ts](D:/前端练习/nextjs-practise/nextjs-dashboard/app/(chat\)/api/chat/route.ts)  
  使用用户 ID 写入数据库，生成 assistant ID，并在 UI stream 完成回调中持久化。

* [page.tsx](D:/前端练习/nextjs-practise/nextjs-dashboard/app/(chat\)/chat/[id]/page.tsx)  
  加载数据库消息状态并转换成项目消息类型。

* [messages.tsx](D:/前端练习/nextjs-practise/nextjs-dashboard/app/(chat\)/messages.tsx)  
  根据消息完成状态决定是否显示操作。

* [message-feedback.tsx](D:/前端练习/nextjs-practise/nextjs-dashboard/app/components/message-feedback.tsx)  
  修复乐观更新失败回滚。

* 数据库迁移文件  
  增加 `messages.status`。

* 验证测试文件  
  覆盖 UUID、多轮历史和消息状态。

十四、第一阶段验收标准
-----------

完成后必须满足：

1. 用户消息 UI ID 与数据库 ID 完全一致。
2. assistant 流式消息 ID 与数据库 ID 完全一致。
3. 新生成的 assistant 消息无需刷新即可点赞。
4. 页面刷新后消息 ID 不发生变化。
5. 第二轮、第三轮消息继续正常发送。
6. 正常回答被标记为 `completed`。
7. 主动停止后的部分回答刷新后仍然存在。
8. 中断回答被标记为 `interrupted`。
9. 生成中和中断消息不能点赞。
10. 未来的分支按钮可以直接使用 `message.id` 作为锚点。
11. 非 UUID 消息 ID 被服务端拒绝。
12. 类型检查、Lint、单元测试和构建全部通过。

推荐的实际执行顺序
---------

为了降低一次改太多造成的风险，我会拆成四次实现和验证：
    A1：数据库 status + 项目消息类型
    A2：统一用户消息 ID
    A3：统一 assistant ID + 完成/中断持久化
    A4：操作显示规则 + 点赞验证 + 测试

每一步完成后都单独验证正常发送和第二轮对话。第一步真正开始修改时，应从 `A1：消息状态字段和统一类型` 开始。





# 阶段二

我已经重新阅读了 [PROJECT_DIRECTION.md](/D:/前端练习/nextjs-practise/nextjs-dashboard/PROJECT_DIRECTION.md) 中关于分支对话的产品规则、数据模型和上下文隔离要求。

第二阶段对应文档中的“阶段 B：数据关系与上下文”。这一阶段的目标是：

> 让数据库能够可靠表达“这个分支属于哪个主对话、从哪条 assistant 消息产生”，并能准确查询分支需要继承的上下文。

这一阶段仍然不做右侧分支面板，不实现分支聊天 UI。
B1：给 `chats` 增加分支关系
-------------------

主对话和分支继续复用同一个 `chats` 表，只增加两个字段：
    chats
    ├── id
    ├── user_id
    ├── title
    ├── parent_chat_id
    ├── branch_from_message_id
    └── created_at

含义：

* `parent_chat_id`：这个分支属于哪个主对话。
* `branch_from_message_id`：从主对话中的哪条 assistant 消息创建。

主对话：
    parent_chat_id = NULL
    branch_from_message_id = NULL

分支：
    parent_chat_id = 主对话 ID
    branch_from_message_id = assistant 锚点消息 ID

数据库约束会包括：
    parent_chat_id
      REFERENCES chats(id)
      ON DELETE CASCADE

    branch_from_message_id
      REFERENCES messages(id)
      ON DELETE CASCADE

    UNIQUE (branch_from_message_id)

还会增加组合检查：
    两个字段必须同时为空，或者同时有值

这样数据库自身就能保证：

* 不会出现“有父对话但没有锚点”的残缺分支；
* 一条 assistant 消息最多创建一个分支；
* 删除主对话时自动删除它的分支；
* 删除分支不会影响主对话。

现有聊天自动保持两个字段为空，因此都属于主对话。
B2：定义分支数据契约
-----------

类似第一阶段定义 `ChatMessage`，第二阶段会定义统一的分支类型：
    type BranchChat = {
      id: string
      parentChatId: string
      branchFromMessageId: string
      title: string
      createdAt: Date
    }

创建分支的输入只接受：
    {
      parentChatId: UUID
      anchorMessageId: UUID
    }

还会定义分支读取结果：
    type BranchConversation = {
      branch: BranchChat
      anchorMessage: ChatMessage
      inheritedMessages: ChatMessage[]
      branchMessages: ChatMessage[]
    }

把继承消息与分支自己的消息分开很重要。第三阶段可以：
    模型上下文 = inheritedMessages + branchMessages
    界面显示   = branchMessages

不会因为数组混在一起而把主对话历史错误显示在分支面板中。
B3：实现“创建或打开已有分支”
----------------

计划实现一个类似下面的服务端操作：
    getOrCreateBranch(parentChatId, anchorMessageId)

它不是每次点击都盲目创建新记录，而是：
    点击分支
       ↓
    检查锚点是否合法
       ↓
    已有分支 → 返回已有分支
    没有分支 → 创建并返回

创建时必须在数据库查询中同时证明：

* 主对话属于当前用户；
* `parent_chat_id IS NULL`，防止从分支中继续创建分支；
* 锚点消息属于这个主对话；
* 锚点角色是 `assistant`；
* 锚点状态是 `completed`；
* 消息 ID 与第一阶段生成的稳定 ID 一致。

不会先查所有权，再单独插入。验证条件会直接进入创建查询，降低并发和越权风险。

### 处理重复点击

数据库的唯一约束负责兜底：
    UNIQUE(branch_from_message_id)

即使用户快速点击两次，或两个请求同时到达，也只能存在一个分支。

第二次请求不会返回普通数据库错误，而是查询并返回已经创建的分支。因此该操作具有幂等性：
    同一个用户对同一个锚点调用多次
    → 永远得到同一个 branchId
B4：实现固定的父对话前缀查询
---------------

分支不能继承整个主对话，只能继承截至锚点的部分。

例如：
    主对话：M1 → A1 → M2 → A2 → M3
                        └→ 分支

从 A2 创建的分支只能继承：
    M1、A1、M2、A2

不能包含：
    M3

查询时会以 `branch_from_message_id` 为截止位置：
    父对话中从第一条消息到锚点消息
    +
    分支 chat 自己已经保存的消息

返回结果保持拆分：
    {
      inheritedMessages: [M1, A1, M2, A2],
      branchMessages: [B1, BA1, B2, BA2]
    }

这样即使主对话后来继续增加 M4、M5，已有分支的继承范围也不会变化。

这一阶段只完成可靠的数据查询。第三阶段建立 `BranchChat` 时再把它交给独立的 `useChat`。
B5：实现分支读取和删除
------------

读取分支时不能只通过 `branchId` 查询，必须同时验证：
    branch.user_id = 当前用户
    branch.parent_chat_id = 当前主对话
    anchor.chat_id = 当前主对话

避免用户构造其他人的 `branchId`。

删除规则：
    删除分支
    → 删除分支 chat
    → 级联删除分支自己的 messages
    → 主对话和锚点消息保持不变

删除主对话：
    删除主对话
    → 级联删除它的所有分支
    → 删除主对话和分支各自的 messages

同时会限制现有的主对话删除逻辑只删除：
    parent_chat_id IS NULL

分支删除走独立入口，避免两种资源的语义混乱。
B6：让主聊天列表排除分支
-------------

目前侧边栏查询所有属于用户的 `chats`。

增加分支后必须改成：
    WHERE user_id = 当前用户
      AND parent_chat_id IS NULL

否则每个分支都会作为普通历史对话出现在左侧列表中。

直接访问当前 `/chat/[id]` 主对话页面时，也会限制：
    只能把 parent_chat_id IS NULL 的 chat 当成主对话加载

分支以后通过：
    /chat/main-chat-id?branch=branch-chat-id

恢复，而不是作为普通主对话页面打开。
B7：测试数据关系和上下文隔离
---------------

第二阶段重点测试数据正确性，还不测试面板样式。

至少覆盖：

1. 完整 assistant 消息能够创建分支。
2. `user` 消息不能作为锚点。
3. `interrupted` 消息不能作为锚点。
4. 其他用户的聊天和消息不能创建分支。
5. 分支中的 assistant 消息不能继续创建子分支。
6. 同一锚点重复创建，返回相同 `branchId`。
7. 不同 assistant 消息可以创建不同分支。
8. 分支继承内容准确截止到锚点。
9. 锚点之后的主对话消息不会进入分支上下文。
10. 分支自己的多轮消息能够被查询出来。
11. 主对话上下文查询不包含任何分支消息。
12. 删除分支不会删除主对话。
13. 主侧边栏不显示分支。
14. 数据库唯一约束和级联关系有效。
15. 类型检查、Lint、测试和构建通过。

第二阶段不会做的内容
----------

为了不偏离原方向，这一阶段明确不做：

* 分支按钮；
* 右侧分支面板；
* 移动端 Sheet；
* 第二个 `useChat`；
* `?branch=` URL 状态；
* 刷新恢复分支面板；
* 分支中的分支；
* 选中文字创建分支；
* 把分支内容合并回主线；
* 重写整个聊天协议；
* 客户端只发送最新消息、服务端重新组装全部上下文。

这些分别留给第三、第四阶段。

第二阶段完成后的项目表面上不会出现大量新 UI，但底层将具备三个关键能力：
    可靠创建唯一分支
    +
    可靠确定继承截止位置
    +
    可靠隔离主线与分支数据

第三阶段才会在这套数据基础上实现真正可见的分支交互。





# 阶段三

我重新核对了 `PROJECT_DIRECTION.md` 和当前代码。阶段三的定位很明确：

> 把阶段一的稳定消息身份、阶段二的数据关系，真正接到用户可操作的分支界面上。

阶段三主要是前端工作，不再扩展数据库设计，也暂时不做 URL 刷新恢复——那属于阶段四。

三个原则继续保持不变：

1. 分支只继承主对话到锚点为止的内容。
2. 分支不读取锚点之后的主对话。
3. 主对话永远不读取分支内容。

阶段三完成后的效果
---------

用户在一条已完成的 assistant 消息下点击“分支”：
    点击分支按钮
        ↓
    查询该消息是否已有分支
        ├─ 没有：打开右侧草稿面板，不写数据库
        └─ 已有：读取并打开原来的分支

如果是草稿分支：
    用户输入问题
        ↓
    前端生成用户消息 ID
        ↓
    创建分支 + 保存首条用户消息
        ↓
    启动分支自己的 AI 流式请求
        ↓
    用户可以在分支里继续多轮追问

整个过程中，主对话的消息数组不会加入任何分支消息。

* * *

C1：给 assistant 消息增加分支入口
=======================

修改主对话的消息操作区，在点赞旁边增加“分支”按钮。

按钮只出现在满足以下条件的消息上：
    role === assistant
    并且
    persistenceStatus === completed

因此下面这些消息不能创建分支：

* 正在流式生成的消息；
* 用户主动停止的 `interrupted` 消息；
* 尚未成功持久化的消息；
* 用户消息。

这里会继续复用已经存在的：
    isMessageStableForActions(message)

不会再写一套不同的判断规则。

`Messages` 会增加一个可选回调，大致职责是：
    onOpenBranch(message)

只有主对话传入这个回调。分支自己的消息列表不传，因此不会出现“分支中的分支”。

* * *

C2：建立分支面板控制状态
=============

主 `Chat` 只保存当前选中的锚点，例如：
    {
      messageId,
      preview
    }

具体查询、创建和加载过程交给新的 `BranchPanel` 管理，避免继续把所有逻辑塞进已经较大的 `Chat` 组件。

面板需要四种最基本的界面状态：
    loading：正在查询已有分支
    draft：锚点合法，但还没有分支
    ready：已有分支，可以聊天
    error：查询或创建失败

这些不是数据库中的持久化状态，只是前端异步请求过程中用户真实能观察到的四种界面。

例如：

* 点击后不能瞬间得到查询结果，所以需要 `loading`；
* 没有分支但又不能立即创建，所以需要 `draft`；
* 数据加载成功后进入 `ready`；
* 网络失败后需要 `error`，并允许重试。

点击另一条 assistant 消息时，旧面板状态会被丢弃，根据新的锚点重新查询，避免两个异步结果互相覆盖。

* * *

C3：实现响应式分支面板
============

新增独立的 `BranchPanel`。

桌面端：
    ┌────────────────────主对话───────────────────┬────分支面板────┐
    │                                             │ 基于这条回答    │
    │                                             │ 锚点摘要        │
    │                                             │ 分支消息        │
    │                                             │ 分支输入框      │
    └─────────────────────────────────────────────┴────────────────┘

移动端使用占满页面的 Sheet：
    ┌──────────────────────┐
    │ ← 返回    分支对话    │
    │ 基于这条回答          │
    │                      │
    │ 分支消息列表          │
    │                      │
    │ 分支输入框            │
    └──────────────────────┘

面板内容包括：

* 关闭按钮；
* “基于这条回答”的锚点摘要；
* “已继承截至此处的 N 条主对话消息”；
* 分支自己的消息列表；
* 分支输入框；
* 加载、流式生成、停止和错误状态。

为了在还没有创建分支的草稿状态下显示继承数量，阶段三需要给只读查询结果补充一个 `inheritedMessageCount`。这是为了支持界面展示的小幅数据补充，不改变阶段二的数据模型。

* * *

C4：严格实现“首次提交才创建”
================

这是阶段三最重要的一条交互链路。

打开草稿面板时：
    只调用 findBranchByAnchor
    数据库没有新增记录

用户真正提交问题时：

1. 前端生成第一条分支用户消息的 UUID。
2. 调用 `createBranchOnFirstSubmit`。
3. 服务端在事务中创建分支并保存这条用户消息。
4. 服务端返回真正的 `branchId`。
5. 前端使用这个 `branchId` 启动分支聊天。

大致数据形态：
    const firstMessage = {
      id: crypto.randomUUID(),
      content: input,
    }

    createBranchOnFirstSubmit({
      parentChatId,
      anchorMessageId,
      firstMessage,
    })

如果创建失败：

* 保留输入框内容；
* 显示错误；
* 允许重新提交；
* 不关闭面板。

如果分支创建成功但后续 AI 请求失败：

* 分支和用户问题仍然存在；
* 再次打开时可以恢复；
* 不会留下完全没有消息的空分支。

* * *

C5：实现独立的 `BranchChat`
=====================

主对话与分支各自拥有一个独立的 `useChat`：
    MainChat
    └── useChat({ id: mainChatId })

    BranchChat
    └── useChat({ id: branchId })

它们不能共享同一个 `messages` 数组。

分支初始化时，阶段二会返回：
    {
      inheritedMessages,
      branchMessages
    }

交给模型的完整消息是：
    inheritedMessages
    + branchMessages

但是分支面板只渲染：
    branchMessages

也就是说：
    useChat 内部上下文：
    M1 → A1 → M2 → A2 → B1 → BA1

    分支面板实际显示：
    B1 → BA1

继承消息真实存在于分支 `useChat` 的上下文中，但不会重复展示在侧边栏里。

后续在分支中发送第二个问题时：
    继承的主对话前缀
    + 第一轮分支问答
    + 第二个分支问题

主对话继续发送时仍然只使用自己的：
    M1 → A1 → M2 → A2 → M3

这就是两个独立 `useChat` 的核心价值：不是简单用 CSS 隐藏消息，而是从状态源上隔离。

* * *

C6：分支输入与流式状态
============

第一版分支输入框只支持文本，不同时把图片上传、模型切换等功能搬进去，避免阶段三范围膨胀。

它需要支持：

* Enter 发送；
* Shift+Enter 换行；
* 空内容拦截；
* 请求进行时禁止重复提交；
* 流式生成时显示停止按钮；
* 请求失败后保留输入或允许继续；
* 用户停止后标记 assistant 消息为 `interrupted`；
* 自动滚动到分支消息底部。

分支聊天会复用现有的：

* `ChatMessage`；
* `ChatRuntimeStatus`；
* `isChatRequestInProgress`；
* `getMessagePersistenceStatus`；
* Markdown 消息渲染；
* 稳定消息操作判断。

但不会直接复用主对话全部状态，尤其不能把主对话的 `stop`、`error`、`status` 传给分支。

* * *

C7：首次分支消息的特殊衔接
==============

阶段二已经提前为这里处理了幂等问题。

首次提交时，用户消息会先随分支创建事务写入数据库；随后 `BranchChat` 再携带同一个消息 ID 请求 `/api/chat`：
    数据库中已经存在 messageId-X
            ↓
    /api/chat 再收到 messageId-X
            ↓
    验证 ID、branchId、角色、内容和用户完全一致
            ↓
    不重复插入，继续生成 assistant 回答

前端需要保证同一个 ID 被复用：
    草稿中的第一条用户消息 ID
    = createBranchOnFirstSubmit 保存的 ID
    = BranchChat 发送给 /api/chat 的 ID
    = 分支 UI 中显示的 ID

这正是阶段一消息 ID 统一和阶段二幂等处理在阶段三的落地点。

* * *

C8：阶段三测试重点
==========

虽然系统性的刷新恢复和权限测试放在阶段四，阶段三仍然会补基础组件测试：

1. 只有已完成的 assistant 消息显示分支按钮。
2. 分支消息中不显示再次创建分支的入口。
3. 点击没有分支的锚点只打开草稿，不调用创建函数。
4. 第一次提交才调用 `createBranchOnFirstSubmit`。
5. 创建时复用前端生成的用户消息 ID。
6. 已有分支时直接加载，不创建第二个。
7. 分支面板只渲染 `branchMessages`。
8. 分支加载、创建失败时显示错误并允许重试。
9. 主对话和分支分别维护自己的请求状态。

* * *

阶段三计划新增的主要组件
------------

预计会形成下面的边界：
    Chat
    ├── Messages
    │   └── BranchButton
    └── BranchPanel
        ├── BranchAnchorSummary
        ├── BranchDraft
        └── BranchChat
            ├── BranchMessages
            └── BranchComposer

不一定为每个名字都建立单独文件；过小的展示组件可以留在父组件中。真正需要独立的主要是：

* `BranchPanel`：负责查询、草稿、加载与面板生命周期；
* `BranchChat`：负责独立 `useChat` 和分支流式状态；
* `BranchComposer`：负责分支文本提交和停止。

阶段三明确不做
-------

为了防止方向扩大，本阶段不做：

* `?branch=` URL 参数；
* 刷新后自动恢复面板；
* 浏览器前进、后退恢复；
* 分支中的分支；
* 选中文字提问；
* 合并或引用回主对话；
* 分支图片上传；
* 重新设计模型选择；
* 重写聊天接口为服务端重新组装全部上下文；
* 分支搜索和树状结构。

其中 URL 状态、刷新恢复和更完整的集成测试放到阶段四。
阶段三验收标准
-------

阶段三完成后，应当能手动演示下面的完整流程：
    选择一条已完成的 AI 回答
    → 点击分支
    → 打开草稿，数据库尚无分支
    → 输入并提交问题
    → 创建唯一分支
    → AI 基于截至锚点的上下文回答
    → 在分支里继续多轮追问
    → 关闭分支
    → 再次点击同一锚点
    → 打开原来的分支
    → 主对话消息始终没有混入分支问答

刷新恢复暂时不作为阶段三的验收条件，因为那是阶段四的核心任务。





# 阶段四

我重新对照了 [PROJECT_DIRECTION.md](D:/前端练习/nextjs-practise/nextjs-dashboard/PROJECT_DIRECTION.md) 和 [BRANCH_CONVERSATION_IMPLEMENTATION.md](D:/前端练习/nextjs-practise/nextjs-dashboard/BRANCH_CONVERSATION_IMPLEMENTATION.md)。阶段四不会增加新的产品能力，而是把前三阶段已经完成的分支功能做成一个**可恢复、可信、可完整演示的闭环**。
阶段四：路由恢复、异常处理与最终验收
==================

D1：定义分支 URL 状态
--------------

采用已经确定的地址格式：
    /chat/主对话ID?branch=分支ID

需要实现：

* 打开已经存在的分支时，将 `branchId` 写入 URL；
* 首次提交并真正创建分支后，再把新 `branchId` 写入 URL；
* 仅仅打开尚未创建的草稿分支时，不修改 URL；
* 关闭分支时移除 `branch` 参数；
* 保留 URL 中可能存在的其他查询参数；
* 非法 UUID 不进入后续分支查询。

这里最重要的规则是：
    草稿状态 → 只存在前端内存中
    持久化分支 → 可以进入 URL

这样不会因为用户只是点开面板，就破坏“首次提交才创建分支”的设计。

预计主要涉及：

* `app/(chat)/chat.tsx`
* 分支 URL 相关的小型工具函数
* 请求校验 Schema

* * *

D2：让 URL 成为持久化分支的状态来源
---------------------

目前面板是否打开完全取决于：
    activeBranchAnchor

刷新页面后这个 React 状态消失，面板自然也会消失。

改动后需要支持两种打开来源：
    点击 assistant 消息
    → 根据锚点打开草稿或已有分支

    URL 中存在 branchId
    → 根据 branchId 恢复已有分支

具体需要做到：

* 刷新带有 `?branch=` 的页面后重新打开正确分支；
* 根据 `branchId` 读取分支和锚点信息；
* 恢复分支历史消息；
* 浏览器前进、后退时同步打开或关闭面板；
* 从别人复制的链接进入时可以直接定位分支；
* 切换不同分支时，面板不会被旧请求结果覆盖。

为了支持两种打开方式，`BranchPanel` 的入口会从“只能接收锚点消息”调整为可以接收：
    锚点消息 → 用户点击打开
    branchId → URL 恢复打开

URL 只负责描述当前打开哪个分支，不保存消息内容。

* * *

D3：处理无效 URL 和资源归属
-----------------

浏览器传来的 `branchId` 不能直接信任。

服务端读取时继续验证：
    当前用户
      ↓
    拥有当前主对话
      ↓
    分支属于这个主对话
      ↓
    锚点属于这个主对话

需要处理：

* 分支 ID 格式非法；
* 分支不存在；
* 分支属于其他主对话；
* 分支属于其他用户；
* 分支已经被删除。

这些情况都不能泄露其他用户是否拥有对应资源。

交互上不让整个主对话页面崩溃，而是：

* 主对话仍然正常显示；
* 分支面板显示统一的“分支不存在或无权访问”；
* 用户可以关闭面板；
* 关闭后清理错误的 `branch` 查询参数。

这一步不建立新的权限系统，只复用阶段二已经完成的归属查询。

* * *

D4：补齐异常恢复和分支生命周期
----------------

### D4.1 首条问题没有得到回答

目前存在一个边界情况：
    分支和首条用户消息已经写入数据库
    → AI 请求没有成功启动或中途失败
    → 刷新后只剩一条没有回答的用户消息

需要增加明确的恢复入口：

* 检测分支最后一条消息是不是用户消息；
* 显示“上一条问题尚未获得回答”；
* 提供“重新生成”按钮；
* 重新生成时复用原用户消息，不重复插入；
* 普通错误可以关闭，也可以原地重试，无需刷新页面。

### D4.2 关闭或切换正在生成的分支

确定统一规则：

* 分支正在生成时关闭面板，先停止当前分支请求；
* 已经生成的部分内容按照现有规则保存为 `interrupted`；
* 不让请求在已经卸载的分支界面背后继续运行；
* 主对话的生成状态不受影响。

### D4.3 分支删除 UI

后端已经有 `deleteBranch`，阶段四补前端入口：

* 已创建分支显示删除按钮；
* 删除前二次确认；
* 生成过程中禁止删除；
* 删除成功后关闭面板并移除 URL 参数；
* 删除分支自己的消息；
* 主对话和锚点消息保持不变；
* 删除后再次点击锚点，重新进入草稿状态。

* * *

D5：服务端重新组装分支上下文
---------------

当前分支的上下文是：
    BranchChat 中的完整 messages
    → 浏览器发送给 /api/chat
    → 服务端直接交给模型

正常使用时已经能够满足隔离规则，但隔离仍然依赖浏览器正确传参。

阶段四会只针对分支请求进行加固：
    客户端提交 branchId + 最新用户消息
                        ↓
    服务端验证分支归属
                        ↓
    查询主对话截至锚点的前缀
                        ↓
    查询分支自己的历史消息
                        ↓
    拼接最新问题
                        ↓
    交给模型

这样服务端最终使用的上下文固定为：
    继承前缀 + 分支历史 + 最新问题

即使客户端伪造或者误传：

* 锚点之后的主消息；
* 其他分支的消息；
* 被修改的继承消息；

也不会进入模型上下文。

这一部分只加固分支，不重写整个主对话架构，避免项目方向跑向复杂后端。

* * *

D6：完善面板可访问性和响应式细节
-----------------

现有实现已经有 Escape、焦点恢复和基本 ARIA，阶段四补最后一层：

* 面板打开后焦点进入分支区域；
* 移动端阻止背景页面滚动；
* 键盘焦点不会意外跑到遮罩后的页面；
* 关闭后焦点回到原分支按钮；
* 加载、错误、重试和删除状态可被辅助技术识别；
* 桌面端侧栏和移动端全屏模式都能正常输入、停止和关闭；
* Enter 发送、Shift+Enter 换行继续保持一致。

不做复杂动画系统，只保证交互稳定。

* * *

D7：自动化测试与最终验收
-------------

### 单元和组件测试

补充验证：

* URL 参数的添加、替换和移除；
* 草稿分支不会写入 URL；
* 首次创建成功后写入 URL；
* URL 恢复已有分支；
* 浏览器前进、后退同步面板；
* 无效或者越权分支不会打开；
* 未回答的最后一条用户消息可以重新生成；
* 删除成功后关闭面板并清理 URL；
* 关闭生成中的分支会停止请求。

### 服务端测试

重点证明：

* 服务端根据 `branchId` 重新组装上下文；
* 客户端伪造的历史消息不会进入模型；
* 锚点之后的主消息不会进入分支；
* 其他分支的消息不会混入；
* 主对话不会读取分支消息；
* 删除分支不影响主对话；
* 其他用户无法读取和删除该分支。

### Playwright 真实浏览器测试

现有 E2E 只有登录页，阶段四补分支核心流程：

1. 登录并打开主对话；
2. 点击一条已完成的 assistant 回复；
3. 只打开草稿时不创建分支；
4. 首次发送后创建分支并更新 URL；
5. 在分支中连续追问；
6. 关闭后重新打开；
7. 刷新页面恢复；
8. 浏览器后退关闭、前进重新打开；
9. 删除后主对话不受影响；
10. 分别使用桌面和移动端视口验证。

模型响应会使用可预测的测试替身，避免 E2E 依赖真实模型网络和付费接口。

* * *

阶段四完成标准
=======

阶段四完成后，下面这些场景必须全部成立：
    创建分支 → URL 可定位
    刷新页面 → 分支可恢复
    前进后退 → 面板状态同步
    异常失败 → 可以原地重试
    关闭生成 → 请求正确停止
    删除分支 → 主对话不受影响
    伪造上下文 → 服务端不接受
    桌面和移动端 → 都可完整操作

同时继续严格保持三个核心原则：

1. 分支只继承主对话到锚点为止的上下文；
2. 分支永远不读取锚点之后的主对话；
3. 主对话永远不读取分支内容。

明确不进入阶段四的内容
===========

* 选中文字创建分支；
* 一个消息创建多个分支；
* 分支中的分支；
* 把分支结论合并回主对话；
* 分支图片上传；
* 多人协作或分支分享权限；
* 复杂的限流、队列和后台任务系统。

建议实际执行顺序是：
    D1 URL 契约
    → D2 刷新与历史恢复
    → D3 非法链接处理
    → D4 异常恢复和删除
    → D5 服务端上下文加固
    → D6 交互细节
    → D7 测试与验收

这次只是制定规划，没有修改代码或文档。
