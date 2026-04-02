# Auth Token Verification Design

## Problem

The copilot-api proxy currently has no client-side authentication. Anyone who knows the server address can freely use the Copilot API proxy. This is a security risk, especially when the server is accessible on a local network. We need to add API key verification so that only authorized clients can access the proxy.

## Approach

Add a Hono middleware that verifies a pre-shared auth token on every request. The token is randomly generated, persisted to disk alongside the existing `github_token`, and validated against incoming request headers. Auth is enabled by default and can be disabled with `--no-auth`.

## Design

### 1. Token Format and Storage

- **Format**: `cpk-<64 hex characters>` (32 bytes of randomness, hex-encoded)
  - Example: `cpk-a1b2c3d4e5f6...` (68 chars total)
  - Prefix `cpk-` stands for "copilot proxy key"
- **Storage path**: `~/.local/share/copilot-api/auth_token` (same directory as `github_token`)
- **File permissions**: `0600` (owner read/write only), consistent with existing token file handling in `src/lib/paths.ts`
- **Generation**: Uses `crypto.randomBytes(32).toString('hex')`

### 2. Auth Middleware (`src/lib/auth-middleware.ts`)

A new Hono middleware inserted after `logger()` and `cors()`, before all route handlers.

**Token extraction priority:**
1. `Authorization: Bearer <token>` header (preferred, compatible with OpenAI clients)
2. `x-api-key: <token>` header (compatible with Anthropic clients)
3. If neither header is present → `401 Unauthorized`

**Logic:**
```
if state.authEnabled is false → skip, call next()
if request path is "/" → skip, call next() (health check)
extract token from headers (Authorization > x-api-key)
if no token found → return 401 { error: { message: "Missing auth token", type: "auth_error" } }
if token !== state.authToken → return 401 { error: { message: "Invalid auth token", type: "auth_error" } }
call next()
```

**Error response format** (consistent with OpenAI/Anthropic error formats):
```json
{
  "error": {
    "message": "Missing auth token. Set Authorization header or x-api-key header.",
    "type": "auth_error"
  }
}
```

### 3. State Changes (`src/lib/state.ts`)

Add two new fields to the `State` interface:
```typescript
authToken?: string     // The loaded auth token value
authEnabled: boolean   // Whether auth verification is active (default: true)
```

### 4. Path Changes (`src/lib/paths.ts`)

Add new constant:
```typescript
AUTH_TOKEN_PATH: path.join(APP_DIR, 'auth_token')
```

### 5. Token Utility (`src/lib/auth-token.ts`)

Shared utility functions used by both CLI command and npm script:

- `generateAuthToken(): string` — generates a new `cpk-<hex>` token
- `loadAuthToken(): string | undefined` — reads token from disk, returns undefined if file doesn't exist
- `saveAuthToken(token: string): void` — writes token to disk with `0600` permissions
- `setupAuthToken(state: State): void` — called during server startup:
  1. If `state.authEnabled` is false → skip
  2. Try to load token from disk
  3. If not found → generate, save, log to terminal
  4. Set `state.authToken`

### 6. CLI Integration

#### `copilot-api start` — new argument

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `--no-auth` | boolean | `false` | Disable auth token verification |

**Startup flow change:**
```
existing: setupGitHubToken → setupCopilotToken → startServer
new:      setupGitHubToken → setupCopilotToken → setupAuthToken → startServer
```

**Startup log output:**
```
Auth: enabled (use --no-auth to disable)
```
or
```
Auth: disabled
```

#### `copilot-api auth-token` — new subcommand

A new CLI subcommand alongside `auth`, `check-usage`, `debug`.

**Arguments:**
| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `--regenerate` | boolean | `false` | Force regenerate token even if one exists |

**Behavior:**
- If token file exists and `--regenerate` not set → read and display token
- If token file doesn't exist or `--regenerate` set → generate new token, save, display
- Output format: `Auth token: cpk-a1b2c3d4...`

### 7. NPM Script (`src/scripts/generate-token.ts`)

Standalone script for `bun run generate-token`:
- Generates a new token (always, regardless of existing file)
- Saves to disk
- Outputs to stdout
- Exit code 0 on success

**package.json addition:**
```json
"generate-token": "bun run ./src/scripts/generate-token.ts"
```

### 8. Server Integration (`src/server.ts`)

```typescript
// Current middleware order:
server.use(logger())
server.use(cors())

// New middleware inserted:
server.use(logger())
server.use(cors())
server.use(authMiddleware())  // ← NEW
```

### 9. Claude Code Integration

When using `--claude-code` flag (interactive setup), the setup flow should:
1. Display the auth token along with other configuration
2. Show it as the value for `ANTHROPIC_AUTH_TOKEN` environment variable

Example output during `--claude-code` setup:
```
ANTHROPIC_BASE_URL=http://localhost:4141
ANTHROPIC_AUTH_TOKEN=cpk-a1b2c3d4...
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/lib/auth-token.ts` | Create | Token generation, loading, saving utilities |
| `src/lib/auth-middleware.ts` | Create | Hono auth middleware |
| `src/scripts/generate-token.ts` | Create | Standalone token generation script |
| `src/lib/state.ts` | Modify | Add `authToken` and `authEnabled` fields |
| `src/lib/paths.ts` | Modify | Add `AUTH_TOKEN_PATH` constant |
| `src/server.ts` | Modify | Add auth middleware to middleware chain |
| `src/main.ts` | Modify | Add `--no-auth` arg, `auth-token` subcommand, call `setupAuthToken` |
| `package.json` | Modify | Add `generate-token` script |
| `tests/auth-middleware.test.ts` | Create | Tests for auth middleware |
| `tests/auth-token.test.ts` | Create | Tests for token generation/loading |

## Security Considerations

- Token is stored with restrictive file permissions (`0600`)
- Token comparison should use constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks
- Token is never logged after initial generation (except via explicit `auth-token` command)
- `GET /` is exempt from auth to allow health checks without credentials

## Testing Plan

1. **Unit tests for auth-token.ts**: generate, load, save functions
2. **Unit tests for auth-middleware.ts**: 
   - Request with valid Bearer token → passes
   - Request with valid x-api-key → passes
   - Request with no token → 401
   - Request with invalid token → 401
   - Request to `/` → passes without token
   - Auth disabled → all requests pass
3. **Integration**: Manual test with Claude Code / curl
