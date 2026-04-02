# Copilot API Proxy

> [!WARNING]
> This is a reverse-engineered proxy of GitHub Copilot API. It is not supported by GitHub, and may break unexpectedly. Use at your own risk.

> [!WARNING]
> **GitHub Security Notice:**  
> Excessive automated or scripted use of Copilot (including rapid or bulk requests, such as via automated tools) may trigger GitHub's abuse-detection systems.  
> You may receive a warning from GitHub Security, and further anomalous activity could result in temporary suspension of your Copilot access.
>
> GitHub prohibits use of their servers for excessive automated bulk activity or any activity that places undue burden on their infrastructure.
>
> Please review:
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> Use this proxy responsibly to avoid account restrictions.


---

**Note:** If you are using [opencode](https://github.com/sst/opencode), you do not need this project. Opencode supports GitHub Copilot provider out of the box.

---

## Project Overview

A reverse-engineered proxy for the GitHub Copilot API that exposes it as an OpenAI and Anthropic compatible service. This allows you to use GitHub Copilot with any tool that supports the OpenAI Chat Completions API or the Anthropic Messages API, including to power [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

## Features

- **OpenAI & Anthropic Compatibility**: Exposes GitHub Copilot as an OpenAI-compatible (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and Anthropic-compatible (`/v1/messages`) API.
- **Claude Code Integration**: Easily configure and launch [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) to use Copilot as its backend with a simple command-line flag (`--claude-code`).
- **Usage Dashboard**: A web-based dashboard to monitor your Copilot API usage, view quotas, and see detailed statistics.
- **Rate Limit Control**: Manage API usage with rate-limiting options (`--rate-limit`) and a waiting mechanism (`--wait`) to prevent errors from rapid requests.
- **Manual Request Approval**: Manually approve or deny each API request for fine-grained control over usage (`--manual`).
- **Token Visibility**: Option to display GitHub and Copilot tokens during authentication and refresh for debugging (`--show-token`).
- **API Auth Token**: Protect your proxy with an auto-generated API key. Supports both `Authorization: Bearer` and `x-api-key` headers for OpenAI and Anthropic client compatibility. Enabled by default; disable with `--no-auth`.
- **Flexible Authentication**: Authenticate interactively or provide a GitHub token directly, suitable for CI/CD environments.
- **Support for Different Account Types**: Works with individual, business, and enterprise GitHub Copilot plans.
- **HTTPS / TLS Support**: Serve over HTTPS with your own TLS certificates. Includes built-in certbot integration for easy Let's Encrypt certificate management.

## Demo

https://github.com/user-attachments/assets/7654b383-669d-4eb9-b23c-06d7aefee8c5

## Prerequisites

- Bun (>= 1.2.x)
- GitHub account with Copilot subscription (individual, business, or enterprise)

## Installation

To install dependencies, run:

```sh
bun install
```

## Using with Docker

Build image

```sh
docker build -t copilot-api .
```

Run the container

```sh
# Create a directory on your host to persist the GitHub token and related data
mkdir -p ./copilot-data

# Run the container with a bind mount to persist the token
# This ensures your authentication survives container restarts

docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api
```

> **Note:**
> The GitHub token and related data will be stored in `copilot-data` on your host. This is mapped to `/root/.local/share/copilot-api` inside the container, ensuring persistence across restarts.

### Docker with Environment Variables

You can pass the GitHub token directly to the container using environment variables:

```sh
# Build with GitHub token
docker build --build-arg GH_TOKEN=your_github_token_here -t copilot-api .

# Run with GitHub token
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here copilot-api

# Run with additional options
docker run -p 4141:4141 -e GH_TOKEN=your_token copilot-api start --verbose --port 4141
```

### Docker Compose Example

```yaml
version: "3.8"
services:
  copilot-api:
    build: .
    ports:
      - "4141:4141"
    environment:
      - GH_TOKEN=your_github_token_here
    restart: unless-stopped
```

The Docker image includes:

- Multi-stage build for optimized image size
- Non-root user for enhanced security
- Health check for container monitoring
- Pinned base image version for reproducible builds

## Command Structure

Copilot API now uses a subcommand structure with these main commands:

- `start`: Start the Copilot API server. This command will also handle authentication if needed.
- `auth`: Run GitHub authentication flow without starting the server. This is typically used if you need to generate a token for use with the `--github-token` option, especially in non-interactive environments.
- `auth-token`: View or regenerate the API auth token used for client authentication. The token is auto-generated on first server start and stored at `~/.local/share/copilot-api/auth_token`.
- `check-usage`: Show your current GitHub Copilot usage and quota information directly in the terminal (no server required).
- `debug`: Display diagnostic information including version, runtime details, file paths, and authentication status. Useful for troubleshooting and support.

## Command Line Options

### Start Command Options

The following command line options are available for the `start` command:

| Option         | Description                                                                   | Default    | Alias |
| -------------- | ----------------------------------------------------------------------------- | ---------- | ----- |
| --port         | Port to listen on                                                             | 4141       | -p    |
| --verbose      | Enable verbose logging                                                        | false      | -v    |
| --account-type | Account type to use (individual, business, enterprise)                        | individual | -a    |
| --manual       | Enable manual request approval                                                | false      | none  |
| --rate-limit   | Rate limit in seconds between requests                                        | none       | -r    |
| --wait         | Wait instead of error when rate limit is hit                                  | false      | -w    |
| --github-token | Provide GitHub token directly (must be generated using the `auth` subcommand) | none       | -g    |
| --claude-code  | Generate a command to launch Claude Code with Copilot API config              | false      | -c    |
| --show-token   | Show GitHub and Copilot tokens on fetch and refresh                           | false      | none  |
| --no-auth      | Disable auth token verification                                               | false      | none  |
| --proxy-env    | Initialize proxy from environment variables                                   | false      | none  |
| --tls-cert     | Path to TLS certificate file (PEM format)                                     | none       | none  |
| --tls-key      | Path to TLS private key file (PEM format)                                     | none       | none  |

### Auth Token Command Options

| Option       | Description                            | Default | Alias |
| ------------ | -------------------------------------- | ------- | ----- |
| --regenerate | Force regenerate the auth token        | false   | none  |

### Auth Command Options

| Option       | Description               | Default | Alias |
| ------------ | ------------------------- | ------- | ----- |
| --verbose    | Enable verbose logging    | false   | -v    |
| --show-token | Show GitHub token on auth | false   | none  |

### Debug Command Options

| Option | Description               | Default | Alias |
| ------ | ------------------------- | ------- | ----- |
| --json | Output debug info as JSON | false   | none  |

## API Endpoints

The server exposes several endpoints to interact with the Copilot API. It provides OpenAI-compatible endpoints and now also includes support for Anthropic-compatible endpoints, allowing for greater flexibility with different tools and services.

### OpenAI Compatible Endpoints

These endpoints mimic the OpenAI API structure.

| Endpoint                    | Method | Description                                               |
| --------------------------- | ------ | --------------------------------------------------------- |
| `POST /v1/chat/completions` | `POST` | Creates a model response for the given chat conversation. |
| `GET /v1/models`            | `GET`  | Lists the currently available models.                     |
| `POST /v1/embeddings`       | `POST` | Creates an embedding vector representing the input text.  |

### Anthropic Compatible Endpoints

These endpoints are designed to be compatible with the Anthropic Messages API.

| Endpoint                         | Method | Description                                                  |
| -------------------------------- | ------ | ------------------------------------------------------------ |
| `POST /v1/messages`              | `POST` | Creates a model response for a given conversation.           |
| `POST /v1/messages/count_tokens` | `POST` | Calculates the number of tokens for a given set of messages. |

### Usage Monitoring Endpoints

New endpoints for monitoring your Copilot usage and quotas.

| Endpoint     | Method | Description                                                  |
| ------------ | ------ | ------------------------------------------------------------ |
| `GET /usage` | `GET`  | Get detailed Copilot usage statistics and quota information. |
| `GET /token` | `GET`  | Get the current Copilot token being used by the API.         |

## Example Usage

Using with npx:

```sh
# Basic usage with start command
bun run start start

# Run on custom port with verbose logging
bun run start start --port 8080 --verbose

# Use with a business plan GitHub account
bun run start start --account-type business

# Use with an enterprise plan GitHub account
bun run start start --account-type enterprise

# Enable manual approval for each request
bun run start start --manual

# Set rate limit to 30 seconds between requests
bun run start start --rate-limit 30

# Wait instead of error when rate limit is hit
bun run start start --rate-limit 30 --wait

# Provide GitHub token directly
bun run start start --github-token ghp_YOUR_TOKEN_HERE

# Run only the auth flow
bun run start auth

# Run auth flow with verbose logging
bun run start auth --verbose

# Show your Copilot usage/quota in the terminal (no server needed)
bun run start check-usage

# Display debug information for troubleshooting
bun run debug

# Display debug information in JSON format
bun run debug --json

# View your auth token
bun run auth-token

# Regenerate auth token
bun run auth-token --regenerate

# Start without auth token verification
bun run start start --no-auth

# Initialize proxy from environment variables (HTTP_PROXY, HTTPS_PROXY, etc.)
bun run start start --proxy-env
```

## Using the Usage Viewer

After starting the server, a URL to the Copilot Usage Dashboard will be displayed in your console. This dashboard is a web interface for monitoring your API usage.

1.  Start the server. For example:
    ```sh
    bun run start start
    ```


## Using with Claude Code

This proxy can be used to power [Claude Code](https://docs.anthropic.com/en/claude-code), an experimental conversational AI assistant for developers from Anthropic.

There are two ways to configure Claude Code to use this proxy:

### Interactive Setup with `--claude-code` flag

To get started, run the `start` command with the `--claude-code` flag:

```sh
bun run start start --claude-code
```

You will be prompted to select a primary model and a "small, fast" model for background tasks. After selecting the models, a command will be copied to your clipboard. This command sets the necessary environment variables for Claude Code to use the proxy.

Paste and run this command in a new terminal to launch Claude Code.

### Manual Configuration with `settings.json`

Alternatively, you can configure Claude Code by creating a `.claude/settings.json` file in your project's root directory. This file should contain the environment variables needed by Claude Code. This way you don't need to run the interactive setup every time.

Here is an example `.claude/settings.json` file:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "cpk-your-auth-token-here",
    "ANTHROPIC_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": [
      "WebSearch"
    ]
  }
}
```

> **Note:** Replace `cpk-your-auth-token-here` with your actual auth token. Run `copilot-api auth-token` to view your token, or find it in the server startup logs.

You can find more options here: [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

You can also read more about IDE integration here: [Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## HTTPS / TLS

The server supports HTTPS via TLS certificates. You can configure TLS through CLI arguments, a config file, or both.

### Prerequisites

The `cert:obtain` and `cert:renew` scripts require [certbot](https://certbot.eff.org/). Install it for your platform:

```sh
# Linux (Ubuntu/Debian)
sudo apt install certbot

# Linux (Fedora/RHEL)
sudo dnf install certbot

# macOS
brew install certbot

# Windows / All platforms (requires Python)
pip install certbot
```

> **Note:** The script will check for certbot automatically and show installation instructions if it's not found.

### Quick Start

```sh
# 1. Obtain a certificate (certbot must be installed on your system)
bun run cert:obtain -- --domain copilot.example.com

# 2. Start the server — HTTPS is automatically enabled
bun run start start 
```

Running `cert:obtain` will:
- Call certbot to obtain a Let's Encrypt certificate
- Store certificates in the project's `.certs/` directory
- Auto-generate `copilot-api.config.json` in the project root

To renew certificates:

```sh
bun run cert:renew
```

### Config File

The server looks for a config file in the following order:

1. `copilot-api.config.json` in the current working directory (project root)
2. `~/.local/share/copilot-api/config.json` (global)

Example `copilot-api.config.json` (auto-generated by `cert:obtain`):

```json
{
  "domain": "copilot.example.com",
  "tls": {
    "cert": ".certs/live/copilot.example.com/fullchain.pem",
    "key": ".certs/live/copilot.example.com/privkey.pem"
  }
}
```

- If only `domain` is set (without `tls`), the server automatically derives certificate paths from the `.certs/` directory.
- CLI flags `--tls-cert` and `--tls-key` take priority over the config file.

### Manual TLS Configuration

If you have your own certificates, you can skip certbot and specify them directly:

```sh
# Via CLI flags
bun run start start --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

Or create `copilot-api.config.json` manually with your certificate paths.

When TLS is active, the server logs the certificate paths at startup and uses `https://` in all displayed URLs.

## Running from Source

The project can be run from source in several ways:

### Development Mode

```sh
bun run dev
```

### Production Mode

```sh
bun run start [start|auth]
```

### Running as a Background Process (Linux)

Use the provided scripts in the `scripts/` directory:

```sh
# Start in background
./scripts/start.sh

# Stop
./scripts/stop.sh

# Restart
./scripts/restart.sh
```

Logs are written to `copilot-api.log` in the project root. The PID is saved to `copilot-api.pid` for process management.

### Running as a systemd Service (Linux)

For a more robust setup, create a systemd service file at `/etc/systemd/system/copilot-api.service`:

```ini
[Unit]
Description=Copilot API Proxy
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/copilot-api
ExecStart=/usr/bin/env bun run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then manage the service with standard systemd commands:

```sh
# Enable and start
sudo systemctl enable copilot-api
sudo systemctl start copilot-api

# Check status
sudo systemctl status copilot-api

# Stop
sudo systemctl stop copilot-api

# Restart
sudo systemctl restart copilot-api

# View logs
journalctl -u copilot-api -f
```

## Usage Tips

- To avoid hitting GitHub Copilot's rate limits, you can use the following flags:
  - `--manual`: Enables manual approval for each request, giving you full control over when requests are sent.
  - `--rate-limit <seconds>`: Enforces a minimum time interval between requests. For example, `copilot-api start --rate-limit 30` will ensure there's at least a 30-second gap between requests.
  - `--wait`: Use this with `--rate-limit`. It makes the server wait for the cooldown period to end instead of rejecting the request with an error. This is useful for clients that don't automatically retry on rate limit errors.
- If you have a GitHub business or enterprise plan account with Copilot, use the `--account-type` flag (e.g., `--account-type business`). See the [official documentation](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization) for more details.
