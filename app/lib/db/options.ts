/**
 * 本地 PostgreSQL 默认不启用 TLS，Neon 等远程数据库则需要 TLS。
 * 把判断集中在这里，保证应用、迁移脚本和 E2E 使用一致的连接规则。
 */
export function getPostgresOptions(databaseUrl: string) {
  const hostname = new URL(databaseUrl).hostname
  const isLocalDatabase =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1'

  return {
    ssl: isLocalDatabase ? false : ('require' as const),
  }
}
