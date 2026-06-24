// app/api/auth/[...nextauth]/route.ts
import { handlers } from '@/auth'

export const { GET, POST } = handlers

// [...nextauth] 是 catch-all 路由，意思是"匹配 /api/auth/ 后面的任意路径"。
// 所有上面那些 URL 的请求都会进到这个文件的 GET 或 POST 函数里

//export const { handlers } = NextAuth({ ... })
//                ↑ 这里出来的，里面装着完整的 GET 和 POST 函数
// handlers 是 NextAuth 帮你写好的、能处理所有认证 URL 的 HTTP 处理器。
// 只需要把它"挂"到这个 catch-all 路由上，剩下的全自动。


// 所有那些 URL 的请求（例如：/api/auth/signin（登录页），/api/auth/session（获取当前session）)
// 都会进到这个文件的 GET 或 POST 函数里。

// Next.js 不会自动知道"哦这些路径要交给 NextAuth"
// 你必须显式地把请求转交给它。
// 这个文件就是那个转交点。

//app/api/auth/[...nextauth]/route.ts 是 NextAuth 的 HTTP 入口。
// 用 catch-all 路由把 /api/auth/* 下所有请求转交给 NextAuth 自带的 handlers，
// 让 session 查询、登录、登出、OAuth 回调等所有标准认证 URL 都能正常响应。