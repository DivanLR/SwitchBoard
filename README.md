# Terminal Switchboard

One desktop window hosting every Claude Code session: a central permission
inbox, per-project identity, clean output views, and full two-way interaction.
Specification and design: `specs/001-terminal-switchboard/`.

## Commands

```powershell
npm install
npm run dev          # Electron + Vite with hot reload (swaps better-sqlite3 to the Electron ABI)
npm run test         # Vitest unit tests (swaps better-sqlite3 back to the Node ABI)
npm run test:e2e     # Playwright against the mock session host (no live sessions)
npm run lint         # ESLint
npm run typecheck    # tsc (main/preload) + vue-tsc (renderer)
npm run prune -- --dry-run   # Preview the retention job (FR-021a)
npm run package      # electron-builder distributable
```

## Native module note

`better-sqlite3` is a native module with different ABIs for Node and Electron.
`scripts/swap-sqlite.mjs` downloads the matching prebuilt binary automatically:
`npm run dev` targets Electron, `npm test` targets Node. No C++ toolchain is
required. Electron is pinned to a major version for which better-sqlite3
publishes prebuilds.

## Real-session smoke test

The default test suite never talks to Claude. To validate the live integration
(session hosting, permission interception, question routing) against an
authenticated Claude Code installation:

```powershell
$env:REAL_SESSION = '1'
npx vitest run tests/unit/real-session.spec.ts
```

This spends a small number of real tokens.

## Data

All data is stored locally in SQLite under
`%APPDATA%\terminal-switchboard\switchboard.db`. Nothing is transmitted off
the machine by the application; see `docs/security-review.md`.
