import { Navigate, Route, Routes } from "react-router-dom"

import { Layout } from "./components/Layout"
import { useAuth } from "./contexts/AuthContext"
import { Docs } from "./pages/Docs"
import { GithubAuth } from "./pages/GithubAuth"
import { Login } from "./pages/Login"
import { Models } from "./pages/Models"
import { Settings } from "./pages/Settings"
import { Tokens } from "./pages/Tokens"
import { Usage } from "./pages/Usage"

export function App() {
  const { me, loading } = useAuth()
  if (loading) return <div className="center">Loading…</div>
  if (!me) return <Login />
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/usage" replace />} />
        <Route path="/overview" element={<Navigate to="/usage" replace />} />
        <Route
          path="/tokens"
          element={
            me.role === "user" ? <Navigate to="/usage" replace /> : <Tokens />
          }
        />
        <Route path="/usage" element={<Usage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/copilot-models" element={<Models />} />
        <Route path="/docs" element={<Docs />} />
        <Route
          path="/github-auth"
          element={
            me.role === "super" ?
              <GithubAuth />
            : <Navigate to="/usage" replace />
          }
        />
        <Route path="*" element={<Navigate to="/usage" replace />} />
      </Routes>
    </Layout>
  )
}
