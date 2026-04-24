import type { ReactNode } from "react"

import { NavLink } from "react-router-dom"

import { useAuth } from "../contexts/AuthContext"

export function Layout({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth()
  if (!me) return null
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="who">
          <div>{me.name}</div>
          <div className="role">{me.role}</div>
        </div>
        <nav>
          <NavLink to="/overview">Overview</NavLink>
          {me.role !== "user" && <NavLink to="/tokens">Tokens</NavLink>}
          <NavLink to="/usage">Usage</NavLink>
          <NavLink to="/copilot-models">Models</NavLink>
          <NavLink to="/docs">Docs</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          {me.role === "super" && (
            <NavLink to="/github-auth">GitHub Auth</NavLink>
          )}
        </nav>
        <div className="spacer" />
        <button onClick={() => void logout()}>Logout</button>
      </aside>
      <main className="main">{children}</main>
    </div>
  )
}
