import { expect, test } from '@playwright/test'

test('login page renders the authentication form', async ({ page }) => {
  await page.goto('/login')

  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible()
  await expect(page.getByLabel('邮箱')).toBeVisible()
  await expect(page.getByLabel('密码')).toBeVisible()
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible()
})
