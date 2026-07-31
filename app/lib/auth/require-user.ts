// 统一验证身份
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { unauthenticatedError } from '@/app/lib/errors'

type RequireUserOptions = {
  redirectTo?: string
}

export type AuthenticatedUser = {
  id: string
  email: string | null
}

export async function requireUser(
  options: RequireUserOptions = {},
): Promise<AuthenticatedUser> {
  const session = await auth()

  // 这边的路径跳转只是为proxy做一个兜底
  if (!session?.user?.id) {
    if (options.redirectTo) {
      redirect(options.redirectTo)
    }

    throw unauthenticatedError()
  }

  return {
    id: session.user.id,
    email: session.user.email ?? null,
  }
}
