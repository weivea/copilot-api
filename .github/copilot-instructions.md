# Copilot Instructions

## Build, Lint, and Test

- **Build:** `bun run build` (uses tsdown)
- **Dev:** `bun run dev` (watch mode)
- **Lint:** `bun run lint` (uses `@echristian/eslint-config` with Prettier)
- **Lint fix staged:** `bunx lint-staged`
- **Test all:** `bun test`
- **Test single file:** `bun test tests/anthropic-request.test.ts`
- **Typecheck:** `bun run typecheck`
- **Start (prod):** `bun run start`

## Architecture

This is a reverse-engineered proxy that exposes the GitHub Copilot API as OpenAI- and Anthropic-compatible endpoints.

### Request Flow

```
CLI (Citty) → Auth (GitHub Device Flow) → Server (Hono via srvx)
  → Routes → Services → GitHub Copilot API
```

### Key Layers

- **CLI (`src/main.ts`)**: Built with **Citty**. Subcommands: `start`, `auth`, `check-usage`, `debug`. Each defined via `defineCommand()`.
- **Server (`src/server.ts`)**: **Hono** app with CORS and logging middleware. Routes are mounted with `server.route()`.
- **Routes (`src/routes/`)**: Each route is a subdirectory (e.g., `chat-completions/`, `messages/`) containing `route.ts` for Hono router setup and `handler.ts` for logic. Errors are caught and forwarded via `forwardError()`.
- **Services (`src/services/`)**: Separated into `copilot/` (chat completions, embeddings, models) and `github/` (device auth, token exchange, usage stats). Services make raw HTTP calls to upstream APIs.
- **Anthropic translation (`src/routes/messages/`)**: The `/v1/messages` endpoint translates between Anthropic and OpenAI formats. Request translation (`non-stream-translation.ts`) converts Anthropic→OpenAI; response translation (`stream-translation.ts`) converts OpenAI→Anthropic.

### State Management

Global singleton object in `src/lib/state.ts`. Holds GitHub token, Copilot token, account type, cached models, rate limit config, and flags. Populated by CLI args at startup, then mutated by token refresh and services.

### Token Lifecycle

Two-stage: GitHub OAuth token → Copilot API token. GitHub token is persisted to disk (`src/lib/paths.ts`). Copilot token auto-refreshes on a timer (`refresh_in - 60` seconds). Managed in `src/lib/token.ts`.

### API Config (`src/lib/api-config.ts`)

Centralizes Copilot API constants (version strings, client ID, scopes) and provides header builder functions (`copilotHeaders()`, `githubHeaders()`, `standardHeaders()`). Base URL varies by account type (individual vs business/enterprise).

## Conventions

- **Imports**: Use `~/*` path alias for `src/*` imports (configured in `tsconfig.json`).
- **Modules**: ESNext only. No CommonJS. Use `verbatimModuleSyntax`.
- **Types**: Strict TypeScript. No `any`. Unused locals/parameters are errors.
- **Error handling**: Use `HTTPError` class from `src/lib/error.ts` for HTTP errors. Route handlers wrap logic in try/catch and call `forwardError(c, error)`.
- **Validation**: Zod for request/response schema validation.
- **Logging**: Use `consola` (not `console.log`).
- **Testing**: Bun's built-in test runner. Tests go in `tests/*.test.ts`. Mock `globalThis.fetch` for service tests. Use Zod schemas to validate transformations.
- **Route pattern**: Create a Hono router in `route.ts`, delegate to handler functions, wrap in `forwardError()`.
- **No switch fallthrough**: Enforced by `noFallthroughCasesInSwitch`.
