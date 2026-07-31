'use server'

import { revalidatePath } from 'next/cache'

import { requireUser } from '@/app/lib/auth/require-user'
import {
  createBranchOnFirstSubmit as createBranchRecordOnFirstSubmit,
  deleteBranchById,
  findBranchByAnchor as findBranchRecordByAnchor,
  getBranchConversation as getBranchConversationData,
} from '@/app/lib/branches/data'
import type {
  BranchAnchorLookup,
  BranchConversation,
  BranchSummary,
} from '@/app/lib/branches/types'
import {
  actionFailure,
  resourceNotFoundError,
  type ActionFailure,
} from '@/app/lib/errors'
import {
  branchAnchorSchema,
  branchFirstSubmitSchema,
  branchIdentitySchema,
  parseInput,
} from '@/app/lib/validation/request'

type BranchActionResult<T> =
  | { ok: true; data: T }
  | ActionFailure

/**
 * 分支入口的只读 Server Action。
 *
 * 它负责校验浏览器传入的 ID、取得当前登录用户，再调用数据层查询。
 * 找不到合法锚点时返回统一错误；锚点合法但尚无分支时会成功返回
 * `branch: null`，交给后续 UI 打开临时草稿，而不是立即创建分支。
 */
export async function findBranchByAnchor(
  input: unknown,
): Promise<BranchActionResult<BranchAnchorLookup>> {
  try {
    const { parentChatId, anchorMessageId } = parseInput(
      branchAnchorSchema,
      input,
    )
    const user = await requireUser()
    const lookup = await findBranchRecordByAnchor({
      userId: user.id,
      parentChatId,
      anchorMessageId,
    })

    if (!lookup) {
      throw resourceNotFoundError('分支锚点不存在')
    }

    return { ok: true, data: lookup }
  } catch (error) {
    return actionFailure(error)
  }
}

/**
 * 首次提交分支问题时调用的写入型 Server Action。
 *
 * 这里是外部请求边界：负责运行时参数校验和登录认证；真正的事务、
 * 所有权校验、分支创建及首条消息保存由同名的数据层函数负责。
 * 后续阶段的分支 UI 只能在用户提交非空问题后调用它。
 */
export async function createBranchOnFirstSubmit(
  input: unknown,
): Promise<BranchActionResult<BranchSummary>> {
  try {
    const { parentChatId, anchorMessageId, firstMessage } = parseInput(
      branchFirstSubmitSchema,
      input,
    )
    const user = await requireUser()

    // 这个 Action 留给第三阶段的“首次提交”处理器调用。
    // 单纯点击分支入口只调用 findBranchByAnchor，不会创建数据库记录。
    const branch = await createBranchRecordOnFirstSubmit({
      userId: user.id,
      parentChatId,
      anchorMessageId,
      firstMessage,
    })

    if (!branch) {
      throw resourceNotFoundError('分支锚点不存在')
    }

    revalidatePath(`/chat/${parentChatId}`)
    return { ok: true, data: branch }
  } catch (error) {
    return actionFailure(error)
  }
}

/**
 * 读取分支上下文的 Server Action。
 *
 * 它校验 `parentChatId` 和 `branchId`，并把数据层返回的“继承前缀”
 * 与“分支自身消息”原样交给后续分支 UI。资源不存在或不属于当前用户时，
 * 对外统一表现为“分支不存在”，避免泄露其他用户的资源信息。
 */
export async function readBranchConversation(
  input: unknown,
): Promise<BranchActionResult<BranchConversation>> {
  try {
    const { parentChatId, branchId } = parseInput(
      branchIdentitySchema,
      input,
    )
    const user = await requireUser() // 验证身份
    const conversation = await getBranchConversationData({
      userId: user.id,
      parentChatId,
      branchId,
    })

    if (!conversation) {
      throw resourceNotFoundError('分支不存在')
    }

    return { ok: true, data: conversation }
  } catch (error) {
    return actionFailure(error)
  }
}

/**
 * 删除分支的 Server Action。
 *
 * 只接收明确的主对话 ID 和分支 ID；数据层会再次校验资源归属。
 * 删除成功后刷新主对话页面缓存，为后续分支面板同步状态做准备。
 */
export async function deleteBranch(
  input: unknown,
): Promise<BranchActionResult<{ branchId: string }>> {
  try {
    const { parentChatId, branchId } = parseInput(
      branchIdentitySchema,
      input,
    )
    const user = await requireUser()
    const deleted = await deleteBranchById({
      userId: user.id,
      parentChatId,
      branchId,
    })

    if (!deleted) {
      throw resourceNotFoundError('分支不存在')
    }

    revalidatePath(`/chat/${parentChatId}`)
    return { ok: true, data: { branchId } }
  } catch (error) {
    return actionFailure(error)
  }
}
