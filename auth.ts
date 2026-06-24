// auth.ts
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { authConfig } from './auth.config'
import postgres from 'postgres'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
// 连接数据库
const sql = postgres(process.env.POSTGRES_URL!, { ssl: 'require' })

// 从数据库查用户
async function getUser(email: string) {
  try {
    const users = await sql<{ id: string; email: string; password: string }[]>`
      SELECT id, email, password FROM users WHERE email = ${email}
    `
    return users[0]
  } catch (error) {
    console.error('Failed to fetch user:', error)
    throw new Error('Failed to fetch user.')
  }
}

// NextAuth让开发者能够轻松、安全地为应用添加身份验证功能，
// 而无需从零开始处理复杂的会话管理和安全逻辑

// auth:拿当前 session（服务端用）
// signIn:触发登录（服务端用）
// signOut: 触发登出（服务端用）
// handlers: 给 [...nextauth]/route.ts 用的 HTTP 处理器(暂时没用到)
export const { auth, signIn, signOut, handlers } = NextAuth({
  ...authConfig,
  providers: [
    // 登录方式：邮箱密码（Credentials）
    Credentials({
        // 用户提交表单的时候这个函数authorize被调用
        // 返回用户对象表示验证通过，返回 null 表示拒绝。
      async authorize(credentials) {
        // 1. 用 zod 校验输入格式
        const parsedCredentials = z
          .object({ 
            email: z.string().email(), 
            password: z.string().min(6) 
          })
          .safeParse(credentials)
        
        if (!parsedCredentials.success) {
          return null  // 格式不对，拒绝
        }
        
        const { email, password } = parsedCredentials.data
        
        // 2. 查用户
        const user = await getUser(email)
        if (!user) return null  // 用户不存在
        
        // 3. 验证密码
        const passwordsMatch = await bcrypt.compare(password, user.password)
        if (!passwordsMatch) return null  // 密码错
        
        // 4. 通过验证，返回用户对象
        return { 
          id: user.id, 
          email: user.email,
        }
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user }) {
      // 用户首次登录时,user 有值,把 id 塞进 token
      if (user) {
        token.id = user.id
      }
      return token
    },
    async session({ session, token }) {
      // 每次请求 session 时,从 token 取出 id 塞进 session.user
      if (token.id && session.user) {
        session.user.id = token.id as string
      }
      return session
    },
  }
})

// 用 zod 校验输入格式（防止恶意输入）
// 从数据库查用户
// 用 bcrypt 验证密码（数据库存的是哈希，不是明文）
// 通过验证，返回用户对象给 NextAuth