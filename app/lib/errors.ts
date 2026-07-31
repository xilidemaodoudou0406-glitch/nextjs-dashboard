export type AppErrorCode =
  | 'UNAUTHENTICATED'
  | 'VALIDATION_ERROR'
  | 'RESOURCE_NOT_FOUND'
  | 'INTERNAL_ERROR'

// Record<Key, Value> 所有键是key，值是value
export type ErrorDetails = Record<string, string[]>

export type PublicError = {
  code: AppErrorCode
  message: string
  details?: ErrorDetails
}

export type ActionSuccess = { ok: true }
export type ActionFailure = { ok: false; error: PublicError }
export type ActionResult = ActionSuccess | ActionFailure

type AppErrorOptions = {
  code: AppErrorCode
  message: string
  status: number
  details?: ErrorDetails
}

// 自定义错误类型，先自定义构造函数
export class AppError extends Error {
  readonly code: AppErrorCode
  readonly status: number
  readonly details?: ErrorDetails

  constructor({ code, message, status, details }: AppErrorOptions) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export function unauthenticatedError() {
  return new AppError({
    code: 'UNAUTHENTICATED',
    message: '请先登录',
    status: 401,
  })
}

export function validationError(
  message = '请求参数不合法',
  details?: ErrorDetails,
) {
  return new AppError({
    code: 'VALIDATION_ERROR',
    message,
    status: 422,
    details,
  })
}

export function resourceNotFoundError(message = '资源不存在') {
  return new AppError({
    code: 'RESOURCE_NOT_FOUND',
    message,
    status: 404,
  })
}

function normalizeError(error: unknown): { status: number; error: PublicError } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    }
  }

  console.error('Unexpected server error:', error)

  return {
    status: 500,
    error: {
      code: 'INTERNAL_ERROR',
      message: '服务器暂时无法处理请求',
    },
  }
}

export function routeErrorResponse(error: unknown) {
  const normalized = normalizeError(error)

  return Response.json(
    { error: normalized.error },
    { status: normalized.status },
  )
}

export function actionSuccess(): ActionSuccess {
  return { ok: true }
}

export function actionFailure(error: unknown): ActionFailure {
  return { ok: false, error: normalizeError(error).error }
}
