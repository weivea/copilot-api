declare module "hono" {
  interface ContextVariableMap {
    authTokenId?: number
    sessionRole?: "super" | "admin" | "user"
    sessionTokenId?: number | null
    _usagePending?: {
      promptTokens?: number | null
      completionTokens?: number | null
      totalTokens?: number | null
      model?: string | null
      recorded?: boolean
    }
  }
}
export {}
