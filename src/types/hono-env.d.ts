declare module "hono" {
  interface ContextVariableMap {
    authTokenId?: number
    sessionRole?: "super" | "admin" | "user"
    sessionTokenId?: number | null
  }
}
export {}
