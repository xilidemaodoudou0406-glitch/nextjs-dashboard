// app/(chat)/layout.tsx
import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import Sidebar from './siderbar'

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')
  
  return (
    <div className="flex h-screen">
      <Sidebar userId={session.user.id} userEmail={session.user.email!} />
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* layout 的 children 不接收 props */}
        {children}
      </div>
    </div>
  )
}