// middleware.ts
import NextAuth from 'next-auth'
import { authConfig } from './auth.config'

export default NextAuth(authConfig).auth

// 告诉 Next.js 这个 middleware 在哪些路径下生效。
// 意思是：用户访问任何页面都会先过 middleware 检查。
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|.*\\.png$).*)'],
}

// .auth 是 NextAuth 返回的 middleware 处理器，它会：

// 读 cookie，拿到当前 session
// 调用 authConfig.callbacks.authorized 判断是否放行
// 不放行就重定向到登录页