# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Integration test suite for validating the Slack Node.js SDK v8 release candidates. Tests `@slack/web-api` and `@slack/socket-mode` against real Slack APIs with scenarios including proxies, timeouts, file uploads, pagination, and error handling.

## Prerequisites

- Node.js (ES2022+)
- A sibling `../node-slack-sdk` directory with SDK packages built locally (dependencies use `file:` references)
- A `.env` file with `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and `SLACK_APP_TOKEN` (see `.env.sample`)

## Commands

```bash
npm test                # Run all tests (node:test runner via tsx)
npm run test:webclient  # WebClient tests only
npm run test:socketmode # SocketMode tests only
npm run test:types      # Type-check with tsc --noEmit
npm run lint            # Biome check (formatting + linting)
npm run lint:fix        # Biome auto-fix
```

## Architecture

- **ESM-only** (`"type": "module"` in package.json), uses `tsx` for TypeScript execution
- Tests use Node's built-in `node:test` runner (`describe`/`it`) with `node:assert/strict`
- No build step — tests run directly from TypeScript via `--import tsx`
- SDK packages are linked locally via `file:` dependencies pointing to `../node-slack-sdk/packages/*`

## Code Style

- Biome handles formatting and linting: 2-space indent, single quotes, 120 char line width, LF endings
- `noNonNullAssertion` is disabled — non-null assertions (`!`) are permitted in tests
- Imports are auto-organized by Biome
