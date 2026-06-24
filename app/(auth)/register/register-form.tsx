// app/(auth)/register/register-form.tsx
'use client'

import { useActionState } from 'react'
import { register, type RegisterState } from '../actions'
import Link from 'next/link'

export default function RegisterForm() {
  const [state, formAction, isPending] = useActionState<RegisterState, FormData>(
    register,// 你的sever action
    undefined // state初始值
  )
  
  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium mb-1">
          邮箱
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          className="w-full px-3 py-2 border rounded"
        />
        {state?.errors?.email && (
          <p className="text-sm text-red-500 mt-1">{state.errors.email[0]}</p>
        )}
      </div>
      
      <div>
        <label htmlFor="password" className="block text-sm font-medium mb-1">
          密码
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          className="w-full px-3 py-2 border rounded"
        />
        {state?.errors?.password && (
          <p className="text-sm text-red-500 mt-1">{state.errors.password[0]}</p>
        )}
      </div>
      
      {state?.message && (
        <p className="text-sm text-red-500">{state.message}</p>
      )}
      
      <button
        type="submit"
        disabled={isPending}
        className="w-full bg-blue-600 text-white py-2 rounded disabled:opacity-50"
      >
        {isPending ? '注册中...' : '注册'}
      </button>
      
      <p className="text-sm text-center">
        已有账号？<Link href="/login" className="text-blue-600">去登录</Link>
      </p>
    </form>
  )
}