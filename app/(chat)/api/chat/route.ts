// app/(chat)/api/chat/route.ts
import { streamText, generateText, convertToModelMessages } from 'ai'
import { models } from '@/app/lib/ai/provider'
import {
  getMessagePersistenceStatus,
  getMessageText,
  type ChatMessage,
} from '@/app/lib/ai/message'
import postgres from 'postgres'
import { env } from '@/app/lib/env'
import { requireUser } from '@/app/lib/auth/require-user'
import {
  resourceNotFoundError,
  routeErrorResponse,
  validationError,
} from '@/app/lib/errors'
import {
  chatRequestSchema,
  parseJsonRequest,
} from '@/app/lib/validation/request'

const sql = postgres(env.POSTGRES_URL, { ssl: 'require' })

// ai生成标题函数
async function generateTitle(firstMessage:string):Promise<string> {
  // 根据用户输入的第一句话生成
  try {
    const { text } = await generateText({
      model: models['deepseek-chat'],
      system: '你是一个标题生成助手。根据用户的第一条消息生成一个简短的对话标题(不超过 15 字)。直接返回标题文字,不要任何引号、标点或解释。',
      prompt: firstMessage,
      maxOutputTokens: 50,
    })
    return text.trim().slice(0, 30)  // 截断防御
  } catch (error) {
    console.log(error)
    return firstMessage.slice(0,30)
  }
}

/**
 * 处理一次主对话或分支对话的 AI 流式请求。
 *
 * 通用流程是：认证与校验 → 保存最后一条用户消息 → 调用模型流式生成
 * → 根据完成或中断状态保存 assistant 消息。
 *
 * 阶段二加入的关键兼容逻辑是：第一次创建分支时，首条用户消息已经和分支
 * 在同一事务中落库，所以这里遇到相同消息 ID 不会直接报错，而会继续核对
 * chat、用户、角色和内容；只有完全一致才视为同一次请求的幂等续接。
 * 这个 Route 本身不会负责创建分支。
 */
export async function POST(req: Request) {
  try {
    // 1. 统一认证
    const user = await requireUser()

    // 2. 运行时校验请求；modelId 缺失时暂时使用服务端默认模型
    const parsedRequest = await parseJsonRequest(req, chatRequestSchema)
    const { id: chatId, modelId } = parsedRequest
    const messages: ChatMessage[] = parsedRequest.messages

    // 3. 取最后一条用户消息
    const lastMessage = messages[messages.length - 1]
    if (lastMessage.role !== 'user') {
      throw validationError('最后一条消息必须来自用户')
    }

    // 这步是为了AI SDK 的 UIMessage 格式转换成数据库能存的纯文本字符串
    const userText = getMessageText(lastMessage)

    // 4. 只查询当前用户拥有的 chat
    let ownedChat = await sql<{ id: string }[]>`
      SELECT id
      FROM chats
      WHERE id = ${chatId} AND user_id = ${user.id}
    `

    if (ownedChat.length === 0) {
      // chatId 如果已被其他用户占用，ON CONFLICT 不会覆盖原资源
      const insertedChat = await sql<{ id: string }[]>`
        INSERT INTO chats (id, user_id, title)
        VALUES (${chatId}, ${user.id}, '新对话')
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `

      if (insertedChat.length === 0) {
        // 兼容同一用户的并发首条请求，同时不泄露其他用户的资源是否存在
        ownedChat = await sql<{ id: string }[]>`
          SELECT id
          FROM chats
          WHERE id = ${chatId} AND user_id = ${user.id}
        `

        if (ownedChat.length === 0) {
          throw resourceNotFoundError('对话不存在')
        }
      } else {
        const title = await generateTitle(userText)
        await sql`
          UPDATE chats
          SET title = ${title}
          WHERE id = ${chatId} AND user_id = ${user.id}
        `
      }
    }

    // 5. INSERT ... SELECT 再次把消息写入限定在当前用户的对话中
    const insertedUserMessage = await sql<{ id: string }[]>`
      INSERT INTO messages (id, chat_id, role, content, status)
      SELECT ${lastMessage.id}::uuid, id, 'user', ${userText}, 'completed'
      FROM chats
      WHERE id = ${chatId} AND user_id = ${user.id}
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `

    if (insertedUserMessage.length === 0) {
      // 分支第一次提交时，创建分支的事务已经保存了同一个用户消息。
      // 这里只接受 ID、chat、角色和内容完全一致的记录，避免把真正的主键冲突误判为重试。
      const existingUserMessages = await sql<{ id: string }[]>`
        SELECT message.id
        FROM messages AS message
        INNER JOIN chats AS chat
          ON chat.id = message.chat_id
        WHERE message.id = ${lastMessage.id}
          AND message.chat_id = ${chatId}
          AND message.role = 'user'
          AND message.content = ${userText}
          AND chat.user_id = ${user.id}
        LIMIT 1
      `

      if (existingUserMessages.length === 0) {
        throw resourceNotFoundError('对话不存在')
      }
    }

    // 6. 调用 AI
    // A3：assistant 在开始流式输出前就拥有稳定 UUID。
    // 同一个值会交给 AI SDK 的 UI 消息和数据库记录。
    const assistantMessageId = crypto.randomUUID()
    const result = streamText({
      model: models[modelId],
      system: '你是一个有帮助的 AI 助手。用中文回复。回复要简洁。',
      messages: await convertToModelMessages(messages),
      maxOutputTokens: 1000,
      abortSignal: req.signal,
    })

    return result.toUIMessageStreamResponse<ChatMessage>({
      originalMessages: messages,
      generateMessageId: () => assistantMessageId,
      onFinish: async ({ responseMessage, isAborted, finishReason }) => {
        const assistantText = getMessageText(responseMessage)

        // 用户在首个文本片段到达前停止时，不保存一个空白助手气泡。
        if (assistantText.length === 0) return

        const wasInterrupted = isAborted || req.signal.aborted

        // 普通模型错误即使带有部分文本，第一阶段也不落库：
        // 页面可以暂时显示它，但它既不是完整回答，也不是用户主动停止的回答。
        if (!wasInterrupted && finishReason === 'error') return

        const persistenceStatus =
          getMessagePersistenceStatus(wasInterrupted)

        const insertedAssistantMessage = await sql<{ id: string }[]>`
          INSERT INTO messages (id, chat_id, role, content, status)
          SELECT
            ${assistantMessageId}::uuid,
            id,
            'assistant',
            ${assistantText},
            ${persistenceStatus}
          FROM chats
          WHERE id = ${chatId} AND user_id = ${user.id}
          RETURNING id
        `

        if (insertedAssistantMessage.length === 0) {
          throw resourceNotFoundError('对话不存在')
        }
      },
    })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

