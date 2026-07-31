import { z } from 'zod'

import { validationError, type ErrorDetails } from '@/app/lib/errors'
import { modelIds } from '@/app/lib/ai/provider'
import { messagePersistenceStatuses } from '@/app/lib/ai/message'

const textPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
    state: z.enum(['streaming', 'done']).optional(),
  })
  .passthrough()

const filePartSchema = z
  .object({
    type: z.literal('file'),
    mediaType: z.string().min(1),
    filename: z.string().optional(),
    url: z.string().min(1),
  })
  .passthrough()

// AI SDK 会在 assistant 消息中加入步骤边界；推理模型还可能返回 reasoning。
// 多轮请求会把这些历史 parts 再次发送到服务端，因此必须在运行时契约中显式支持。
const stepStartPartSchema = z
  .object({
    type: z.literal('step-start'),
  })
  .passthrough()

const reasoningPartSchema = z
  .object({
    type: z.literal('reasoning'),
    text: z.string(),
    state: z.enum(['streaming', 'done']).optional(),
  })
  .passthrough()

const messagePartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  filePartSchema,
  stepStartPartSchema,
  reasoningPartSchema,
])

const messageMetadataSchema = z
  .object({
    persistenceStatus: z.enum(messagePersistenceStatuses),
  })
  .passthrough()

const uiMessageSchema = z
  .object({
    // messages.id 最终会写入 PostgreSQL UUID 主键，因此入口必须先校验。
    id: z.string().uuid('messageId 必须是合法的 UUID'),
    role: z.enum(['system', 'user', 'assistant']),
    metadata: messageMetadataSchema.optional(),
    parts: z.array(messagePartSchema).min(1),
  })
  .passthrough()

export const modelIdSchema = z.enum(modelIds)   // 只允许 modelIds 数组里列出的那几个具体字符串值
export const chatIdSchema = z.string().uuid('chatId 必须是合法的 UUID')
export const messageIdSchema = z.string().uuid('messageId 必须是合法的 UUID')

export const chatRequestSchema = z
  .object({
    id: chatIdSchema,
    modelId: modelIdSchema.optional().default(modelIds[0]),
    messages: z.array(uiMessageSchema).min(1, 'messages 不能为空'),
  })
  .strip()

export const messageFeedbackSchema = z.object({
  chatId: chatIdSchema,
  messageId: messageIdSchema,
  isLike: z.boolean().nullable(),
})

// 点击分支入口时只需要定位“主对话 + 锚点消息”，此时不会创建分支。
export const branchAnchorSchema = z.object({
  parentChatId: chatIdSchema,
  anchorMessageId: messageIdSchema,
})

export const branchFirstSubmitSchema = branchAnchorSchema.extend({
  firstMessage: z.object({
    id: messageIdSchema,
    content: z.string().trim().min(1, '分支问题不能为空').max(20_000),
  }),
})

// 已经存在的分支必须同时隶属于 URL 中的主对话，不能只相信 branchId。
export const branchIdentitySchema = z.object({
  parentChatId: chatIdSchema,
  branchId: chatIdSchema,
})

function formatIssues(error: z.ZodError): ErrorDetails {
  return error.issues.reduce<ErrorDetails>((details, issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '_root'
    details[path] = [...(details[path] ?? []), issue.message]
    return details
  }, {})
}

export function parseInput<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(input)

  if (!result.success) {
    throw validationError('请求参数不合法', formatIssues(result.error))
  }

  return result.data
}

export async function parseJsonRequest<TSchema extends z.ZodTypeAny>(
  request: Request,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  let body: unknown

  try {
    body = await request.json()
  } catch {
    throw validationError('请求体必须是合法的 JSON')
  }

  return parseInput(schema, body)
}
