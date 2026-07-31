// 校验环境变量
import { z } from 'zod'

export const serverEnvSchema = z.object({
  POSTGRES_URL: z.string().url('POSTGRES_URL 必须是合法的数据库 URL'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET 至少需要 32 个字符'),
  DEEPSEEK_API_KEY: z.string().min(1, 'DEEPSEEK_API_KEY 不能为空'),
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
