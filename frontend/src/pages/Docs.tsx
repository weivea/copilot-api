import { useEffect, useMemo, useState } from "react"

import type { TokenRow } from "../types"

import { api } from "../api/client"
import { useAuth } from "../contexts/AuthContext"

interface Section {
  id: string
  title: string
}

const SECTIONS: Array<Section> = [
  { id: "quick-start", title: "Quick Start" },
  { id: "openai", title: "OpenAI-compatible Endpoints" },
  { id: "anthropic", title: "Anthropic-compatible Endpoints" },
  { id: "claude-code", title: "Claude Code Setup" },
  { id: "notes", title: "Notes & Limits" },
]

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const onClick = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <button className="docs-copy" onClick={onClick} type="button">
      {copied ? "Copied" : "Copy"}
    </button>
  )
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="docs-code">
      <CopyButton text={code} />
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

function TokenPicker({
  canListTokens,
  tokens,
  selectedTokenId,
  onChange,
}: {
  canListTokens: boolean
  tokens: Array<TokenRow>
  selectedTokenId: number | null
  onChange: (id: number) => void
}) {
  if (!canListTokens) {
    return (
      <span className="muted">
        Use the secret you received when your token was created. Only admins can
        list tokens.
      </span>
    )
  }
  if (tokens.length === 0) {
    return (
      <span className="muted">
        No tokens yet — create one on the Tokens page.
      </span>
    )
  }
  return (
    <select
      value={selectedTokenId ?? ""}
      onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
    >
      {tokens.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name} ({t.token_prefix}…){t.is_admin ? " — admin" : ""}
        </option>
      ))}
    </select>
  )
}

export function Docs() {
  const { me } = useAuth()
  const canListTokens = me?.role === "admin" || me?.role === "super"
  const [tokens, setTokens] = useState<Array<TokenRow>>([])
  const [selectedTokenId, setSelectedTokenId] = useState<number | null>(null)

  const baseUrl =
    typeof globalThis.window === "undefined" ?
      "http://localhost:4141"
    : globalThis.location.origin

  useEffect(() => {
    if (!canListTokens) return
    api
      .listTokens()
      .then((rows) => {
        const enabled = rows.filter((t) => !t.is_disabled)
        setTokens(enabled)
        if (enabled.length > 0) setSelectedTokenId(enabled[0].id)
      })
      .catch(() => {
        setTokens([])
      })
  }, [canListTokens])

  const selectedToken = useMemo(
    () => tokens.find((t) => t.id === selectedTokenId),
    [tokens, selectedTokenId],
  )

  // The full secret is only shown once at creation; the dashboard stores only a
  // prefix + hash. So we render the prefix as a hint and use <YOUR_TOKEN> as
  // the placeholder the user must replace before running the example.
  const tokenPlaceholder =
    selectedToken ?
      `<YOUR_TOKEN starting with ${selectedToken.token_prefix}>`
    : "<YOUR_TOKEN>"

  const openaiChat = `curl ${baseUrl}/v1/chat/completions \\
  -H "authorization: Bearer ${tokenPlaceholder}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`

  const openaiStream = `curl ${baseUrl}/v1/chat/completions \\
  -H "authorization: Bearer ${tokenPlaceholder}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "gpt-4o",
    "stream": true,
    "messages": [{"role": "user", "content": "Stream this"}]
  }'`

  const openaiModels = `curl ${baseUrl}/v1/models \\
  -H "authorization: Bearer ${tokenPlaceholder}"`

  const openaiEmbeddings = `curl ${baseUrl}/v1/embeddings \\
  -H "authorization: Bearer ${tokenPlaceholder}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "text-embedding-3-small",
    "input": "hello world"
  }'`

  const anthropicMessages = `curl ${baseUrl}/v1/messages \\
  -H "x-api-key: ${tokenPlaceholder}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "claude-sonnet-4",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, Claude"}
    ]
  }'`

  const claudeCodeShell = `export ANTHROPIC_BASE_URL="${baseUrl}"
export ANTHROPIC_AUTH_TOKEN="${tokenPlaceholder}"
export ANTHROPIC_MODEL="claude-sonnet-4"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4"
export ANTHROPIC_SMALL_FAST_MODEL="claude-haiku-4"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4"
export DISABLE_NON_ESSENTIAL_MODEL_CALLS=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
claude`

  const claudeCodeSettings = `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "env": {
    "ANTHROPIC_BASE_URL": "${baseUrl}",
    "ANTHROPIC_AUTH_TOKEN": "${tokenPlaceholder}",
    "ANTHROPIC_MODEL": "claude-opus-4.7",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-opus-4.7",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4.5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "DISABLE_AUTOUPDATER": "1"
  },
  "alwaysThinkingEnabled": true,
  "skipDangerousModePermissionPrompt": true
}`

  const pythonOpenai = `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/v1",
    api_key="${tokenPlaceholder}",
)
resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)`

  return (
    <div className="page docs">
      <h1>API Documentation</h1>
      <p className="muted">
        This server proxies GitHub Copilot via OpenAI- and Anthropic-compatible
        endpoints. Pick a token and copy any example below.
      </p>

      <div className="docs-controls card">
        <div className="docs-control">
          <div className="label">Base URL</div>
          <div className="docs-inline">
            <code>{baseUrl}</code>
            <CopyButton text={baseUrl} />
          </div>
        </div>

        <div className="docs-control">
          <div className="label">Token</div>
          <TokenPicker
            canListTokens={canListTokens}
            tokens={tokens}
            selectedTokenId={selectedTokenId}
            onChange={setSelectedTokenId}
          />
          {selectedToken && (
            <div className="muted small">
              Examples include the <code>{selectedToken.token_prefix}…</code>{" "}
              prefix as a hint. Replace
              <code> &lt;YOUR_TOKEN starting with …&gt;</code> with the full
              secret you saved at creation time — the server only stores the
              hash, so the dashboard cannot show it again.
            </div>
          )}
        </div>
      </div>

      <div className="docs-layout">
        <aside className="docs-toc">
          <div className="label">On this page</div>
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ul>
        </aside>

        <div className="docs-body">
          <section id="quick-start">
            <h2>Quick Start</h2>
            <ol>
              <li>
                Create an API token on the <a href="/tokens">Tokens</a> page
                (admin or super only). Save the secret — it is shown once.
              </li>
              <li>
                Make sure the server is connected to GitHub. Check the{" "}
                <a href="/overview">Overview</a> page; if Copilot is unavailable
                a super admin must complete{" "}
                <a href="/github-auth">GitHub sign-in</a>.
              </li>
              <li>
                Point any OpenAI- or Anthropic-compatible client at{" "}
                <code>{baseUrl}</code> using your token.
              </li>
            </ol>
          </section>

          <section id="openai">
            <h2>OpenAI-compatible Endpoints</h2>
            <p>
              Available at both <code>/chat/completions</code> and{" "}
              <code>/v1/chat/completions</code> (and same for{" "}
              <code>/models</code>, <code>/embeddings</code>). Use the{" "}
              <code>/v1</code> prefix when configuring SDKs that expect it.
            </p>

            <h3>Chat completion</h3>
            <CodeBlock code={openaiChat} />

            <h3>Streaming</h3>
            <p>
              Add <code>"stream": true</code> to receive SSE chunks.
            </p>
            <CodeBlock code={openaiStream} />

            <h3>List models</h3>
            <CodeBlock code={openaiModels} />

            <h3>Embeddings</h3>
            <CodeBlock code={openaiEmbeddings} />

            <h3>Python (openai SDK)</h3>
            <CodeBlock code={pythonOpenai} />
          </section>

          <section id="anthropic">
            <h2>Anthropic-compatible Endpoints</h2>
            <p>
              The <code>/v1/messages</code> endpoint accepts Anthropic-format
              requests and translates them to/from Copilot under the hood.
              Streaming and tool use are supported.
            </p>

            <h3>Messages</h3>
            <CodeBlock code={anthropicMessages} />

            <p className="muted small">
              Authenticate with either <code>x-api-key: &lt;token&gt;</code> or{" "}
              <code>authorization: Bearer &lt;token&gt;</code>. Pick a model id
              from the <code>/v1/models</code> response.
            </p>
          </section>

          <section id="claude-code">
            <h2>Claude Code Setup</h2>
            <p>
              Two ways to configure Claude Code: shell environment variables, or
              a persistent <code>~/.claude/settings.json</code>.
            </p>

            <h3>Option A — Shell environment</h3>
            <p>
              Export these variables before launching <code>claude</code>. The
              CLI will then route all traffic through this proxy.
            </p>
            <CodeBlock code={claudeCodeShell} />

            <h3>
              Option B — <code>~/.claude/settings.json</code>
            </h3>
            <p>
              Drop this into <code>~/.claude/settings.json</code> to make the
              configuration persistent across sessions.
            </p>
            <CodeBlock code={claudeCodeSettings} />

            <p className="muted small">
              The <code>DISABLE_NON_ESSENTIAL_MODEL_CALLS</code> and{" "}
              <code>CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC</code> flags
              suppress background telemetry calls that would otherwise consume
              your Copilot quota. Replace the model ids with whatever your
              Copilot plan exposes — see <code>/v1/models</code>.
            </p>
          </section>

          <section id="notes">
            <h2>Notes & Limits</h2>
            <ul>
              <li>
                Tokens carry per-request, monthly, and lifetime limits. See your
                quota on the <a href="/usage">Usage</a> page.
              </li>
              <li>
                If a request returns <code>503 copilot_unavailable</code>, the
                server has no GitHub session — ask a super admin to sign in at{" "}
                <a href="/github-auth">/github-auth</a>.
              </li>
              <li>
                Endpoints accept either <code>authorization: Bearer …</code> or{" "}
                <code>x-api-key: …</code>.
              </li>
              <li>
                Token secrets are only displayed at creation time. Lost a
                secret? Rotate the token from the Tokens page.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
