import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { getPostgresOptions } from '../../app/lib/db/options'

// Playwright 测试进程不会像 Next.js 一样自动加载 .env.local。
// Node 24 的 loadEnvFile 只把变量加载进当前测试进程，不会输出任何密钥。
if (!process.env.POSTGRES_URL) {
  const envFile = ['.env.local', '.env']
    .map((file) => resolve(process.cwd(), file))
    .find(existsSync)
  if (envFile) process.loadEnvFile(envFile)
}

const databaseUrl = process.env.POSTGRES_URL
if (!databaseUrl) {
  throw new Error('运行分支 E2E 前需要配置 POSTGRES_URL')
}

const sql = postgres(databaseUrl, getPostgresOptions(databaseUrl))
const testPassword = 'branch-e2e-password'
const testEmail = `branch-e2e-${crypto.randomUUID()}@example.com`
const parentChatId = crypto.randomUUID()
const parentUserMessageId = crypto.randomUUID()
const anchorMessageId = crypto.randomUUID()
const branchId = crypto.randomUUID()
const branchUserMessageId = crypto.randomUUID()
const branchAssistantMessageId = crypto.randomUUID()

test.describe.configure({ mode: 'serial' })

test.afterAll(async () => {
  // 用户是本测试独占的，删除后数据库外键会级联清理主对话和分支。
  await sql`DELETE FROM users WHERE email = ${testEmail}`
  await sql.end()
})

test('restores, navigates and deletes a branch on desktop and mobile', async ({
  page,
}) => {
  // 该用例会多次访问远程测试数据库；给完整闭环留出冷连接时间，具体断言
  // 仍使用各自的显式等待，不依赖固定 sleep。
  test.setTimeout(90_000)

  await page.goto('/register')
  await page.getByLabel('邮箱').fill(testEmail)
  await page.getByLabel('密码').fill(testPassword)
  await page.getByRole('button', { name: '注册' }).click()
  await page.waitForURL('/')

  const users = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE email = ${testEmail} LIMIT 1
  `
  const userId = users[0]?.id
  expect(userId).toBeTruthy()

  // 直接准备稳定的主对话与分支历史，让路由测试不依赖真实模型网络。
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO chats (id, user_id, title)
      VALUES (${parentChatId}, ${userId!}, '分支 E2E 主对话')
    `
    await transaction`
      INSERT INTO messages (
        id,
        chat_id,
        role,
        content,
        status,
        parts,
        created_at
      )
      VALUES
        (
          ${parentUserMessageId},
          ${parentChatId},
          'user',
          '主对话问题',
          'completed',
          jsonb_build_array(
            jsonb_build_object('type', 'text', 'text', '主对话问题')
          ),
          NOW() - INTERVAL '2 seconds'
        ),
        (
          ${anchorMessageId},
          ${parentChatId},
          'assistant',
          '用于 E2E 的锚点回答',
          'completed',
          jsonb_build_array(
            jsonb_build_object('type', 'text', 'text', '用于 E2E 的锚点回答')
          ),
          NOW() - INTERVAL '1 second'
        )
    `
    await transaction`
      INSERT INTO chats (
        id,
        user_id,
        title,
        parent_chat_id,
        branch_from_message_id
      )
      VALUES (
        ${branchId},
        ${userId!},
        '分支：E2E',
        ${parentChatId},
        ${anchorMessageId}
      )
    `
    await transaction`
      INSERT INTO messages (
        id,
        chat_id,
        role,
        content,
        status,
        parts,
        created_at
      )
      VALUES
        (
          ${branchUserMessageId},
          ${branchId},
          'user',
          'E2E 分支问题',
          'completed',
          jsonb_build_array(
            jsonb_build_object('type', 'text', 'text', 'E2E 分支问题')
          ),
          NOW()
        ),
        (
          ${branchAssistantMessageId},
          ${branchId},
          'assistant',
          'E2E 分支回答',
          'completed',
          jsonb_build_array(
            jsonb_build_object('type', 'text', 'text', 'E2E 分支回答')
          ),
          NOW() + INTERVAL '1 second'
        )
    `
  })

  await page.goto(`/chat/${parentChatId}`)
  const branchTrigger = page.getByRole('button', {
    name: '基于这条回答打开分支',
  })
  await branchTrigger.click()

  await expect(page).toHaveURL(
    new RegExp(`/chat/${parentChatId}\\?branch=${branchId}$`),
    { timeout: 15_000 },
  )
  const panel = page.getByRole('dialog', { name: '分支对话' })
  await expect(panel).toBeVisible()
  await expect(panel.getByText('E2E 分支问题')).toBeVisible({
    timeout: 15_000,
  })
  await expect(panel.getByText('E2E 分支回答')).toBeVisible()

  // 用户亲自从锚点按钮打开时，Escape 关闭后应回到同一个触发按钮。
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
  await expect(page).toHaveURL(`/chat/${parentChatId}`)
  await expect(branchTrigger).toBeFocused()
  await branchTrigger.click()
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL(
    new RegExp(`/chat/${parentChatId}\\?branch=${branchId}$`),
    { timeout: 15_000 },
  )

  await page.reload()
  await expect(panel).toBeVisible()
  await expect(panel.getByText('E2E 分支回答')).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(`/chat/${parentChatId}`)
  await expect(panel).not.toBeVisible()

  await page.goForward()
  await expect(panel).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  const mobilePanelBox = await panel.boundingBox()
  expect(mobilePanelBox?.width).toBe(390)

  await panel.getByRole('button', { name: '删除分支对话' }).click()
  await panel.getByRole('button', { name: '确认删除' }).click()
  await expect(panel).not.toBeVisible()
  await expect(page).toHaveURL(`/chat/${parentChatId}`)
  await expect(page.getByText('用于 E2E 的锚点回答')).toBeVisible()

  await page
    .getByRole('button', { name: '基于这条回答打开分支' })
    .click()
  await expect(page.getByText('这是一个临时草稿')).toBeVisible()
  await expect(page).toHaveURL(`/chat/${parentChatId}`)
})
