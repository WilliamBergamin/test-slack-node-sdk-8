# test-sdk-v8-scripts

Integration test suite for validating the Slack Node.js SDK v8 release candidates. Covers `@slack/web-api` (HTTP) and `@slack/socket-mode` (WebSocket) across various network scenarios including proxies, TLS, timeouts, and error handling.

## Issues

The types are struggling with undici imported types from the SDK

## Prerequisites

- Node.js (ES2022+)
- A sibling `node-slack-sdk` directory with the SDK packages built locally

## Setup

```bash
npm install
cp .env.sample .env
# Fill in your Slack tokens in .env
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | WebClient tests | Bot token (`xoxb-...`) |
| `SLACK_CHANNEL_ID` | WebClient tests | Channel ID to post test messages |
| `SLACK_APP_TOKEN` | SocketMode tests | App-level token (`xapp-...`) |
| `TLS_CA_PATH` | No | Custom CA cert for TLS tests |
| `TLS_CERT_PATH` | No | Client cert for TLS tests |
| `TLS_KEY_PATH` | No | Client key for TLS tests |

## Scripts

```bash
npm test                # Run all tests
npm run test:webclient  # WebClient tests only
npm run test:socketmode # SocketMode tests only
npm run test:types      # Type-check (tsc --noEmit)
npm run lint            # Check formatting/linting (Biome)
npm run lint:fix        # Auto-fix formatting/linting
```

## Test Coverage

**WebClient** — client construction, API calls (`auth.test`, `chat.postMessage`, `files.uploadV2`, `conversations.list`), pagination, custom fetch/proxy, TLS options, timeouts, and error types.

**SocketMode** — client construction, connection lifecycle, events, acknowledgments, auto-reconnect, proxy/dispatcher config, and ping/pong monitoring.
