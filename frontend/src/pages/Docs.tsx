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
  { id: "endpoints", title: "API Endpoints" },
  { id: "openai", title: "OpenAI-compatible Endpoints" },
  { id: "responses", title: "Responses API" },
  { id: "decisions", title: "Decisions API" },
  { id: "images", title: "Images API" },
  { id: "anthropic", title: "Anthropic-compatible Endpoints" },
  { id: "claude-code", title: "Claude Code Setup" },
  { id: "notes", title: "Notes & Limits" },
]

interface EndpointRow {
  method: string
  path: string
  family: string
  auth: string
  purpose: string
}

const ENDPOINTS: Array<EndpointRow> = [
  {
    method: "GET",
    path: "/healthz",
    family: "internal",
    auth: "none",
    purpose: "Liveness probe — returns 'ok'.",
  },
  {
    method: "POST",
    path: "/chat/completions",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "Chat completions (streaming + non-streaming).",
  },
  {
    method: "POST",
    path: "/v1/chat/completions",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "Same as above — /v1 alias for SDKs that require it.",
  },
  {
    method: "POST",
    path: "/responses",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "Responses API (streaming + non-streaming).",
  },
  {
    method: "POST",
    path: "/v1/responses",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "Same as above — /v1 alias for OpenAI SDKs.",
  },
  {
    method: "POST",
    path: "/decisions",
    family: "OpenAI",
    auth: "Bearer",
    purpose:
      "Typed decisions: predicates, choices, and scores (non-streaming).",
  },
  {
    method: "POST",
    path: "/v1/decisions",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "Same as above — /v1 alias for the Decisions API.",
  },
  {
    method: "POST",
    path: "/images/generations",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "Generate images from a JSON prompt.",
  },
  {
    method: "POST",
    path: "/v1/images/generations",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "Same as above — /v1 alias for image generation.",
  },
  {
    method: "POST",
    path: "/images/edits",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "Edit images using multipart uploads or JSON image references.",
  },
  {
    method: "POST",
    path: "/v1/images/edits",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "Same as above — /v1 alias for image editing.",
  },
  {
    method: "GET",
    path: "/models",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "List Copilot models exposed to your account.",
  },
  {
    method: "GET",
    path: "/v1/models",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "Same as above — /v1 alias.",
  },
  {
    method: "POST",
    path: "/embeddings",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "Text embeddings.",
  },
  {
    method: "POST",
    path: "/v1/embeddings",
    family: "OpenAI",
    auth: "Bearer",
    purpose: "Same as above — /v1 alias.",
  },
  {
    method: "POST",
    path: "/v1/messages",
    family: "Anthropic",
    auth: "Bearer or x-api-key",
    purpose: "Anthropic Messages API, translated to Copilot.",
  },
  {
    method: "GET",
    path: "/token",
    family: "internal",
    auth: "Bearer",
    purpose: "Returns the proxy's current upstream Copilot token.",
  },
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

  const openaiResponses = `curl ${baseUrl}/v1/responses \\
  -H "authorization: Bearer ${tokenPlaceholder}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "gpt-5.4-mini",
    "input": "Explain why the sky is blue in one sentence.",
    "max_output_tokens": 256
  }'`

  const openaiResponsesStream = `curl -N ${baseUrl}/v1/responses \\
  -H "authorization: Bearer ${tokenPlaceholder}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "gpt-5.4-mini",
    "input": "Count from one to five.",
    "stream": true
  }'`

  const openaiDecisions = `curl ${baseUrl}/v1/decisions \\
  -H "authorization: Bearer ${tokenPlaceholder}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "gpt-6-luna-decisions",
    "input": "The checkout API returns HTTP 500 for every customer. All purchases are blocked.",
    "questions": [
      {
        "type": "predicate",
        "name": "is_outage",
        "instructions": "Does this report describe a service outage?"
      },
      {
        "type": "choice",
        "name": "team",
        "instructions": "Which team should handle this incident?",
        "choices": [
          {"value": "engineering", "description": "Bugs and outages"},
          {"value": "billing", "description": "Invoices and refunds"}
        ]
      },
      {
        "type": "score",
        "name": "severity",
        "instructions": "How severe is this incident?",
        "levels": [
          {"label": "minor", "description": "Cosmetic issue"},
          {"label": "critical", "description": "Purchases blocked for everyone"}
        ]
      }
    ]
  }'`

  const decisionsResponse = `{
  "model": "gpt-6-luna",
  "answers": [
    {"type": "predicate", "name": "is_outage", "probability": 1},
    {"type": "choice", "name": "team", "choice": "engineering", "confidence": 1},
    {"type": "score", "name": "severity", "score": 1, "confidence": 1}
  ]
}`

  const openaiModels = `curl ${baseUrl}/v1/models \\
  -H "authorization: Bearer ${tokenPlaceholder}"`

  const imageGeneration = `curl ${baseUrl}/v1/images/generations \\
  -H "authorization: Bearer ${tokenPlaceholder}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "gpt-image-2.5-flare",
    "prompt": "A small blue robot watering a plant",
    "size": "1024x1024",
    "quality": "low",
    "output_format": "png"
  }'`

  const imageEdit = `curl ${baseUrl}/v1/images/edits \\
  -H "authorization: Bearer ${tokenPlaceholder}" \\
  -F "model=gpt-image-2.5-flare" \\
  -F "image[]=@source.png" \\
  -F "prompt=Change the background to a sunny garden" \\
  -F "output_format=png"`

  const imageJsonEdit = `curl ${baseUrl}/v1/images/edits \\
  -H "authorization: Bearer ${tokenPlaceholder}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "gpt-image-2.5-flare",
    "prompt": "Change the background to a sunny garden",
    "images": [{"image_url": "data:image/png;base64,REPLACE_WITH_IMAGE_BASE64"}]
  }'`

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

          <section id="endpoints">
            <h2>API Endpoints</h2>
            <p>
              Every LLM-related route this server exposes. All routes except{" "}
              <code>/healthz</code> require an API token — pass it as{" "}
              <code>authorization: Bearer &lt;token&gt;</code> (or{" "}
              <code>x-api-key</code> for the Anthropic endpoint). When GitHub
              Copilot is not connected on the server, every LLM route returns{" "}
              <code>503 copilot_unavailable</code>.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Family</th>
                  <th>Auth</th>
                  <th>Purpose</th>
                </tr>
              </thead>
              <tbody>
                {ENDPOINTS.map((e) => (
                  <tr key={`${e.method} ${e.path}`}>
                    <td>
                      <code>{e.method}</code>
                    </td>
                    <td>
                      <code>{e.path}</code>
                    </td>
                    <td>{e.family}</td>
                    <td>{e.auth}</td>
                    <td>{e.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              Model endpoint support varies by account and model. See the{" "}
              <a href="/copilot-models">Models</a> page for each model&apos;s
              live <code>supported_endpoints</code> list.
            </p>
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

          <section id="responses">
            <h2>Responses API</h2>
            <p>
              The native OpenAI Responses API is available at both{" "}
              <code>/responses</code> and <code>/v1/responses</code>. Requests,
              responses, tool calls, reasoning output, usage, and Copilot
              billing metadata are passed through without converting them to
              Chat Completions format.
            </p>

            <h3>Non-streaming request</h3>
            <CodeBlock code={openaiResponses} />

            <h3>Streaming request</h3>
            <p>
              Set <code>"stream": true</code> to receive native Responses SSE
              events such as <code>response.output_text.delta</code> and{" "}
              <code>response.completed</code>.
            </p>
            <CodeBlock code={openaiResponsesStream} />

            <h3>Supported behavior</h3>
            <ul>
              <li>
                Accepts string input or Responses-format message, function call,
                and function output items.
              </li>
              <li>
                Supports tools, structured text output, reasoning options,
                sampling controls, prompt caching fields, and service tiers when
                the selected model supports them.
              </li>
              <li>
                Select a model whose <code>supported_endpoints</code> includes{" "}
                <code>/responses</code> on the{" "}
                <a href="/copilot-models">Models</a> page.
              </li>
            </ul>

            <p className="muted small">
              This proxy is stateless. <code>previous_response_id</code>,{" "}
              <code>store: true</code>, and <code>background: true</code> are
              rejected with <code>400 invalid_request_error</code>; forwarded
              requests always use <code>store: false</code>.
            </p>
          </section>

          <section id="decisions">
            <h2>Decisions API</h2>
            <p>
              Available at <code>/decisions</code> and{" "}
              <code>/v1/decisions</code>. This endpoint forwards structured
              decision requests directly to Copilot&apos;s{" "}
              <code>/v1/decisions</code>, without converting them into chat
              completions. It is not the Auto model router.
            </p>
            <p>
              Select a model whose <code>supported_endpoints</code> includes{" "}
              <code>/v1/decisions</code> on the{" "}
              <a href="/copilot-models">Models</a> page. The model{" "}
              <code>gpt-6-luna-decisions</code> was successfully tested through
              this proxy against live Copilot on November 13, 2026. Availability
              still depends on the connected account and upstream policy.
            </p>

            <h3>Request</h3>
            <p>
              Supply <code>model</code>, shared evidence in <code>input</code>,
              and an array of <code>questions</code>. Use your proxy API token,
              not a GitHub token.
            </p>
            <CodeBlock code={openaiDecisions} />

            <h3>Question types</h3>
            <ul>
              <li>
                <code>predicate</code>: returns a <code>probability</code> from
                0 to 1 that the condition is true.
              </li>
              <li>
                <code>choice</code>: selects one of 2–255 distinct string or
                boolean values in <code>choices</code>, with option
                probabilities.
              </li>
              <li>
                <code>score</code>: evaluates 2–10 ordered <code>levels</code>.
                The score is the probability-weighted average of their
                zero-based indices, not a free-form explanation.
              </li>
            </ul>

            <h3>Response excerpt</h3>
            <CodeBlock code={decisionsResponse} />
            <p>
              Match answers by <code>name</code>. Copilot may return the
              underlying model ID (<code>gpt-6-luna</code>) instead of the
              requested decision-model ID. Full responses also preserve
              probabilities, token <code>usage</code>, Copilot billing metadata
              when present, and upstream extension fields. A refused question
              may return an answer with <code>type: &quot;refusal&quot;</code>.
            </p>

            <h3>Limits and protocol differences</h3>
            <ul>
              <li>
                Send 1–400 questions with unique, non-empty names and non-empty
                instructions. Input may be text or supported conversation items,
                including image and JSON content parts.
              </li>
              <li>
                Non-streaming only: omit <code>stream</code> or set it to{" "}
                <code>false</code>. Requests use the existing authentication,
                rate limits, token quotas, and usage accounting.
              </li>
              <li>
                Listing a model does not guarantee inference permission.
                Upstream errors retain their HTTP status, message, error code,
                and retry headers.
              </li>
              <li>
                <code>microsoft-decision-1</code> uses a different upstream
                endpoint, <code>/v1/systemone</code>, with <code>state</code>, a
                named <code>questions</code> object, and question types such as{" "}
                <code>noul</code>. That upstream endpoint was also tested
                successfully, but is not currently proxied by this server. Do
                not send its payload to <code>/v1/decisions</code>.
              </li>
            </ul>
          </section>

          <section id="images">
            <h2>Images API</h2>
            <p>
              Generate images at <code>/v1/images/generations</code> and edit
              them at <code>/v1/images/edits</code>. Both also have unversioned
              aliases under <code>/images</code>. Requests go directly to the
              corresponding Copilot endpoints, not through Chat Completions.
            </p>
            <p>
              Choose a model with the corresponding endpoint in{" "}
              <code>supported_endpoints</code> on the{" "}
              <a href="/copilot-models">Models</a> page. The live catalog
              advertises <code>gpt-image-2.5-flare</code> for both endpoints.
              Preview availability, organization policy, parameters, and
              streaming support are ultimately controlled by Copilot.
            </p>
            <h3>Generate an image</h3>
            <CodeBlock code={imageGeneration} />
            <p>
              Supply <code>model</code> and a non-empty <code>prompt</code>.
              Optional settings such as <code>size</code>, <code>quality</code>,
              <code>n</code>, and <code>output_format</code> are forwarded as
              supplied. Omitted settings use upstream defaults.
            </p>
            <h3>Edit uploaded images</h3>
            <CodeBlock code={imageEdit} />
            <p>
              Upload one file with <code>image</code> or repeat{" "}
              <code>image[]</code> for multiple references. An optional{" "}
              <code>mask</code> file can select the edit region. Do not manually
              set the multipart Content-Type: your client must include the
              correct boundary.
            </p>
            <h3>Edit JSON image references</h3>
            <CodeBlock code={imageJsonEdit} />
            <p>
              JSON edits use an <code>images</code> array with one{" "}
              <code>image_url</code> (URL or base64 data URL) or upstream{" "}
              <code>file_id</code> per image. JSON <code>mask</code> uses the
              same reference format. This proxy does not implement file uploads
              or fetch remote image URLs itself.
            </p>
            <h3>Results, streaming, and billing</h3>
            <p>
              JSON results retain <code>data[].b64_json</code> (decode it to
              save the image), URLs when returned, token <code>usage</code>, and
              upstream extension fields. The proxy does not store generated
              images or invent download URLs.
            </p>
            <p>
              When supported upstream, set <code>stream: true</code> in JSON or{" "}
              <code>-F &quot;stream=true&quot;</code> in multipart, optionally
              with <code>partial_images</code>. SSE events such as{" "}
              <code>image_generation.partial_image</code>,{" "}
              <code>image_generation.completed</code>, and their{" "}
              <code>image_edit</code> equivalents are forwarded. Stream errors
              and incomplete streams are reported, not converted into success.
            </p>
            <p>
              Use your proxy API token. Existing authentication, rate limits,
              quotas, token usage, and Copilot cost accounting apply. GitHub
              bills image generation separately from the chat model using image
              tokens and AI credits; listing a model does not guarantee
              permission to generate. Image variations are not implemented.
            </p>
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
                Chat, Decisions, image generation, and image editing share the
                same proxy token&apos;s RPM, Monthly limit, and Lifetime limit.
                See your quota on the <a href="/usage">Usage</a> page.
              </li>
              <li>
                Usage takes upstream <code>usage.total_tokens</code>, or{" "}
                <code>input_tokens + output_tokens</code> when both counts are
                available but the total is missing. Image token details are
                already included, not added again. Streaming image usage is
                recorded once when the stream ends. AI credits are tracked
                separately; missing token usage cannot be inferred from image
                size or Base64 length.
              </li>
              <li>
                Once a configured limit is reached, subsequent requests return{" "}
                <code>429 monthly_quota_exceeded</code> or{" "}
                <code>403 account_quota_exhausted</code>. Usage is settled after
                each request, so in-flight or concurrent requests may exceed the
                limit. The super admin retains its quota exemption.
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

export default Docs
