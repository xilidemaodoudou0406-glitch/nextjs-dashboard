"use client";

// app/(auth)/login/page.tsx
import LoginForm from './login-form'

export default function LoginPage() {
  return (
    <main className="flex items-center justify-center min-h-screen">
      <div className="w-full max-w-md p-8 bg-white rounded-lg shadow">
        <h1 className="text-2xl font-bold mb-6">登录</h1>
        <LoginForm />
      </div>
    </main>
  )
}