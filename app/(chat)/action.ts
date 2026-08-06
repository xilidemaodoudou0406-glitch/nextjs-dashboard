'use server'

import { revalidatePath } from 'next/cache'
import { sql } from '@/app/lib/db/client'
import { requireUser } from '@/app/lib/auth/require-user'
import {
    actionFailure,
    actionSuccess,
    resourceNotFoundError,
    type ActionResult,
} from '@/app/lib/errors'
import {
    chatIdSchema,
    messageFeedbackSchema,
    parseInput,
} from '@/app/lib/validation/request'

/**
 * 删除当前用户的一条主对话。
 *
 * 阶段二为它增加了 `parent_chat_id IS NULL` 边界，因此这个普通删除入口
 * 不可能误删分支；分支必须通过专门的 `deleteBranch` Action 删除。
 * 删除主对话时，数据库外键会级联清理它下面的分支。
 */
export async function deleteChat (input: unknown): Promise<ActionResult> {
    try {
        const chatId = parseInput(chatIdSchema, input)
        const user = await requireUser()

        // 归属条件直接写入 DELETE，未命中时不区分“不存在”和“不属于当前用户”
        const deletedChats = await sql<{ id: string }[]>`
            DELETE FROM chats
            WHERE id = ${chatId}
              AND user_id = ${user.id}
              -- 主对话删除入口不能被拿来删除分支；分支有独立的删除 Action。
              AND parent_chat_id IS NULL
            RETURNING id
        `

        if (deletedChats.length === 0) {
            throw resourceNotFoundError('对话不存在')
        }

        revalidatePath('/')
        return actionSuccess()
    } catch (error) {
        return actionFailure(error)
    }
}

export async function addLikes (
    chatIdInput: unknown,
    messageIdInput: unknown,
    isLikeInput: unknown,
): Promise<ActionResult> {
    try {
        const { chatId, messageId, isLike } = parseInput(messageFeedbackSchema, {
            chatId: chatIdInput,
            messageId: messageIdInput,
            isLike: isLikeInput,
        })
        const user = await requireUser()

        // 一条查询同时证明 message 属于 chat，且 chat 属于当前用户
        const updatedMessages = await sql<{ id: string }[]>`
            UPDATE messages AS message
            SET likes = GREATEST(0, COALESCE(message.likes, 0) + CASE
                WHEN ${isLike} = true THEN 1
                WHEN ${isLike} = false THEN -1
                ELSE 0
            END)
            FROM chats AS chat
            WHERE message.id = ${messageId}
              AND message.chat_id = ${chatId}
              -- UI 会隐藏不可操作消息，但服务端仍必须独立校验，不能信任前端。
              AND message.role = 'assistant'
              AND message.status = 'completed'
              AND chat.id = message.chat_id
              AND chat.user_id = ${user.id}
            RETURNING message.id
        `

        if (updatedMessages.length === 0) {
            throw resourceNotFoundError('消息不存在')
        }

        return actionSuccess()
    } catch (error) {
        return actionFailure(error)
    }
}
