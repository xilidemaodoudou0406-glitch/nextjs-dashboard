import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Vitest 当前没有开启全局 API，显式清理每个组件测试的 DOM，避免测试间状态泄漏。
afterEach(() => {
  cleanup()
})
