// app/(auth)/register/page.tsx
import RegisterForm from './register-form'

export default function RegisterPage() {
  return (
    <main className="flex items-center justify-center min-h-screen">
      <div className="w-full max-w-md p-8 bg-white rounded-lg shadow">
        <h1 className="text-2xl font-bold mb-6">注册</h1>
        <RegisterForm />
      </div>
    </main>
  )
}