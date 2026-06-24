// app/(auth)/login/login-form.tsx
'use client'

import { useActionState } from 'react'
import { authenticate, type LoginState } from '../actions'
import Link from 'next/link'

export default function LoginForm() {
  const [state, formAction, isPending] = useActionState<LoginState, FormData>(
    authenticate,
    undefined
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
          placeholder="you@example.com"
          className="w-full px-3 py-2 border rounded"
        />
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
          minLength={6}
          placeholder="至少 6 位"
          className="w-full px-3 py-2 border rounded"
        />
      </div>
      
      {state?.message && (
        <p className="text-sm text-red-500">{state.message}</p>
      )}
      
      <button
        type="submit"
        disabled={isPending}
        className="w-full bg-blue-600 text-white py-2 rounded disabled:opacity-50"
      >
        {isPending ? '登录中...' : '登录'}
      </button>
      
      <p className="text-sm text-center">
        还没账号？<Link href="/register" className="text-blue-600">去注册</Link>
      </p>
    </form>
  )
}