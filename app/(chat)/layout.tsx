// app/(chat)/layout.tsx
import { requireUser } from '@/app/lib/auth/require-user'
import Sidebar from './siderbar'

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await requireUser({ redirectTo: '/login' })
  
  return (
    <div className="flex h-screen">
      <Sidebar userId={user.id} userEmail={user.email ?? ''} />
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* layout 的 children 不接收 props */}
        {children}
      </div>
    </div>
  )
}
