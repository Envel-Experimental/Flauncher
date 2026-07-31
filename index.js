

// 1. SENTRY INITIALIZATION (Must be first)
const SentryService = require('./app/main/SentryService')
SentryService.init()


console.log('[Main] Application entry point reached (index.js)')
const { app, protocol, session, powerMonitor } = require('electron')
const WindowManager = require('./app/main/WindowManager')
const IpcRegistry = require('./app/main/IpcRegistry')
const ConfigManager = require('./app/assets/js/core/configmanager')
const LangLoader = require('./app/assets/js/core/langloader')
const MirrorManager = require('./network/MirrorManager')
const P2PEngine = require('./network/P2PEngine')
const NetworkConfig = require('./network/config')
const { MOJANG_MIRRORS } = NetworkConfig
const Analytics = require('./app/assets/js/core/util/Analytics')

// Single Instance Lock
if (!app.requestSingleInstanceLock()) {
    app.quit()
} else {
    app.on('second-instance', () => {
        const win = WindowManager.getMainWindow()
        if (win) {
            if (win.isMinimized()) win.restore()
            win.focus()
        }
    })
}

// Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('Critical Uncaught Exception:', err)
    Analytics.captureException(err)
    WindowManager.showCriticalError(err)
})

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason)
    Analytics.captureException(reason)
})

app.on('ready', async () => {
    console.log('[Main] App is ready')
    
    try {
        // 1. Initialize IPC FIRST (to prevent deadlocks)
        IpcRegistry.init()
        console.log('[Main] IPC Registry initialized.')

        // 2. Setup Language
        LangLoader.setupLanguage()
        console.log('[Main] Language setup complete')
        
        console.log('[Main] Registering protocol handlers...')

        // 3. Register Protocols
        protocol.handle('mc-asset', (req) => RaceManager.handle(req))

        // 4. Load Config
        console.log('[Main] Loading configuration...')
        await ConfigManager.load()
        console.log('[Main] Configuration loaded.')

        console.log('[Main] Initializing UI...')
        WindowManager.setupMenu()
        WindowManager.createMainWindow()
        console.log('[Main] UI Window created.')

        console.log('[Main] Starting network services...')
        console.log('[Main] MirrorManager initializing with mirrors:', MOJANG_MIRRORS.map(m => m.name))
        MirrorManager.init(MOJANG_MIRRORS).then(() => {
            console.log('[Main] MirrorManager initialization complete.')
        }).catch(err => {
            console.error('[Main] MirrorManager failed to initialize:', err)
        })
        P2PEngine.start()
        console.log('[Main] Network services initialized.')

        // 6. Content Security Policy & Redirects
        session.defaultSession.webRequest.onBeforeRequest(
            { urls: ['*://resources.download.minecraft.net/*', '*://libraries.minecraft.net/*'] },
            (details, callback) => {
                callback({ redirectURL: 'mc-asset://' + details.url.replace(/^https?:\/\//, '') })
            }
        )

        // Unified response header handler: CSP for local files + CORS for our mirrors.
        // Dynamically extract hostnames from network/config.js (MOJANG_MIRRORS + config URLs)
        const mirrorHostSet = new Set()
        if (Array.isArray(NetworkConfig.MOJANG_MIRRORS)) {
            for (const mirror of NetworkConfig.MOJANG_MIRRORS) {
                for (const val of Object.values(mirror)) {
                    if (typeof val === 'string' && val.startsWith('http')) {
                        try { mirrorHostSet.add(new URL(val).hostname) } catch (e) {}
                    }
                }
            }
        }
        for (const urlKey of ['BOOTSTRAP_URL', 'P2P_KILL_SWITCH_URL', 'SUPPORT_CONFIG_URL']) {
            if (NetworkConfig[urlKey]) {
                try { mirrorHostSet.add(new URL(NetworkConfig[urlKey]).hostname) } catch (e) {}
            }
        }
        const MIRROR_HOSTS = Array.from(mirrorHostSet)

        const CSP_VALUE = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' https:; connect-src 'self' *; object-src 'none'; media-src 'self' https:; worker-src 'self'; frame-ancestors 'none'; form-action 'self';"
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
            const url = details.url
            const isMirror = MIRROR_HOSTS.some(h => url.includes(h))
            const isLocal = url.startsWith('file://') || url.startsWith('devtools://')

            if (!isMirror && !isLocal) {
                callback({ responseHeaders: details.responseHeaders })
                return
            }

            const extra = {}
            if (isLocal) {
                extra['Content-Security-Policy'] = [CSP_VALUE]
            }
            if (isMirror) {
                extra['Access-Control-Allow-Origin'] = ['*']
                extra['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS, RANGE']
                extra['Access-Control-Allow-Headers'] = ['Content-Type, Range, X-File-Hash, X-File-Id, X-File-Path']
            }
            callback({ responseHeaders: { ...details.responseHeaders, ...extra } })
        })

        // Show Window
        const win = WindowManager.getMainWindow()
        if (win) {
            win.once('ready-to-show', () => {
                win.show()
            })
        }
    } catch (err) {
        console.error('[Main] CRITICAL ERROR DURING STARTUP:', err)
        WindowManager.showCriticalError(err)
    }
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
    if (WindowManager.getMainWindow() === null) WindowManager.createMainWindow()
})