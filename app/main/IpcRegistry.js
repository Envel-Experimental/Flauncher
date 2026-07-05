const { ipcMain, app, shell } = require('electron')
const WindowManager = require('./WindowManager')
const AutoUpdaterService = require('./AutoUpdaterService')
const MicrosoftAuthService = require('./MicrosoftAuthService')
const LauncherService = require('./LauncherService')
const FsService = require('./FsService')
const ModService = require('./ModService')
const ServerStatusService = require('./ServerStatusService')
const ConfigManager = require('../assets/js/core/configmanager')
const { SHELL_OPCODE } = require('../assets/js/core/ipcconstants')
const SentryService = require('./SentryService')
const Analytics = require('../assets/js/core/util/Analytics')

class IpcRegistry {
    init() {
        if (this.initialized) return
        this.initialized = true

        // Initialize sub-services
        AutoUpdaterService.init()
        MicrosoftAuthService.init()
        LauncherService.init()
        FsService.init()
        ModService.init()
        ServerStatusService.init()
        require('./CryptoService').init()
        require('../assets/js/core/LaunchController').init()
        Analytics.init().catch(err => console.error('[Main] Failed to initialize Analytics:', err))

        ipcMain.on('app:getVersionSync', (event) => {
            event.returnValue = app.getVersion()
        })

        ipcMain.on('app:isDev', (event) => {
            event.returnValue = !app.isPackaged
        })

        ipcMain.on('renderer-error', (event, error) => {
            console.error('[Renderer ERROR]', error)
            SentryService.captureException(error)
            Analytics.captureException(error)
        })

        ipcMain.on('app:getAppPath', (event) => {
            event.returnValue = app.getAppPath()
        })

        ipcMain.on('fs:statSync', (event, targetPath) => {
            const pathMod = require('path')
            const ConfigManager = require('../assets/js/core/configmanager')
            // Sandbox: must be within launcher or app dir
            let safe = null
            try {
                const resolved = pathMod.resolve(targetPath)
                const roots = []
                try { roots.push(pathMod.resolve(app.getAppPath())) } catch {}
                try { const d = ConfigManager.getLauncherDirectorySync(); if (d) roots.push(pathMod.resolve(d)) } catch {}
                try { const d = ConfigManager.getDataDirectory(); if (d) roots.push(pathMod.resolve(d)) } catch {}
                if (roots.some(r => resolved === r || resolved.startsWith(r + pathMod.sep))) safe = resolved
            } catch {}
            if (!safe) { event.returnValue = null; return }
            try {
                const fsSync = require('fs')
                const stats = fsSync.statSync(safe)
                event.returnValue = {
                    isDirectory: stats.isDirectory(),
                    isFile: stats.isFile(),
                    size: stats.size,
                    mtimeMs: stats.mtimeMs
                }
            } catch (e) {
                event.returnValue = null
            }
        })

        // Window Action Handlers
        ipcMain.on('window-action', (event, action, ...args) => {
            const win = WindowManager.getMainWindow()
            if (!win) return

            switch (action) {
                case 'close': win.close(); break
                case 'minimize': win.minimize(); break
                case 'maximize':
                    if (win.isMaximized()) win.unmaximize()
                    else win.maximize()
                    break
                case 'unmaximize':
                    win.unmaximize()
                    break
                case 'isMaximized':
                    event.returnValue = win.isMaximized()
                    break
                case 'setProgressBar':
                    win.setProgressBar(args[0])
                    break
                case 'toggleDevTools':
                    win.webContents.toggleDevTools()
                    break
            }
        })


        ipcMain.on('renderer-log', (event, msg) => {
            console.log('[Renderer Log]', msg)
        })

        ipcMain.on('renderer-warn', (event, msg) => {
            console.warn('[Renderer Warning]', msg)
        })

        // Avatar Cache IPCs
        ipcMain.on('avatar:getSync', (event, uuid, type) => {
            try {
                const { getCachedAvatarSync } = require('../assets/js/core/util/AvatarCache')
                event.returnValue = getCachedAvatarSync(uuid, type)
            } catch (e) {
                console.error('[IpcRegistry] Error in avatar:getSync:', e)
                event.returnValue = null
            }
        })

        ipcMain.handle('avatar:download', async (event, uuid, type) => {
            try {
                const { downloadAvatar } = require('../assets/js/core/util/AvatarCache')
                downloadAvatar(uuid, type, (base64Url) => {
                    if (event.sender && !event.sender.isDestroyed()) {
                        event.sender.send('avatar:downloaded', { uuid, type, base64Url })
                    }
                })
            } catch (e) {
                console.error('[IpcRegistry] Error in avatar:download:', e)
            }
        })

        // Config IPCs
        ipcMain.handle('config:load', async () => {
            if (!ConfigManager.isLoaded()) await ConfigManager.load()
            return ConfigManager.getConfig()
        })

        ipcMain.handle('config:save', async (event, data) => {
            if (!data || typeof data !== 'object' || Array.isArray(data)) return false
            // Protect against prototype pollution only.
            // supportUrl and lastLauncherVersion are set by main process/server — renderer must not overwrite them.
            // javaExecutable is legitimately set by the user via Settings UI, so it is NOT blocked.
            const BLOCKED_TOP_LEVEL = ['supportUrl', 'lastLauncherVersion']
            const sanitize = (obj) => {
                if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
                const out = {}
                for (const [k, v] of Object.entries(obj)) {
                    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
                    out[k] = typeof v === 'object' && v !== null && !Array.isArray(v) ? sanitize(v) : v
                }
                return out
            }
            const safe = sanitize(data)
            // Restore server-controlled fields from current in-memory config
            const current = ConfigManager.getConfig()
            if (current.supportUrl != null) safe.supportUrl = current.supportUrl
            if (current.lastLauncherVersion != null) safe.lastLauncherVersion = current.lastLauncherVersion
            ConfigManager.setConfig(safe)
            return await ConfigManager.save()
        })

        ipcMain.handle('config:getLauncherDirectory', async () => {
            return await ConfigManager.getLauncherDirectory()
        })

        ipcMain.handle('launcher:showOpenDialog', async (event, options) => {
            const { dialog } = require('electron')
            const win = WindowManager.getMainWindow()
            return await dialog.showOpenDialog(win, options)
        })

        // General App IPCs
        ipcMain.handle('config:get', () => {
            return ConfigManager.getConfig()
        })

        ipcMain.on('renderer-ready', async (event) => {
            console.log('[Main] Renderer is ready, sending distribution index signal.')
            event.sender.send('distributionIndexDone', true)

            // Perform system checks and send warnings
            try {
                const sysutil = require('../assets/js/core/sysutil')
                const warnings = await sysutil.performChecks()
                if (warnings.length > 0) {
                    console.log(`[Main] Sending ${warnings.length} system warnings to renderer.`)
                    event.sender.send('system-warnings', warnings)
                }
            } catch (err) {
                console.error('[Main] Failed to perform system checks:', err)
            }
        })



        ipcMain.handle(SHELL_OPCODE.TRASH_ITEM, async (event, ...args) => {
            try {
                await shell.trashItem(args[0])
                return { result: true }
            } catch (error) {
                return { result: false, error: error }
            }
        })

        ipcMain.on('app:restart', () => {
            try {
                const args = process.argv.slice(1).filter(arg =>
                    !arg.includes('--enable-logging') &&
                    !arg.includes('--remote-debugging-port') &&
                    !arg.includes('--inspect') &&
                    !arg.includes('--debug')
                )

                app.relaunch({
                    execPath: process.execPath,
                    args: args
                })

                // Small delay to ensure the OS handles the relaunch request
                setTimeout(() => {
                    app.quit()
                }, 500)
            } catch (err) {
                console.error('[Main] Restart failed:', err)
                app.exit(1)
            }
        })

        ipcMain.on('app:open-url', (event, url) => {
            if (url && (url.startsWith('http') || url.startsWith('https'))) {
                shell.openExternal(url).catch(err => console.error('Failed to open external URL:', err))
            }
        })

        // UI Action dispatcher (from Renderer)
        ipcMain.on('ui:action', async (event, action) => {
            console.log(`[Main] Received UI action: ${action}`)
            if (action === 'crash-fix') {
                const GameCrashHandler = require('../assets/js/core/game/GameCrashHandler')
                await GameCrashHandler.performLastFix()
            }
            if (action === 'crash-support') {
                const ConfigManager = require('../assets/js/core/configmanager')
                const url = ConfigManager.getSupportUrl()
                if (url) {
                    shell.openExternal(url).catch(err => console.error('Failed to open support URL:', err))
                }
            }
        })

        // Mirror & P2P IPCs (can be moved later if needed)
        const MirrorManager = require('../../network/MirrorManager')
        const P2PEngine = require('../../network/P2PEngine')
        const { BOOTSTRAP_NODES } = require('../../network/config')
        const { execFile } = require('child_process')

        ipcMain.handle('mirrors:getStatus', () => MirrorManager.getMirrorStatus())
        ipcMain.handle('mirrors:refresh', async () => {
            await MirrorManager.measureAllLatencies()
            return MirrorManager.getMirrorStatus()
        })
        ipcMain.handle('p2p:getInfo', () => P2PEngine.getNetworkInfo())

        ipcMain.handle('p2p:getStats', async () => {
            try {
                const StatsManager = require('../../network/StatsManager')
                return StatsManager.getFullStats()
            } catch (err) {
                console.error('[Main] Failed to get P2P stats:', err)
                return { all: { uploaded: 0, downloaded: 0 }, month: { uploaded: 0, downloaded: 0 }, week: { uploaded: 0, downloaded: 0 } }
            }
        })

        ipcMain.handle('connectivity:check', async () => {
            const check = async (url) => {
                try {
                    const controller = new AbortController()
                    const id = setTimeout(() => controller.abort(), 5000)
                    // We just need a simple GET or HEAD to see if it's reachable.
                    // Using fetch as a simple ping.
                    const res = await fetch(url, { method: 'HEAD', signal: controller.signal })
                    clearTimeout(id)
                    return res.ok
                } catch (e) {
                    return false
                }
            }
            const results = await Promise.all([
                check('https://github.com'),
                check('https://minecraft.net')
            ])
            return { github: results[0], mojang: results[1] }
        })

        ipcMain.handle('p2p:getBootstrapStatus', async () => {
            const results = []
            for (let i = 0; i < BOOTSTRAP_NODES.length; i++) {
                results.push(await this.checkNodeStatus(BOOTSTRAP_NODES[i], i))
            }
            return results
        })

        ipcMain.handle('distribution:verify', async (event, data) => {
            const { verifyDistribution } = require('../assets/js/core/util/SignatureUtils')
            return verifyDistribution(data)
        })

        ipcMain.handle('p2p:configUpdate', async () => {
            try {
                const ConfigManager = require('../assets/js/core/configmanager')
                await ConfigManager.load()
                await P2PEngine.start()
            } catch (err) {
                console.error('Failed to update P2P Config:', err)
            }
        })

        // System Info Bridge
        ipcMain.handle('system:getSystemInfo', () => {
            const os = require('os')
            return {
                totalmem: os.totalmem(),
                freemem: os.freemem(),
                cpus: os.cpus(),
                platform: process.platform,
                arch: process.arch
            }
        })

        ipcMain.on('system:getSystemInfoSync', (event) => {
            const os = require('os')
            event.returnValue = {
                totalmem: os.totalmem(),
                freemem: os.freemem(),
                cpus: os.cpus(),
                platform: process.platform,
                arch: process.arch,
                networkInterfaces: os.networkInterfaces()
            }
        });

        ipcMain.on('system:cwdSync', (event) => {
            event.returnValue = process.cwd()
        })


        ipcMain.handle('shell:openPath', async (event, targetPath) => {
            const safePath = this._sandboxShellPath(targetPath)
            if (!safePath) return 'Access denied: path outside launcher directory'
            return await shell.openPath(safePath)
        })

        ipcMain.handle('shell:trashItem', async (event, targetPath) => {
            const safePath = this._sandboxShellPath(targetPath)
            if (!safePath) return { result: false, error: 'Access denied: path outside launcher directory' }
            try {
                await shell.trashItem(safePath)
                return { result: true }
            } catch (e) {
                return { result: false, error: e.message }
            }
        })

        ipcMain.on('shell:beep', () => {
            shell.beep()
        })


        ipcMain.handle('mirrors:fetchHealth', async (event, url) => {
            // SSRF Protection: only allow HTTPS to external hosts
            if (typeof url !== 'string') return { ok: false, error: 'Invalid URL', latency: 9999 }
            let parsedUrl
            try {
                parsedUrl = new URL(url)
            } catch {
                return { ok: false, error: 'Malformed URL', latency: 9999 }
            }
            if (parsedUrl.protocol !== 'https:') {
                return { ok: false, error: 'Only HTTPS mirrors are allowed', latency: 9999 }
            }
            // Block loopback / link-local / private ranges at hostname level
            const host = parsedUrl.hostname
            if (
                host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
                host.endsWith('.local') ||
                /^10\./.test(host) ||
                /^192\.168\./.test(host) ||
                /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
                host === '169.254.169.254' // AWS/GCP metadata
            ) {
                return { ok: false, error: 'Private/loopback hosts are not allowed', latency: 9999 }
            }

            const start = Date.now()
            try {
                const controller = new AbortController()
                const id = setTimeout(() => controller.abort(), 8000)

                const testUrl = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now()
                const response = await fetch(testUrl, {
                    method: 'GET',
                    signal: controller.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Flauncher/1.0'
                    },
                    cache: 'no-store'
                })
                clearTimeout(id)
                return {
                    ok: response.ok,
                    status: response.status,
                    latency: Date.now() - start
                }
            } catch (err) {
                return { ok: false, error: err.message, latency: 9999 }
            }
        })
    }

    async checkNodeStatus(node, index) {
        return new Promise((resolve) => {
            const { execFile } = require('child_process')
            const platform = process.platform

            if (!node || !this.isValidHost(node.host)) {
                return resolve({ index, isPrivate: !!(node && node.publicKey), status: 'timeout', latency: -1 })
            }

            const pingCmd = 'ping'
            // Windows: -w is ms
            // macOS (darwin): -W is ms
            // Linux: -W is seconds
            const pingArgs = platform === 'win32'
                ? ['-n', '1', '-w', '2000', node.host]
                : platform === 'darwin'
                    ? ['-c', '1', '-W', '2000', node.host]
                    : ['-c', '1', '-W', '2', node.host]

            execFile(pingCmd, pingArgs, (error, stdout) => {
                const output = stdout ? stdout.toString() : ''
                // Standardize success detection: look for TTL or time= across platforms
                const isOnline = !error && (
                    output.includes('time=') ||
                    output.includes('время=') ||
                    output.includes('TTL=') ||
                    (platform === 'darwin' && output.includes('bytes from'))
                )

                resolve({
                    index,
                    isPrivate: !!node.publicKey,
                    status: isOnline ? 'online' : 'timeout',
                    latency: isOnline ? this.parsePingLatency(output, platform) || '< 100' : -1
                })
            })
        })
    }

    isValidHost(host) {
        if (typeof host !== 'string' || !host) return false
        // Only allow hostname/IP chars — exclude % which has no valid use in ping args
        return /^[0-9A-Za-z\.\-\:\[\]]+$/.test(host)
    }

    parsePingLatency(output, platform) {
        try {
            const match = output.match(/time[=<]([\d\.]+)/i)
            return match ? Math.round(parseFloat(match[1])) : null
        } catch (e) {
            return null
        }
    }

    /**
     * Validates that a shell path resolves within the launcher directory.
     * Returns the resolved path on success, or null on violation.
     * @param {string} targetPath
     * @returns {string|null}
     */
    _sandboxShellPath(targetPath) {
        if (typeof targetPath !== 'string' || !targetPath) return null
        const path = require('path')
        const ConfigManager = require('../assets/js/core/configmanager')
        let launcherDir
        try {
            launcherDir = ConfigManager.getLauncherDirectorySync()
        } catch {
            return null
        }
        if (!launcherDir) return null
        const resolvedBase = path.resolve(launcherDir)
        let resolved
        try {
            resolved = path.resolve(targetPath)
        } catch {
            return null
        }
        if (resolved === resolvedBase || resolved.startsWith(resolvedBase + path.sep)) {
            return resolved
        }
        console.warn(`[IpcRegistry] shell path sandbox violation: "${targetPath}" is outside launcher dir`)
        return null
    }
}

module.exports = new IpcRegistry()
