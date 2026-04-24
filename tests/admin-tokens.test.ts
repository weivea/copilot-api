import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  createAuthToken,
  getAuthTokenById,
  listAuthTokens,
} from "../src/db/queries/auth-tokens"
import { createSession } from "../src/db/queries/sessions"
import { hashToken } from "../src/lib/auth-token-utils"
import { state } from "../src/lib/state"
import { adminTokensRoutes } from "../src/routes/admin/tokens"
import { makeTestDb } from "./helpers/test-db"

const SUPER =
  "cpk-super000000000000000000000000000000000000000000000000000000000000"

beforeEach(() => {
  makeTestDb()
  state.authEnabled = true
  state.dashboardEnabled = true
  state.superAdminToken = SUPER
  state.superAdminTokenHash = hashToken(SUPER)
})

function makeApp(): Hono {
  const app = new Hono()
  app.route("/admin/api/tokens", adminTokensRoutes)
  return app
}

async function loginAsSuper(): Promise<string> {
  const id = await createSession({
    authTokenId: null,
    isSuperAdmin: true,
    ttlMs: 60_000,
  })
  return `cpk_session=${id}`
}

async function loginAsAdmin(): Promise<{ id: number; cookie: string }> {
  const id = await createAuthToken({
    name: "admin1",
    tokenHash: "ahash",
    tokenPrefix: "p",
    isAdmin: true,
  })
  const sid = await createSession({
    authTokenId: id,
    isSuperAdmin: false,
    ttlMs: 60_000,
  })
  return { id, cookie: `cpk_session=${sid}` }
}

async function loginAsUser(): Promise<{ id: number; cookie: string }> {
  const id = await createAuthToken({
    name: "user1",
    tokenHash: "uhash",
    tokenPrefix: "p",
  })
  const sid = await createSession({
    authTokenId: id,
    isSuperAdmin: false,
    ttlMs: 60_000,
  })
  return { id, cookie: `cpk_session=${sid}` }
}

describe("admin tokens API", () => {
  test("user cannot list", async () => {
    const { cookie } = await loginAsUser()
    const res = await makeApp().request("/admin/api/tokens", {
      headers: { cookie },
    })
    expect(res.status).toBe(403)
  })

  test("admin lists tokens", async () => {
    const { cookie } = await loginAsAdmin()
    await createAuthToken({
      name: "x",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const res = await makeApp().request("/admin/api/tokens", {
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>
    expect(body.length).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toContain("ahash")
  })

  test("super creates token and gets plaintext exactly once", async () => {
    const cookie = await loginAsSuper()
    const res = await makeApp().request("/admin/api/tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "newone" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: number
      token: string
      name: string
    }
    expect(body.token).toMatch(/^cpk-[0-9a-f]{64}$/)
    // Subsequent GETs must NOT return the token
    const list = (await (
      await makeApp().request("/admin/api/tokens", { headers: { cookie } })
    ).json()) as Array<Record<string, unknown>>
    for (const row of list) {
      expect(row).not.toHaveProperty("token")
    }
  })

  test("admin cannot set is_admin=true", async () => {
    const { cookie } = await loginAsAdmin()
    const res = await makeApp().request("/admin/api/tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", is_admin: true }),
    })
    expect(res.status).toBe(403)
  })

  test("admin cannot modify another admin", async () => {
    const { cookie } = await loginAsAdmin()
    const otherAdmin = await createAuthToken({
      name: "other-admin",
      tokenHash: "h2",
      tokenPrefix: "p",
      isAdmin: true,
    })
    const res = await makeApp().request(`/admin/api/tokens/${otherAdmin}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    })
    expect(res.status).toBe(403)
  })

  test("admin cannot delete another admin", async () => {
    const { cookie } = await loginAsAdmin()
    const otherAdmin = await createAuthToken({
      name: "x",
      tokenHash: "h2",
      tokenPrefix: "p",
      isAdmin: true,
    })
    const res = await makeApp().request(`/admin/api/tokens/${otherAdmin}`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(res.status).toBe(403)
  })

  test("super can delete admin and cascades sessions", async () => {
    const cookie = await loginAsSuper()
    const id = await createAuthToken({
      name: "victim",
      tokenHash: "h",
      tokenPrefix: "p",
      isAdmin: true,
    })
    await createSession({
      authTokenId: id,
      isSuperAdmin: false,
      ttlMs: 60_000,
    })
    const res = await makeApp().request(`/admin/api/tokens/${id}`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    expect(await getAuthTokenById(id)).toBeUndefined()
  })

  test("admin reset-monthly works on regular token", async () => {
    const { cookie } = await loginAsAdmin()
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const res = await makeApp().request(
      `/admin/api/tokens/${id}/reset-monthly`,
      { method: "POST", headers: { cookie } },
    )
    expect(res.status).toBe(200)
  })

  test("admin cannot reset-lifetime", async () => {
    const { cookie } = await loginAsAdmin()
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const res = await makeApp().request(
      `/admin/api/tokens/${id}/reset-lifetime`,
      { method: "POST", headers: { cookie } },
    )
    expect(res.status).toBe(403)
  })

  test("super reset-lifetime zeros counter", async () => {
    const cookie = await loginAsSuper()
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const { setLifetimeUsed } = await import("../src/db/queries/auth-tokens")
    await setLifetimeUsed(id, 999)
    const res = await makeApp().request(
      `/admin/api/tokens/${id}/reset-lifetime`,
      { method: "POST", headers: { cookie } },
    )
    expect(res.status).toBe(200)
    const tok = await getAuthTokenById(id)
    expect(tok?.lifetimeTokenUsed).toBe(0)
  })

  test("listAuthTokens has the seeded admin", async () => {
    await loginAsAdmin()
    const rows = await listAuthTokens()
    expect(rows.find((r) => r.name === "admin1")).toBeDefined()
  })
})
