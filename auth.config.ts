// auth.config.ts
import type { NextAuthConfig } from 'next-auth'

export const authConfig = {
    // 如果用户未登录，跳转/login
  pages: {
    signIn: '/login',
  },
  // 这是路由保护的核心逻辑。
  // 每次访问页面前，middleware 会调用这个函数(即authorized)判断"放行还是跳转"。
  // 返回 true 放行，false 跳到登录页，Response.redirect(...) 跳到指定地址。
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user
      const isOnAuthPage = 
        nextUrl.pathname === '/login' || 
        nextUrl.pathname === '/register'
      
      if (isOnAuthPage) {
        // 已登录访问登录/注册页 → 跳到首页
        if (isLoggedIn) return Response.redirect(new URL('/', nextUrl))
        return true  // 未登录可以访问登录页
      }
      
      // 其他所有页面：必须登录
      return isLoggedIn
    },
    
  },
  // 登录方式（邮箱密码、Google、GitHub 等）
  providers: [],  // 这里先空着，下一步在 auth.ts 里加
} satisfies NextAuthConfig