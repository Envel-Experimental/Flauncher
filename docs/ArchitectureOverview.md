# Architecture Overview

FLauncher is a desktop application built on **Electron**. It is divided into two strictly isolated processes — **Main** and **Renderer** — plus a dedicated **Network layer** that runs exclusively in Main.

---

## Process Model

```
┌──────────────────────────────────────────────────────────┐
│                    MAIN PROCESS (Node.js)                │
│                                                          │
│  index.js ──► IpcRegistry ──► Services:                 │
│                                 AutoUpdaterService       │
│                                 MicrosoftAuthService     │
│                                 LauncherService          │
│                                 FsService                │
│                                 ModService               │
│                                 CryptoService            │
│                                 SentryService            │
│                                 WindowManager            │
│                                                          │
│  Network Layer (always Main):                            │
│    P2PEngine ── PeerHandler ── RaceManager               │
│    MirrorManager ── StatsManager ── PeerPersistence      │
└────────────────────────┬─────────────────────────────────┘
                         │ IPC (ipcMain ↔ ipcRenderer)
┌────────────────────────▼─────────────────────────────────┐
│                  RENDERER PROCESS (Chromium)             │
│                                                          │
│  renderer-entry.js (bundled by esbuild)                  │
│    ConfigManager  DistroAPI  Analytics                   │
│    UI: uicore.js  uibinder.js  views/*.js                │
│                                                          │
│  preloader.js (preload script — contextIsolation=true)   │
│    Exposes window.HeliosAPI bridge                       │
└──────────────────────────────────────────────────────────┘
```

### Why this split matters

- **Security**: The Renderer has no direct Node.js access. All privileged operations (filesystem, launching child processes, P2P) go through IPC to Main.
- **Stability**: A crash in the Renderer doesn't take down the P2P engine or the auto-updater.
- **Context isolation**: `contextIsolation: true` is enforced. `nodeIntegration: false`. The only API surface the Renderer sees is `window.HeliosAPI` exposed by the preload script.

---

## Startup Sequence

`index.js` is the Electron entry point (`"main": "index.js"` in `package.json`).

**Step-by-step on `app.ready`:**

1. **Sentry init** — `SentryService.init()` is called *before any other require*. This ensures crash reports capture even early startup failures.
2. **Single-instance lock** — `app.requestSingleInstanceLock()`. If a second instance tries to start, the existing window is focused and the new process exits.
3. **IPC Registry** — `IpcRegistry.init()` registers all `ipcMain.on` / `ipcMain.handle` handlers. This must happen before the window loads to prevent deadlocks where the renderer sends a message before a handler exists.
4. **Language setup** — `LangLoader.setupLanguage()` reads locale files from `app/assets/lang/`.
5. **Protocol handler** — `protocol.handle('mc-asset', ...)` intercepts all requests to `mc-asset://` URLs and routes them through `RaceManager.handle()`. This is the hook that enables HTTP/P2P racing for asset delivery.
6. **Config load** — `ConfigManager.load()` reads `%APPDATA%\.foxford\config.json` (or platform equivalent).
7. **Window creation** — `WindowManager.createMainWindow()` creates the BrowserWindow.
8. **Network services** — `MirrorManager.init()` latency-tests all configured mirrors. `P2PEngine.start()` connects to the HyperSwarm DHT.
9. **CSP + redirect hooks** — `session.webRequest` hooks:
   - Redirects `resources.download.minecraft.net/*` and `libraries.minecraft.net/*` to `mc-asset://...` so RaceManager handles them.
   - Injects strict CSP headers on all `file://` responses.

---

## Content Security Policy

Applied to all `file://` responses (i.e. the launcher's own pages):

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self' https:;
connect-src 'self' *;
object-src 'none';
media-src 'self' https:;
worker-src 'self';
frame-ancestors 'none';
form-action 'self';
```

`unsafe-inline` for scripts is required because the renderer bundle is loaded as a `<script>` tag with inline eval from esbuild. External network resources are loaded from Main via IPC or via the `mc-asset://` protocol handler, never directly from Renderer JS.

---

## Renderer Bundle

The renderer is built by **esbuild** (`esbuild.config.js`). It bundles:
- `app/assets/js/renderer-entry.js` → `app/dist/bundle.js`

The bundle is loaded by `app/index.html` as a regular `<script>` tag.

**Renderer initialization order** (enforced by `renderer-entry.js`):

```
Stage 0: Global polyfills (window.global, process shim)
Stage 1: Core modules (LoggerUtil, Lang, ConfigManager, Analytics)
Stage 2: UI Core (uicore.js, uibinder.js)
Stage 3: UI Views (landing, settings, welcome, login, overlay, ...)
Stage 4: Global export merge (all view exports → window.*)
Stage 5: wrapper linkage (overlay helpers bound to window)
Then: ConfigManager.load() → Analytics.init() → DistroAPI.init() → renderer-ready IPC signal
```

---

## Preload Script (`app/assets/js/preloader.js`)

Runs with Node.js access in a sandboxed context, exposes `window.HeliosAPI`:

```js
window.HeliosAPI = {
  app:    { isDev, getVersion, getAppPath, restart, openUrl },
  ipc:    { send, invoke, on, once, removeListener },
  system: { getSystemInfo, getPlatform, getArch, cwd },
  shell:  { openPath, trashItem },
  fs:     { statSync },
  window: { close, minimize, maximize, setProgressBar, toggleDevTools }
}
```

All Renderer code must use `window.HeliosAPI.*` or `ipcRenderer.*` for any privileged operation. Direct `require('fs')` etc. are not available in the Renderer.

---

## IPC Security Boundaries

### Shell path sandbox (`IpcRegistry._sandboxShellPath`)
`shell:openPath` and `shell:trashItem` both validate that the resolved path is strictly inside `ConfigManager.getLauncherDirectorySync()` before executing. Any attempt to open/trash a path outside the launcher directory returns an access-denied error.

### SSRF protection (`mirrors:fetchHealth`)
The health-check IPC handler rejects:
- Non-HTTPS URLs
- Loopback / link-local / private-range hosts (`127.x`, `10.x`, `192.168.x`, `172.16-31.x`, `169.254.169.254`)
- Malformed URLs

### URL whitelist (`app:open-url`)
Only opens external URLs that start with `http` or `https`.

---

## Key Dependencies

| Package | Role |
|---------|------|
| `electron` | Application shell |
| `electron-updater` | Auto-update via GitHub Releases |
| `hyperswarm` | P2P peer discovery (DHT) |
| `hyperdht` | Kademlia-style DHT for bootstrap |
| `b4a` | Buffer ↔ Uint8Array bridge for Hyperswarm |
| `@sentry/electron` | Crash reporting |
| `semver` | Java version comparison |
| `smol-toml` | TOML config parsing |
| `patch-package` | Applies patches in `patches/` on `postinstall` |
| `esbuild` | Renderer bundle (CJS, no splitting) |

---

## Build Scripts

```bash
npm start          # Start in dev mode (no bundle)
npm run bundle     # Build renderer bundle via esbuild.config.js
npm run dist:win   # Build Windows installer (electron-builder)
npm run dist:mac   # Build macOS DMG
npm run dist:linux # Build Linux AppImage/deb
```

Signing is configured in `electron-builder.yml`.
