# Project Structure

Annotated directory tree. Every file that matters is listed with its role.

```
FLauncher/
│
├── index.js                          ← Electron main process entry. Startup sequence,
│                                       protocol handler, CSP hooks, network init.
│
├── package.json                      ← Version 3.0.0. Scripts, deps, engines (Node >=20).
├── electron-builder.yml              ← Distribution config: targets, signing, update feed.
├── esbuild.config.js                 ← Bundles renderer JS → app/dist/bundle.js (CJS).
├── build_html.js                     ← Post-processes app/index.html for production.
├── fix_paths.js                      ← Patches absolute paths after build for portability.
├── babel.config.js                   ← Babel config for Jest (transforms ESM test deps).
├── jest.config.js                    ← Jest config: unit/integration coverage, jsdom env.
├── eslint.config.mjs                 ← ESLint rules (flat config, @eslint/js).
├── jsconfig.json                     ← TypeScript-aware JS config (paths, strict null).
├── types.d.ts                        ← Global type declarations for the project.
├── dev-app-update.yml                ← Local update server URL for dev testing.
│
├── app/
│   ├── index.html                    ← Single-page app shell. Loads app/dist/bundle.js.
│   ├── error.html                    ← Shown by WindowManager on critical startup failure.
│   │
│   ├── dist/                         ← esbuild output (gitignored). bundle.js goes here.
│   │
│   ├── main/                         ← Main-process services (Node.js, privileged).
│   │   ├── IpcRegistry.js            ← Registers ALL ipcMain handlers. See IpcReference.md.
│   │   ├── WindowManager.js          ← Creates/manages BrowserWindow, menu, critical error UI.
│   │   ├── AutoUpdaterService.js     ← electron-updater integration. GitHub Releases feed.
│   │   ├── MicrosoftAuthService.js   ← Device-code OAuth flow. IPC bridge for auth UI.
│   │   ├── LauncherService.js        ← Game process management (spawn, kill, status).
│   │   ├── FsService.js              ← Privileged filesystem operations (read/write/delete).
│   │   ├── ModService.js             ← Drop-in mod management (list, toggle, install).
│   │   ├── CryptoService.js          ← File hashing and verification helpers.
│   │   ├── ServerStatusService.js    ← Server ping (TCP check to game server port).
│   │   └── SentryService.js          ← Sentry crash reporting init + captureException.
│   │
│   └── assets/
│       ├── js/
│       │   ├── renderer-entry.js     ← Renderer bundle entry. Staged init (see ArchitectureOverview).
│       │   ├── preloader.js          ← Preload script. Exposes window.HeliosAPI bridge.
│       │   ├── errorPreload.js       ← Minimal preload for error.html.
│       │   │
│       │   ├── core/                 ← Business logic (runs in Renderer, some shared with Main).
│       │   │   ├── configmanager.js  ← Config load/save, all settings getters. See ConfigManager.md.
│       │   │   ├── distromanager.js  ← DistroAPI singleton + IPC bridge for Renderer.
│       │   │   ├── langloader.js     ← i18n: loads lang/*.json, LangKeys map.
│       │   │   ├── authmanager.js    ← Auth account management, token refresh logic.
│       │   │   ├── LaunchController.js ← IPC handler for launcher:launch. Orchestrates launch.
│       │   │   ├── processbuilder.js ← Constructs and spawns the game child process.
│       │   │   ├── sysutil.js        ← System checks: RAM, OS, drive space warnings.
│       │   │   ├── crash-handler.js  ← Renderer-side crash report display logic.
│       │   │   ├── dropinmodutil.js  ← Utilities for drop-in (unmanaged) mod files.
│       │   │   ├── serverstatus.js   ← Server status polling (TCP ping display).
│       │   │   ├── dom_utils.js      ← Shared DOM helper functions.
│       │   │   ├── pathutil.js       ← Platform-aware path resolution (data dir, etc).
│       │   │   ├── isdev.js          ← `module.exports = !app.isPackaged` (or IPC in Renderer).
│       │   │   ├── ipcconstants.js   ← Shared IPC channel name constants.
│       │   │   ├── util.js           ← Miscellaneous utilities.
│       │   │   │
│       │   │   ├── common/           ← Shared data models and utilities.
│       │   │   │   ├── DistributionClasses.js  ← HeliosDistribution, HeliosServer, HeliosModule
│       │   │   │   │                             class wrappers. Type enum. See distro.md.
│       │   │   │   ├── DistributionAPI.js      ← Remote fetch, local cache, signature verify,
│       │   │   │   │                             anti-replay, multi-mirror race. See distro.md.
│       │   │   │   ├── FileUtils.js            ← extractZip, extractTarGz, atomic file write.
│       │   │   │   ├── MavenUtil.js            ← Maven coordinate parsing and path resolution.
│       │   │   │   ├── MojangUtils.js          ← getMojangOS(), isLibraryCompatible(),
│       │   │   │   │                             mcVersionAtLeast().
│       │   │   │   └── RestResponse.js         ← RestResponseStatus enum, handleFetchError().
│       │   │   │
│       │   │   ├── dl/               ← Download system.
│       │   │   │   ├── DownloadEngine.js         ← Core downloader. Parallel queue, retry,
│       │   │   │   │                               mc-asset:// fetch via RaceManager.
│       │   │   │   ├── DistributionIndexProcessor.js ← Processes server modules → Asset list.
│       │   │   │   ├── MojangIndexProcessor.js   ← Processes vanilla manifests → Asset list.
│       │   │   │   ├── FullRepair.js             ← Pre-launch repair: verify + download all assets.
│       │   │   │   ├── Asset.js                  ← Asset class { path, hash, size, HashAlgo }.
│       │   │   │   ├── AssetGuardError.js        ← Custom error type for download failures.
│       │   │   │   └── IndexProcessor.js         ← Abstract base for index processors.
│       │   │   │
│       │   │   ├── game/             ← Game launch logic.
│       │   │   │   ├── LaunchArgumentBuilder.js  ← JVM args, classpath, native extraction.
│       │   │   │   │                               See LaunchPipeline.md.
│       │   │   │   ├── GameCrashHandler.js       ← Crash log parsing, diagnosis, auto-fix.
│       │   │   │   └── ModConfigResolver.js      ← Resolves enabled/disabled mods per server.
│       │   │   │
│       │   │   ├── java/             ← Java runtime management.
│       │   │   │   ├── JavaGuard.js  ← Discovery, download, extraction. See JavaManagement.md.
│       │   │   │   └── JavaUtils.js  ← javaExecFromRoot(), ensureJavaDirIsRoot(), Platform enum.
│       │   │   │
│       │   │   ├── microsoft/        ← Microsoft auth implementation details.
│       │   │   │   └── ...           ← OAuth token exchange, XBL/XSTS chain.
│       │   │   │
│       │   │   ├── mojang/           ← Legacy Mojang auth (deprecated, kept for migration).
│       │   │   │   └── ...
│       │   │   │
│       │   │   ├── config/           ← Per-feature config sub-modules.
│       │   │   │   └── ...
│       │   │   │
│       │   │   └── util/             ← Cross-cutting utilities.
│       │   │       ├── Analytics.js      ← PostHog integration. HWID identity. See analytics.md.
│       │   │       ├── HWID.js           ← Hardware ID generation (machine-id based, fallback UUID).
│       │   │       ├── LoggerUtil.js     ← Logger factory (namespaced console wrapper).
│       │   │       ├── LogBatcher.js     ← Batches log writes to avoid I/O thrash.
│       │   │       ├── NodeUtil.js       ← ensureEncodedPath(), other Node helpers.
│       │   │       ├── RateLimiter.js    ← Token-bucket rate limiter (used by PeerHandler).
│       │   │       ├── SecurityUtils.js  ← Input sanitization, path validation helpers.
│       │   │       ├── SentryWrapper.js  ← Thin wrapper around @sentry/electron.
│       │   │       └── SignatureUtils.js ← Ed25519 verify via WebCrypto / Node crypto.
│       │   │
│       │   ├── ui/                   ← UI layer (Renderer only).
│       │   │   ├── uicore.js         ← Core UI state machine: view transitions, overlay management.
│       │   │   ├── uibinder.js       ← Event bindings: buttons, sliders, form inputs.
│       │   │   ├── i18n.js           ← Translation injection into DOM elements.
│       │   │   └── views/            ← One file per view/screen.
│       │   │       ├── landing.js    ← Main screen: server select, play button, status.
│       │   │       ├── settings.js   ← Settings page: Java, delivery, accounts.
│       │   │       ├── login.js      ← Microsoft login screen.
│       │   │       ├── loginOptions.js ← Auth provider selection.
│       │   │       ├── welcome.js    ← First-run welcome screen.
│       │   │       ├── overlay.js    ← Generic modal overlay system.
│       │   │       ├── agreement.js  ← EULA/terms agreement screen.
│       │   │       ├── p2pAgreement.js ← P2P consent dialog (shown once, sets p2pPromptShown).
│       │   │       └── ui-util.js    ← Shared UI utilities (transitions, element helpers).
│       │   │
│       │   └── mocks/                ← Test mocks for modules that need Electron context.
│       │
│       ├── lang/                     ← i18n string files (JSON, keyed by locale).
│       ├── images/                   ← Static assets: icons, backgrounds.
│       └── css/                      ← Stylesheets.
│
├── network/                          ← P2P network layer (Main process only).
│   ├── P2PEngine.js                  ← HyperSwarm join, peer management, file request dispatch.
│   │                                   See P2PEngine.md.
│   ├── PeerHandler.js                ← Per-peer state machine, protocol parser, security.
│   ├── RaceManager.js                ← HTTP vs P2P race for every mc-asset:// request.
│   ├── MirrorManager.js              ← Mirror latency measurement, sorted mirror list.
│   ├── NodeAdapter.js                ← AIMD upload rate adaptation.
│   ├── HashVerifierStream.js         ← Transform stream: SHA-1/SHA-256 on-the-fly verification.
│   ├── PeerPersistence.js            ← Save/load known peers to disk (cold-start optimization).
│   ├── StatsManager.js               ← Upload/download byte counters (all/month/week windows).
│   ├── TrafficState.js               ← Shared active-download counter (isBusy(), increment/decrement).
│   ├── config.js                     ← Bootstrap nodes, mirror URLs, public keys, discovery settings.
│   └── constants.js                  ← Wire protocol opcodes, rate-limit constants, concurrency limits.
│
├── scripts/                          ← Developer/CI scripts.
│   ├── check_async.js                ← Detects synchronous calls in async-only code paths.
│   └── audit_releases.js             ← Audits GitHub releases against distribution.json.
│
├── tests/                            ← Test suite.
│   ├── jest.setup.js                 ← Jest global setup (MSW handlers, mocks).
│   ├── test-utils.js                 ← Shared test helpers and fixtures.
│   ├── unit/                         ← Jest unit tests.
│   │   └── network/
│   │       └── PeerHandler.fuzz.test.js  ← Fuzz/property tests for PeerHandler security.
│   ├── integration/                  ← Jest integration tests.
│   │   └── AutoUpdateLive.test.js    ← Tests auto-update against live GitHub API.
│   ├── performance/                  ← Playwright performance tests.
│   ├── distribution.spec.js          ← Distribution JSON parsing and validation.
│   ├── download.spec.js              ← DownloadEngine tests with MSW mock server.
│   ├── settings_*.spec.js            ← Settings persistence, boundary, validation tests.
│   ├── smoke.spec.js                 ← Playwright smoke: app starts, reaches landing screen.
│   ├── e2e.spec.js                   ← Playwright end-to-end user journey.
│   ├── user_journey.spec.js          ← Full launch flow simulation.
│   └── diagnostic.spec.js            ← System info and connectivity checks.
│
├── patches/                          ← patch-package patches applied on npm install.
├── libraries/                        ← Vendored native libraries.
├── build/                            ← electron-builder build resources (icons, NSIS scripts).
├── docs/                             ← Documentation (you are here).
└── test-data/                        ← Static fixtures for tests.
```

---

## Key Data Flow Paths

### Asset Download
```
DownloadEngine → fetch(mc-asset://...) → [Electron intercepts] → RaceManager.handle()
    → Promise.any([httpFetch, P2PEngine.requestFile()])
    → winner → HashVerifierStream → write to disk
```

### Distribution Load
```
DistroAPI.getDistribution()
    → pullRemote() [race multiple URLs, verify Ed25519 sig, anti-replay check]
    → HeliosDistribution(rawJSON) → HeliosServer[] → HeliosModule[]
    → cached in %APPDATA%\.foxford\distribution.json
```

### Launch
```
UI click → IPC launcher:launch → LaunchController
    → JavaGuard.discoverBestJvmInstallation()
    → FullRepair (verify + download all assets)
    → LaunchArgumentBuilder.constructJVMArguments()
    → ProcessBuilder.spawn(javaPath, args)
    → GameCrashHandler.monitor(process)
```
