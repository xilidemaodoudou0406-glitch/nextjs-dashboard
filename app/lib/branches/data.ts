import type { ChatMessage, MessagePersistenceStatus } from '@/app/lib/ai/message'
import type {
  BranchAnchorLookup,
  BranchConversation,
  BranchFirstMessage,
  BranchSummary,
} from '@/app/lib/branches/types'
import { sql } from '@/app/lib/db/client'

type BranchRow = {
  id: string
  parent_chat_id: string
  branch_from_message_id: string
  title: string
  created_at: Date
}

type MessageRow = {
  id: string
  role: ChatMessage['role']
  content: string
  status: MessagePersistenceStatus
  created_at: Date
}
// 把数据库 row 格式转成应用层对象格式的一个小工具函数
function toBranchSummary(row: BranchRow): BranchSummary {
  return {
    id: row.id,
    parentChatId: row.parent_chat_id,
    anchorMessageId: row.branch_from_message_id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
  }
}

function toChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    metadata: {
      persistenceStatus: row.status,
    },
    parts: [{ type: 'text', text: row.content }],
  }
}

/**
 * 根据“主对话 + assistant 锚点消息”查找已有分支。
 *
 * 这是用户点击分支入口时使用的只读查询：
 * - 会验证主对话属于当前用户；
 * - 会验证锚点是主对话中已完成的 assistant 消息；
 * - 已有分支时返回分支摘要，没有分支时返回 `branch: null`；
 * - 不会写数据库，因此仅仅打开分支草稿不会产生空分支。
 */
export async function findBranchByAnchor({
  userId,
  parentChatId,
  anchorMessageId,
}: {
  userId: string
  parentChatId: string
  anchorMessageId: string
}): Promise<BranchAnchorLookup | null> {
  // LEFT JOIN 只查询已有分支。没有分支时仍返回合法锚点，但不会执行 INSERT。
  const rows = await sql<
    {
      parent_chat_id: string
      anchor_message_id: string
      anchor_content: string
      inherited_message_count: number
      branch_id: string | null
      branch_title: string | null
      branch_created_at: Date | null
    }[]
  >`
    SELECT
      parent.id AS parent_chat_id,
      anchor.id AS anchor_message_id,
      anchor.content AS anchor_content,
      (
        SELECT COUNT(*)::int
        FROM messages AS inherited
        WHERE inherited.chat_id = parent.id
          AND (
            inherited.created_at < anchor.created_at
            OR (
              inherited.created_at = anchor.created_at
              AND inherited.id <= anchor.id
            )
          )
      ) AS inherited_message_count,
      branch.id AS branch_id,
      branch.title AS branch_title,
      branch.created_at AS branch_created_at
    FROM chats AS parent
    INNER JOIN messages AS anchor
      ON anchor.chat_id = parent.id
    LEFT JOIN chats AS branch
      ON branch.parent_chat_id = parent.id
      AND branch.branch_from_message_id = anchor.id
      AND branch.user_id = ${userId}
    WHERE parent.id = ${parentChatId}
      AND parent.user_id = ${userId}
      AND parent.parent_chat_id IS NULL
      AND anchor.id = ${anchorMessageId}
      AND anchor.role = 'assistant'
      AND anchor.status = 'completed'
    LIMIT 1
  `

  const row = rows[0]
  if (!row) return null

  return {
    parentChatId: row.parent_chat_id,
    anchorMessageId: row.anchor_message_id,
    anchorPreview: row.anchor_content.slice(0, 120),
    inheritedMessageCount: row.inherited_message_count,
    branch:
      row.branch_id && row.branch_title && row.branch_created_at
        ? {
            id: row.branch_id,
            parentChatId: row.parent_chat_id,
            anchorMessageId: row.anchor_message_id,
            title: row.branch_title,
            createdAt: row.branch_created_at.toISOString(),
          }
        : null,
  }
}

/**
 * 在用户第一次真正提交分支问题时，创建分支并保存首条用户消息。
 *
 * 两次写入位于同一个数据库事务中：任意一步失败都会整体回滚，不会留下空分支。
 * 锚点唯一约束保证一条 assistant 消息最多只有一个分支；重复或并发提交时，
 * 函数会复用已经存在的分支，并只把完全相同的首条消息视为幂等重试。
 *
 * 返回 `null` 表示主对话、锚点或资源归属校验没有通过。
 */
export async function createBranchOnFirstSubmit({
  userId,
  parentChatId,
  anchorMessageId,
  firstMessage,
}: {
  userId: string
  parentChatId: string
  anchorMessageId: string
  firstMessage: BranchFirstMessage
}): Promise<BranchSummary | null> {
  const branchId = crypto.randomUUID()

  return sql.begin(async (transaction) => {
    // 该函数只能接收带有第一条非空用户消息的提交。
    // 分支记录和首条消息位于同一事务中：任何一步失败都不会留下空分支。
    //
    // valid_anchor 把所有权、主对话层级、消息角色和完成状态写进同一条 SQL；
    // 唯一约束和无副作用的 DO UPDATE 保证并发提交也能返回同一个分支。
    const rows = await transaction<BranchRow[]>`
      WITH valid_anchor AS (
        SELECT
          parent.id AS parent_chat_id,
          anchor.id AS anchor_message_id,
          anchor.content AS anchor_content
        FROM chats AS parent
        INNER JOIN messages AS anchor
          ON anchor.chat_id = parent.id
        WHERE parent.id = ${parentChatId}
          AND parent.user_id = ${userId}
          AND parent.parent_chat_id IS NULL
          AND anchor.id = ${anchorMessageId}
          AND anchor.role = 'assistant'
          AND anchor.status = 'completed'
      )
      INSERT INTO chats AS branch (
        id,
        user_id,
        title,
        parent_chat_id,
        branch_from_message_id
      )
      SELECT
        ${branchId}::uuid,
        ${userId}::uuid,
        CONCAT('分支：', LEFT(valid_anchor.anchor_content, 40)),
        valid_anchor.parent_chat_id,
        valid_anchor.anchor_message_id
      FROM valid_anchor
      ON CONFLICT (branch_from_message_id) DO UPDATE
      SET branch_from_message_id = EXCLUDED.branch_from_message_id
      WHERE branch.user_id = EXCLUDED.user_id
        AND branch.parent_chat_id = EXCLUDED.parent_chat_id
      RETURNING
        branch.id,
        branch.parent_chat_id,
        branch.branch_from_message_id,
        branch.title,
        branch.created_at
    `

    const branch = rows[0]
    if (!branch) return null

    const insertedMessages = await transaction<{ id: string }[]>`
      INSERT INTO messages (id, chat_id, role, content, status)
      VALUES (
        ${firstMessage.id}::uuid,
        ${branch.id}::uuid,
        'user',
        ${firstMessage.content},
        'completed'
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `

    if (insertedMessages.length === 0) {
      // 网络重试可能再次提交同一个 messageId；只有内容和归属完全一致才视为幂等重试。
      const existingMessages = await transaction<{ id: string }[]>`
        SELECT message.id
        FROM messages AS message
        INNER JOIN chats AS branch
          ON branch.id = message.chat_id
        WHERE message.id = ${firstMessage.id}
          AND message.chat_id = ${branch.id}
          AND message.role = 'user'
          AND message.content = ${firstMessage.content}
          AND branch.user_id = ${userId}
        LIMIT 1
      `

      if (existingMessages.length === 0) {
        throw new Error('Branch first message id conflicts with another message')
      }
    }

    return toBranchSummary(branch)
  })
}

/**
 * 读取一个分支展示和生成 AI 回答所需的完整上下文。
 *
 * 返回的数据被有意拆成两部分：
 * - `inheritedMessages`：主对话从第一条消息到锚点 assistant 消息为止；
 * - `branchMessages`：该分支自己产生的多轮消息。
 *
 * 这种拆分保证锚点之后的主对话消息不会进入分支，同时也方便前端只展示
 * `branchMessages`，把继承前缀仅用于模型上下文。查询还会验证用户、主对话、
 * 分支和锚点之间的完整归属关系。
 */
export async function getBranchConversation({
  userId,
  parentChatId,
  branchId,
}: {
  userId: string
  parentChatId: string
  branchId: string
}): Promise<BranchConversation | null> {
  // 先读取并验证完整关系：分支属于当前用户和主对话，锚点也确实属于该主对话。
  const branchRows = await sql<
    (BranchRow & {
      anchor_id: string
      anchor_role: ChatMessage['role']
      anchor_content: string
      anchor_status: MessagePersistenceStatus
      anchor_created_at: Date
    })[]
  >`
    SELECT
      branch.id,
      branch.parent_chat_id,
      branch.branch_from_message_id,
      branch.title,
      branch.created_at,
      anchor.id AS anchor_id,
      anchor.role AS anchor_role,
      anchor.content AS anchor_content,
      anchor.status AS anchor_status,
      anchor.created_at AS anchor_created_at
    FROM chats AS branch
    INNER JOIN chats AS parent
      ON parent.id = branch.parent_chat_id
    INNER JOIN messages AS anchor
      ON anchor.id = branch.branch_from_message_id
      AND anchor.chat_id = parent.id
    WHERE branch.id = ${branchId}
      AND branch.user_id = ${userId}
      AND branch.parent_chat_id = ${parentChatId}
      AND parent.user_id = ${userId}
      AND parent.parent_chat_id IS NULL
      AND anchor.role = 'assistant'
      AND anchor.status = 'completed'
    LIMIT 1
  `

  const branchRow = branchRows[0]
  if (!branchRow) return null

  // 继承查询被固定在 anchor 的时间位置，主对话之后新增的消息不会进入该分支。
  const inheritedRows = await sql<MessageRow[]>`
    SELECT
      message.id,
      message.role,
      message.content,
      message.status,
      message.created_at
    FROM messages AS message
    INNER JOIN chats AS parent
      ON parent.id = message.chat_id
    INNER JOIN chats AS branch
      ON branch.parent_chat_id = parent.id
    INNER JOIN messages AS anchor
      ON anchor.id = branch.branch_from_message_id
      AND anchor.chat_id = parent.id
    WHERE branch.id = ${branchId}
      AND branch.user_id = ${userId}
      AND branch.parent_chat_id = ${parentChatId}
      AND parent.user_id = ${userId}
      AND (
        message.created_at < anchor.created_at
        OR (
          message.created_at = anchor.created_at
          AND message.id <= anchor.id
        )
      )
    ORDER BY message.created_at ASC, message.id ASC
  `

  // 分支消息只按 branch.id 查询，绝不会反向混入主对话消息列表。
  const branchMessageRows = await sql<MessageRow[]>`
    SELECT
      message.id,
      message.role,
      message.content,
      message.status,
      message.created_at
    FROM messages AS message
    INNER JOIN chats AS branch
      ON branch.id = message.chat_id
    INNER JOIN chats AS parent
      ON parent.id = branch.parent_chat_id
    WHERE branch.id = ${branchId}
      AND branch.user_id = ${userId}
      AND branch.parent_chat_id = ${parentChatId}
      AND parent.user_id = ${userId}
      AND parent.parent_chat_id IS NULL
    ORDER BY message.created_at ASC, message.id ASC
  `

  return {
    branch: toBranchSummary(branchRow),
    anchorMessage: {
      id: branchRow.anchor_id,
      role: branchRow.anchor_role,
      metadata: {
        persistenceStatus: branchRow.anchor_status,
      },
      parts: [{ type: 'text', text: branchRow.anchor_content }],
    },
    inheritedMessages: inheritedRows.map(toChatMessage),
    branchMessages: branchMessageRows.map(toChatMessage),
  }
}

/**
 * 删除指定主对话下、属于当前用户的分支。
 *
 * 该查询必须同时命中 `branchId`、`parentChatId` 和 `userId`，
 * 因而不能被用来删除主对话或其他用户的分支。数据库外键会级联删除
 * 这个分支自己的消息，但不会改动主对话及其消息。
 */
export async function deleteBranchById({
  userId,
  parentChatId,
  branchId,
}: {
  userId: string
  parentChatId: string
  branchId: string
}): Promise<boolean> {
  // 只能删除明确属于该主对话的分支；主对话不会命中 parent_chat_id 条件。
  const deletedRows = await sql<{ id: string }[]>`
    DELETE FROM chats AS branch
    USING chats AS parent
    WHERE branch.id = ${branchId}
      AND branch.user_id = ${userId}
      AND branch.parent_chat_id = parent.id
      AND parent.id = ${parentChatId}
      AND parent.user_id = ${userId}
      AND parent.parent_chat_id IS NULL
    RETURNING branch.id
  `

  return deletedRows.length === 1
}
