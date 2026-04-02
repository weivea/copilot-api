# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Copilot API is a reverse-engineered proxy that exposes the GitHub Copilot API as OpenAI- and Anthropic-compatible endpoints. It translates between Anthropic/OpenAI formats and the Copilot API, allowing tools like Claude Code to use GitHub Copilot as a backend.

**Runtime:** Bun · **Framework:** Hono · **CLI:** Citty · **Build:** tsdown · **Language:** TypeScript (strict)

## Common Commands

```bash
bun install                              # Install dependencies
bun run dev                              # Start in watch mode
bun run build                            # Build to dist/main.js
bun run start                            # Production mode
bun test                                 # Run all tests
bun test tests/anthropic-request.test.ts # Run single test file
bun run typecheck                        # TypeScript type checking
bun run lint                             # Lint with cache
bun run lint --fix                       # Auto-fix lint issues
bun run knip                             # Find unused exports
```

## Architecture

### Request Flow

```
Client (OpenAI/Anthropic format)
  → Auth Middleware (src/lib/auth-middleware.ts)
  → Routes (src/routes/) — each route has route.ts + handler.ts
  → Services (src/services/) — raw HTTP calls to upstream APIs
  → GitHub Copilot API
```

### Key Layers

- **CLI (`src/main.ts`)**: Citty subcommands — `start`, `auth`, `check-usage`, `auth-token`, `debug`
- **Server (`src/server.ts`)**: Hono app with CORS, logging, auth middleware. Routes mounted via `server.route()`
- **Routes (`src/routes/`)**: Each endpoint is a directory with `route.ts` (Hono router) and `handler.ts` (logic). Errors caught and forwarded via `forwardError()`
- **Services (`src/services/`)**: Split into `copilot/` (chat completions, embeddings, models) and `github/` (OAuth device flow, token exchange, usage)
- **Anthropic Translation (`src/routes/messages/`)**: The `/v1/messages` endpoint converts between Anthropic and OpenAI formats. `non-stream-translation.ts` handles request/response conversion; `stream-translation.ts` handles SSE chunk conversion

### State & Token Management

- **Global state** (`src/lib/state.ts`): Singleton holding GitHub token, Copilot token, account type, cached models, rate limit config, and feature flags. Populated at startup from CLI args, then mutated by services during token refresh
- **Token lifecycle** (`src/lib/token.ts`): Two-stage flow — GitHub OAuth token (persisted to disk at `~/.local/share/copilot-api/`) → Copilot API token (in-memory, auto-refreshes on timer at `refresh_in - 60` seconds)
- **API config** (`src/lib/api-config.ts`): Centralizes Copilot API constants and provides header builders (`copilotHeaders()`, `githubHeaders()`, `standardHeaders()`). Base URL varies by account type

## Code Conventions

- **Imports**: Use `~/*` path alias for `src/*` imports. ESNext module syntax only, no CommonJS
- **Formatting**: Prettier — no semicolons, double quotes
- **Types**: Strict TypeScript, no `any`. Unused locals/parameters are errors
- **Error handling**: Use `HTTPError` class from `~/lib/error`. Route handlers wrap in try/catch and call `forwardError(c, error)`
- **Validation**: Zod for request/response schemas
- **Logging**: Use `consola`, not `console.log`
- **Testing**: Bun test runner. Tests in `tests/*.test.ts`. Mock `globalThis.fetch` for service tests
- **Route pattern**: Hono router in `route.ts`, handler functions in `handler.ts`, errors wrapped with `forwardError()`
- **Pre-commit hook**: `lint-staged` runs ESLint with auto-fix on all staged files
