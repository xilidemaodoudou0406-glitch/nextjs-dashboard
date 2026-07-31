import NextAuth from 'next-auth'

import { authConfig } from './auth.config'

export default NextAuth(authConfig).auth

export const config = {
  // 哪些路径触发保护
  matcher: ['/((?!api|_next/static|_next/image|.*\\.png$).*)'],
}

// 此部分涉及到一个统一验证问题，到底是每个需要验证的路由都调用一次requireUser，
// 还是在proxy.ts里统一验证一次，后续的路由都不需要再验证了
// 待定