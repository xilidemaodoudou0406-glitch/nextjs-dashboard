'use server'

import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { signIn } from '@/auth'
import { AuthError } from 'next-auth'
import { sql } from '@/app/lib/db/client'

// 表单校验 schema
const RegisterSchema = z.object({
  email: z.string().email({ message: '邮箱格式不对' }),
  password: z.string().min(6, { message: '密码至少 6 位' }),
})

// 用来描述 action 返回的状态
export type RegisterState = {
  errors?: {
    email?: string[]
    password?: string[]
  }
  message?: string
} | undefined

export type LoginState = {
  message?: string
} | undefined

// 注册action
export async function register(
    prevState:RegisterState,
    formData:FormData
): Promise<RegisterState> {
    // 1. 校验输入
  const validated = RegisterSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

    if (!validated.success) {
    return {
      errors: validated.error.flatten().fieldErrors,
      message: '输入有误',
    }
  }
  
  const { email, password } = validated.data
  
  // 2. 检查邮箱是否已存在
  const existing = await sql`SELECT id FROM users WHERE email = ${email}`
  if (existing.length > 0) {
    return { message: '该邮箱已注册' }
  }

  // 3. 加密密码,插入数据库
  try {
    const hashedPassword = await bcrypt.hash(password, 10)
    await sql`
      INSERT INTO users (name, email, password) 
      VALUES (${email.split('@')[0]}, ${email}, ${hashedPassword})
    `
  } catch (error) {
    console.error('Register failed:', error)
    return { message: '注册失败，请重试' }
  }
  
  // 4. 注册成功 → 自动登录
  await signIn('credentials', { email, password, redirectTo: '/' })
}

// 登录action
export async function authenticate(
  prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  try {
    await signIn('credentials', formData)
  } catch (error) {
    if (error instanceof AuthError) {
      switch (error.type) {
        case 'CredentialsSignin':
          return { message: '邮箱或密码错误' }
        default:
          return { message: '登录失败' }
      }
    }
    throw error  // 重新抛出非认证错误（如重定向）
  }
}
