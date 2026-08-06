import postgres from 'postgres'

import { getPostgresOptions } from '@/app/lib/db/options'
import { env } from '@/app/lib/env'

/**
 * 服务端共享的数据库客户端。
 *
 * 过去每个文件各自写一遍 `postgres(url, { ssl: 'require' })`，导致本地
 * PostgreSQL 无法连接，也容易让不同入口的配置逐渐不一致。
 */
export const sql = postgres(
  env.POSTGRES_URL,
  getPostgresOptions(env.POSTGRES_URL),
)
