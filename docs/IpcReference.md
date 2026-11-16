# IPC Channel Reference

Complete reference for all IPC channels registered in `app/main/IpcRegistry.js` and sub-services. The Renderer uses `ipcRenderer.invoke()` (async) or `ipcRenderer.sendSync()` / `ipcRenderer.send()` (sync/fire-and-forget).

---

## Channel Types

| Method | Direction | Blocking |
|--------|-----------|---------|
| `ipcMain.handle(channel, ...)` | Renderer → Main | `invoke()` — Promise |
| `ipcMain.on(channel, ...)` with `event.returnValue` | Renderer → Main | `sendSync()` — synchronous |
| `ipcMain.on(channel, ...)` without returnValue | Renderer → Main | `send()` — fire and forget |
| `event.sender.send(channel, ...)` | Main → Renderer | `ipcRenderer.on()` |

---

## App Channels

### `app:getVersionSync` · `sendSync → string`
Returns the current app version string (e.g. `"3.0.0"`).

### `app:isDev` · `sendSync → boolean`
Returns `!app.isPackaged`. `true` when running from source.

### `app:getAppPath` · `sendSync → string`
Returns `app.getAppPath()` — the root directory of the installed application.

### `app:restart` · `send` (no reply)
Relaunches the app via `app.relaunch()` + `app.quit()` with a 500ms delay. Debug flags (`--enable-logging`, `--remote-debugging-port`, `--inspect`, `--debug`) are stripped from argv.

### `app:open-url` · `send(url: string)` (no reply)
Opens a URL in the system browser. Only `http://` and `https://` URLs are accepted; others are silently ignored.

---

## Window Channels

### `window-action` · `send(action: string, ...args)`
Controls the main BrowserWindow. Supported `action` values:

| action | effect |
|--------|--------|
| `'close'` | Closes the window |
| `'minimize'` | Minimizes |
| `'maximize'` | Toggles maximize/unmaximize |
| `'unmaximize'` | Unmaximizes |
| `'isMaximized'` | `sendSync` — returns `boolean` |
| `'setProgressBar'` | Sets taskbar progress. `args[0]` is a float 0–1 (or -1 to clear) |
| `'toggleDevTools'` | Toggles DevTools panel |

---

## Config Channels

### `config:load` · `invoke → Config`
Loads config from disk if not already loaded. Returns the full config object.

### `config:save` · `invoke(data: Config) → void`
Writes the provided config object to disk. Merges + validates internally in ConfigManager.

### `config:get` · `invoke → Config`
Returns the current in-memory config (does not reload from disk).

### `config:getLauncherDirectory` · `invoke → string`
Returns the resolved launcher data directory path.

---

## Filesystem Channels

### `fs:statSync` · `sendSync(path: string) → StatResult | null`
Synchronous stat. Returns `{ isDirectory, isFile, size, mtimeMs }` or `null` if path doesn't exist or throws.

### `shell:openPath` · `invoke(path: string) → string`
Opens a file or directory in the OS file explorer. Path is validated against the launcher directory sandbox — returns `'Access denied: ...'` if outside.

### `shell:trashItem` · `invoke(path: string) → { result: boolean, error?: string }`
Moves a file to system trash. Same path sandbox as `shell:openPath`.

### `launcher:showOpenDialog` · `invoke(options: OpenDialogOptions) → OpenDialogReturnValue`
Shows a native file picker dialog. `options` follows the Electron `dialog.showOpenDialog` API.

---

## System Info Channels

### `system:getSystemInfo` · `invoke → SystemInfo`
Returns:
```ts
{
  totalmem: number,   // bytes
  freemem: number,    // bytes
  cpus: CpuInfo[],   // os.cpus()
  platform: string,  // 'win32' | 'darwin' | 'linux'
  arch: string       // 'x64' | 'arm64'
}
```

### `system:getSystemInfoSync` · `sendSync → SystemInfo`
Same as above plus `networkInterfaces: os.networkInterfaces()`. Used by Analytics on startup.

### `system:cwdSync` · `sendSync → string`
Returns `process.cwd()` from the Main process.

---

## Network / Mirror Channels

### `mirrors:getStatus` · `invoke → MirrorStatus[]`
Returns the current latency/availability status of all configured mirrors from `MirrorManager`.

### `mirrors:refresh` · `invoke → MirrorStatus[]`
Re-runs latency measurements against all mirrors, then returns updated status.

### `mirrors:fetchHealth` · `invoke(url: string) → { ok: boolean, status?: number, latency: number, error?: string }`
Fetches a URL and measures latency. **SSRF-protected**: only HTTPS, no loopback/private hosts. Used by the Settings UI mirror health panel.

---

## P2P Channels

### `p2p:getInfo` · `invoke → NetworkInfo`
Returns current P2P engine state:
```ts
{
  connections: number,
  uploaded: number,    // bytes
  downloaded: number,  // bytes
  peers: number
}
```

### `p2p:getStats` · `invoke → StatsResult`
Returns upload/download stats broken down by time window:
```ts
{
  all:   { uploaded: number, downloaded: number },
  month: { uploaded: number, downloaded: number },
  week:  { uploaded: number, downloaded: number }
}
```

### `p2p:configUpdate` · `invoke`
Reloads ConfigManager from disk and restarts the P2P engine. Called after the user changes delivery optimization settings.

### `p2p:getBootstrapStatus` · `invoke → BootstrapNodeStatus[]`
Pings each configured bootstrap node and returns:
```ts
[{
  index: number,
  isPrivate: boolean,       // true = has publicKey (sovereign node)
  status: 'online' | 'timeout',
  latency: number | '<100'  // ms
}]
```
Uses `execFile(ping)` with platform-appropriate flags.

---

## Distribution Channel

### `distribution:verify` · `invoke(data: VerifyData) → boolean`
Verifies an Ed25519 signature for a distribution payload. Delegates to `SignatureUtils.verifyDistribution()`. Called by `DistributionAPI` during remote fetch.

---

## Connectivity Channel

### `connectivity:check` · `invoke → { github: boolean, mojang: boolean }`
Checks reachability of `https://github.com` and `https://minecraft.net` with a 5s timeout HEAD request each. Used for diagnostics UI.

---

## UI Action Channel

### `ui:action` · `send(action: string)` (no reply)
Dispatches UI-triggered actions to Main:

| action | effect |
|--------|--------|
| `'crash-fix'` | Runs `GameCrashHandler.performLastFix()` |
| `'crash-support'` | Opens `ConfigManager.getSupportUrl()` in the system browser |

---

## Lifecycle / Logging Channels

### `renderer-ready` · `send` (no reply)
Sent by Renderer after full initialization. Main responds with `distributionIndexDone` event and triggers system checks.

### `renderer-error` · `send(stack: string)` (no reply)
Renderer reports an unhandled exception. Main logs it and forwards to Sentry + Analytics.

### `renderer-log` · `send(msg: string)` (no reply)
Log message from Renderer forwarded to Main process stdout.

### `renderer-warn` · `send(msg: string)` (no reply)
Warning from Renderer forwarded to Main process stdout.

---

## Main → Renderer Events

These are sent from Main to the Renderer via `event.sender.send()` or `win.webContents.send()`:

| Channel | Payload | When |
|---------|---------|------|
| `distributionIndexDone` | `true` | After `renderer-ready`, signals the distribution is ready |
| `system-warnings` | `Warning[]` | System check results (low RAM, OS incompatibility, etc.) |
| `autoUpdater:*` | various | Auto-update lifecycle events from `AutoUpdaterService` |

---

## Shell / OPCODE Channel

### `SHELL_OPCODE.TRASH_ITEM` (= `'shell:trashItem'`) · `invoke(path: string) → { result: boolean, error? }`
Legacy alias kept for backward compat. Delegates to the same handler as `shell:trashItem` above.

---

## Services Registering Their Own Channels

Each sub-service in `app/main/` registers its own channels during `IpcRegistry.init()`:

| Service | Channels |
|---------|---------|
| `AutoUpdaterService` | `updater:checkForUpdates`, `updater:downloadUpdate`, `updater:installUpdate`, `updater:getStatus` |
| `MicrosoftAuthService` | `auth:microsoft:*` — device-code flow  |
| `LauncherService` | `launcher:launch`, `launcher:kill`, `launcher:getStatus` |
| `FsService` | `fs:read`, `fs:write`, `fs:exists`, `fs:mkdir`, `fs:readdir`, `fs:delete` |
| `ModService` | `mod:list`, `mod:toggle`, `mod:install`, `mod:remove` |
| `CryptoService` | `crypto:hashFile`, `crypto:verifyFile` |
| `ServerStatusService` | `server:status` |
