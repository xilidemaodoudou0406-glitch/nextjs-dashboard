import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import postgres from 'postgres'

const projectRoot = resolve(import.meta.dirname, '..')

// Node.js 24 可以直接读取 env 文件。只有外部尚未提供变量时才加载本地文件，
// 因而 CI、容器和部署平台传入的 POSTGRES_URL 始终拥有最高优先级。
if (!process.env.POSTGRES_URL) {
  const envFile = ['.env.local', '.env']
    .map((file) => resolve(projectRoot, file))
    .find(existsSync)

  if (envFile) process.loadEnvFile(envFile)
}

const databaseUrl = process.env.POSTGRES_URL
if (!databaseUrl) {
  throw new Error(
    '缺少 POSTGRES_URL。请先复制 .env.example 并配置数据库连接。',
  )
}

const hostname = new URL(databaseUrl).hostname
const isLocalDatabase = ['localhost', '127.0.0.1', '::1'].includes(
  hostname,
)
const sql = postgres(databaseUrl, {
  ssl: isLocalDatabase ? false : 'require',
  max: 1,
})
const migrationsDirectory = resolve(projectRoot, 'migrations')
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort((left, right) => left.localeCompare(right))

try {
  // 迁移记录表只描述“哪些文件已经执行”，不参与业务查询。
  await sql`
    CREATE TABLE IF NOT EXISTS app_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `

  const appliedRows = await sql`SELECT name FROM app_migrations`
  const appliedMigrations = new Set(appliedRows.map((row) => row.name))

  for (const migrationFile of migrationFiles) {
    if (appliedMigrations.has(migrationFile)) {
      console.log(`跳过 ${migrationFile}（已执行）`)
      continue
    }

    const migrationPath = resolve(migrationsDirectory, migrationFile)
    await sql.begin(async (transaction) => {
      // postgres.js 的 file() 使用 simple query 协议，能够正确执行包含 DO $$
      // 和多条 SQL 的迁移文件；事务失败时不会留下“执行了一半”的结构。
      await transaction.file(migrationPath)
      await transaction`
        INSERT INTO app_migrations (name)
        VALUES (${migrationFile})
      `
    })

    console.log(`完成 ${migrationFile}`)
  }

  console.log('数据库迁移完成')
} finally {
  await sql.end()
}
