// 校验环境变量
import { z } from 'zod'

export const serverEnvSchema = z.object({
  POSTGRES_URL: z.string().url('POSTGRES_URL 必须是合法的数据库 URL'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET 至少需要 32 个字符'),
  DEEPSEEK_API_KEY: z.string().min(1, 'DEEPSEEK_API_KEY 不能为空'),
  // Embedding 使用独立的服务端密钥，不能添加 NEXT_PUBLIC_ 前缀，
  // 否则密钥会有被打包进浏览器代码的风险。
  DASHSCOPE_API_KEY: z.string().min(1, 'DASHSCOPE_API_KEY 不能为空'),
  // 百炼不同地域和业务空间的地址不同，因此由环境变量明确配置，
  // 不在代码中写死 WorkspaceId。
  DASHSCOPE_BASE_URL: z
    .string()
    .url('DASHSCOPE_BASE_URL 必须是合法的 URL'),
})
// 检查环境变量
export function parseServerEnv(input: Record<string, string | undefined>) {
  const result = serverEnvSchema.safeParse(input)

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n')

    throw new Error(`服务端环境变量配置无效：\n${details}`)
  }

  return result.data
}
