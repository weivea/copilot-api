import { lazy, Suspense } from "react"
import { Navigate, Route, Routes } from "react-router-dom"

import { Layout } from "./components/Layout"
import { PageSkeleton } from "./components/PageSkeleton"
import { useAuth } from "./contexts/AuthContext"
import { GithubAuth } from "./pages/GithubAuth"
import { Login } from "./pages/Login"

const Usage = lazy(() => import("./pages/Usage"))
const Tokens = lazy(() => import("./pages/Tokens"))
const Models = lazy(() => import("./pages/Models"))
const Settings = lazy(() => import("./pages/Settings"))
const Docs = lazy(() => import("./pages/Docs"))

export function App() {
  const { me, loading } = useAuth()
  if (loading) return <div className="center">Loading…</div>
  if (!me) return <Login />
  return (
    <Layout>
      <Suspense fallback={<PageSkeleton />}>
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
      </Suspense>
    </Layout>
  )
}
