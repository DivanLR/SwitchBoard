# Security and Locality Review (T050, FR-021b)

**Date**: 2026-07-19 · **Scope**: Terminal Switchboard v0.1 (Electron main + preload + renderer)

## Posture

All application data lives in plain local files under the user profile
(`%APPDATA%\terminal-switchboard\switchboard.db`, SQLite WAL). Nothing is
transmitted off the machine by the application itself; the only network
traffic is the Claude Agent SDK's own communication with Anthropic, initiated
inside the main process by `@anthropic-ai/claude-agent-sdk`.

## Checklist

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 1 | `contextIsolation` enabled | PASS | `src/main/index.ts` BrowserWindow `webPreferences.contextIsolation: true` |
| 2 | `nodeIntegration` disabled | PASS | `src/main/index.ts` `webPreferences.nodeIntegration: false` |
| 3 | Renderer capability surface limited to the typed bridge | PASS | `src/preload/index.ts` exposes exactly `invoke` + `on` via `contextBridge`; push channels validated against `PUSH_CHANNELS` |
| 4 | Structured error envelope (no stack/detail leakage to renderer) | PASS | `WireResult` envelope in `src/main/ipc/handlers.ts`; unknown errors map to `INTERNAL` with message only |
| 5 | Content-Security-Policy on the packaged renderer | PASS | `applyContentSecurityPolicy()` in `src/main/index.ts`: `default-src 'self'`, no remote script/style/img/connect sources. Dev mode is exempt for Vite HMR only |
| 6 | No remote content loaded by the renderer | PASS | Renderer bundle is local; no external URLs referenced in `src/renderer/` |
| 7 | Local-only sockets | PASS (design) | The app opens no listening sockets and no outbound connections of its own. Outbound traffic originates solely from the Agent SDK child process (Claude API). Spot-check procedure below |
| 8 | Session data at rest | PASS (accepted risk) | Plain files under the user profile per the clarified spec; protection relies on the OS account boundary and disk encryption (BitLocker) |
| 9 | Single-instance lock | PASS | `app.requestSingleInstanceLock()` in `src/main/index.ts` |
| 10 | Notifications carry no sensitive payload beyond project name and item title | PASS | `src/main/notifications.ts` |
| 11 | Renderer never touches the SDK, filesystem, or network | PASS | All SDK usage confined to `src/main/sessions/`; renderer imports only `src/shared/` types |

## Socket spot-check procedure (quickstart V6 step 4)

With the application running and one idle session:

```powershell
Get-NetTCPConnection -OwningProcess (Get-Process electron).Id |
  Select-Object LocalAddress, RemoteAddress, RemotePort, State
```

Expected: no listening sockets owned by the app; outbound connections only
from the Agent SDK child process to Anthropic endpoints (port 443), none from
the renderer or main process otherwise.

## Known accepted limitations (v1)

- The database is not encrypted at the application layer (clarified decision:
  OS account boundary plus disk encryption).
- The preload script runs unsandboxed (`sandbox: false`) to allow the ESM
  preload bridge; `contextIsolation` remains the isolation boundary.
- Dev mode (`npm run dev`) relaxes CSP for Vite hot module replacement; the
  packaged application always applies the strict policy.
