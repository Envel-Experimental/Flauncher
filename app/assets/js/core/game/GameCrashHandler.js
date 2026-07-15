const { shell } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { LoggerUtil } = require('../util/LoggerUtil')
const { Type } = require('../common/DistributionClasses')
// Sentry is handled via IPC in Renderer or direct require in Main
const SentryService = (process.type !== 'renderer') ? require('../../../../main/SentryService') : null

const CrashHandler = require('../crash-handler')
const DropinModUtil = require('../dropinmodutil')
const ConfigManager = require('../configmanager')
const Lang = require('../langloader')

const logger = LoggerUtil.getLogger('GameCrashHandler')

// Dynamically import Electron components based on process type
const { ipcMain, BrowserWindow } = (process.type !== 'renderer') ? require('electron') : { ipcMain: null, BrowserWindow: null }



/**
 * Module responsible for handling game crashes and exit events.
 * 
 * Responsibilities:
 * 1. Listening for process exit codes.
 * 2. Analyzing logs and crash reports to determine the cause.
 * 3. Displaying appropriate UI overlays (Driver issues, OOM, General Crash).
 * 4. Executing fix actions (e.g., deleting corrupted files, opening external help links).
 */
class GameCrashHandler {
    static lastActiveHandler = null
    static lastCrashAnalysis = null

    /**
     * @param {string} gameDir Absolute path to the game directory.
     * @param {string} commonDir Absolute path to the common directory.
     * @param {Object} server The server distribution object.
     * @param {Array.<string>} logBuffer Buffer of the last 1000 console lines from the process.
     */
    constructor(gameDir, commonDir, server, logBuffer) {
        this.gameDir = gameDir
        this.commonDir = commonDir
        this.server = server
        this.logBuffer = logBuffer
    }

    /**
     * Main entry point when the game process exits.
     * 
     * @param {number} code The exit code of the process.
     */
    async handleExit(code) {
        logger.info('Exited with code', code)

        // Codes 0 (Success), 130 (SIGINT), 137 (SIGKILL), 143 (SIGTERM), 255 (User Force Quit sometimes) are not crashes.
        const isCrash = code !== 0 && code !== 130 && code !== 137 && code !== 143 && code !== 255

        if (isCrash) {
            GameCrashHandler.lastActiveHandler = this // Store for IPC-triggered fixes
            const crashAnalysis = await this.analyzeCrash()
            GameCrashHandler.lastCrashAnalysis = crashAnalysis // Store analysis for fix logic
            logger.info('Crash analysis result:', crashAnalysis)

            if (crashAnalysis) {
                if (crashAnalysis.type === 'java-oom') {
                    this.enrichOOMAnalysis(crashAnalysis)
                }
                logger.info('Showing specific crash overlay...')
                await this.showSpecificCrashOverlay(crashAnalysis)
            } else {
                logger.info('Showing generic crash overlay...')
                await this.showGenericCrashOverlay(code)
            }
        } else {
            logger.info('Exit was not a crash, skipping overlay.')
        }
    }

    /**
     * Helper to call UI functions (overlays) regardless of process type.
     * 
     * @param {string} fn Name of the function to call on the Renderer's window object.
     * @param  {...any} args Arguments for the function.
     * @private
     */
    async _callUI(fn, ...args) {
        logger.info(`Attempting to call UI function: ${fn}`, args)
        if (process.type === 'renderer') {
            logger.info('In Renderer process, calling window directly.')
            if (typeof window !== 'undefined' && window[fn]) {
                window[fn](...args)
            } else {
                logger.warn(`UI function ${fn} not found in Renderer.`)
            }
        } else {
            // Main Process: Send IPC to the main window
            logger.info('In Main process, sending IPC to Renderer.')
            const WindowManager = require('../../../../main/WindowManager')
            const win = WindowManager.getMainWindow()
            if (win && !win.isDestroyed()) {
                logger.info('Main window found, sending ui:call.')
                win.webContents.send('ui:call', { fn, args })
            } else {
                logger.warn(`Cannot call UI function ${fn}: Main window is not available or destroyed.`)
            }
        }
    }

    /**
     * Analyze log files, crash reports, and memory buffers to identify the crash reason.
     * 
     * @returns {Object|null} The crash analysis object or null if unknown.
     */
    async analyzeCrash() {
        const logPath = path.join(this.gameDir, 'logs', 'latest.log')
        const crashReportsDir = path.join(this.gameDir, 'crash-reports')
        let crashAnalysis = null

        // 1. Try reading from disk (Preferred, contains full context)
        try {
            await new Promise(resolve => setTimeout(resolve, 1500))
            crashAnalysis = await CrashHandler.analyzeFile(logPath)
        } catch (e) {
            logger.warn('Failed to analyze latest.log file', e)
        }

        // 2. Fallback: Check for fresh crash report files
        if (!crashAnalysis) {
            try {
                // Check if directory exists
                const crashReportsExist = await fs.promises.stat(crashReportsDir).then(() => true).catch(() => false)
                if (crashReportsExist) {
                    const files = await fs.promises.readdir(crashReportsDir)
                    const crashFiles = await Promise.all(files
                        .filter(f => f.endsWith('.txt') || f.endsWith('.log'))
                        .map(async f => {
                            const p = path.join(crashReportsDir, f)
                            const s = await fs.promises.stat(p)
                            return { name: f, path: p, time: s.mtime.getTime() }
                        }))
                    crashFiles.sort((a, b) => b.time - a.time)

                    if (crashFiles.length > 0) {
                        const newestCrash = crashFiles[0]
                        // If file was created in the last 2 minutes
                        if (Date.now() - newestCrash.time < 120 * 1000) {
                            logger.info(`Found fresh crash report: ${newestCrash.name}`)
                            crashAnalysis = await CrashHandler.analyzeFile(newestCrash.path)
                        }
                    }
                }
            } catch (e) {
                logger.warn('Failed to find/read crash report file', e)
            }
        }

        // 3. Fallback: Check memory buffer if disk failed
        if (!crashAnalysis) {
            logger.info('Disk log analysis failed. Analyzing memory buffer...')
            const memoryLog = this.logBuffer ? this.logBuffer.join('\n') : ''
            crashAnalysis = CrashHandler.analyzeLog(memoryLog)
        }

        return crashAnalysis
    }

    /**
     * Display a specific overlay based on the analyzed crash type.
     * 
     * @param {Object} crashAnalysis The analysis result from CrashHandler using logs.
     */
    async showSpecificCrashOverlay(crashAnalysis) {
        const description = crashAnalysis.descriptionKey 
            ? Lang.queryJS(`crash.${crashAnalysis.descriptionKey}`, crashAnalysis.descriptionArgs)
            : (crashAnalysis.description || 'Unknown crash')

        if (ConfigManager.getSupportUrl()) {
            await this._callUI('setOverlayContent',
                Lang.queryJS('processbuilder.crash.title'),
                Lang.queryJS('processbuilder.crash.body', { description }),
                Lang.queryJS('processbuilder.crash.fix'),
                'Поддержка', // Button 2
                Lang.queryJS('processbuilder.crash.close') // Button 3 (Dismiss)
            )
            
            // Set handlers. In Main process, these are registered via IPC listeners in the Renderer.
            if (process.type === 'renderer') {
                window.setOverlayHandler(() => this.handleCrashFix(crashAnalysis))
                window.setMiddleButtonHandler(() => {
                    shell.openExternal(ConfigManager.getSupportUrl())
                    window.toggleOverlay(false)
                })
                window.setDismissHandler(() => window.toggleOverlay(false))
            } else {
                // Main Process: The Renderer's uibinder/overlay should listen for 'ui:crash-fix' etc.
                // Or we can register one-time IPC handlers.
                const { ipcMain } = require('electron')
                ipcMain.once('ui:crash-fix-action', () => this.handleCrashFix(crashAnalysis))
                ipcMain.once('ui:crash-support-action', () => {
                    shell.openExternal(ConfigManager.getSupportUrl())
                    this._callUI('toggleOverlay', false)
                })
                // Tell renderer which handlers to bind
                await this._callUI('setOverlayHandler', 'ui:crash-fix-action')
                await this._callUI('setMiddleButtonHandler', 'ui:crash-support-action')
                await this._callUI('setDismissHandler', null)
            }
            await this._callUI('toggleOverlay', true, true)
        } else {
            await this._callUI('setOverlayContent',
                Lang.queryJS('processbuilder.crash.title'),
                Lang.queryJS('processbuilder.crash.body', { description }),
                Lang.queryJS('processbuilder.crash.fix'),
                Lang.queryJS('processbuilder.crash.close') // Button 2
            )
            
            if (process.type === 'renderer') {
                window.setOverlayHandler(() => this.handleCrashFix(crashAnalysis))
                window.setMiddleButtonHandler(() => window.toggleOverlay(false))
                window.setDismissHandler(null)
            } else {
                const { ipcMain } = require('electron')
                ipcMain.removeAllListeners('ui:crash-fix-action')
                ipcMain.removeAllListeners('ui:close-overlay')
                ipcMain.once('ui:crash-fix-action', () => this.handleCrashFix(crashAnalysis))
                ipcMain.once('ui:close-overlay', () => this._callUI('toggleOverlay', false))
                await this._callUI('setOverlayHandler', 'ui:crash-fix-action')
                await this._callUI('setMiddleButtonHandler', 'ui:close-overlay') // Predefined or generic
                await this._callUI('setDismissHandler', null)
            }
            await this._callUI('toggleOverlay', true)
        }
    }

    /**
     * Display a generic crash overlay with the exit code and option to disable mods.
     * 
     * @param {number} code Exit code.
     */
    async showGenericCrashOverlay(code) {
        // IMPROVED CRASH REPORTING: Extract "Smart" Signature for Sentry Grouping
        let sentryMessage = `Process exited with code: ${code}`
        let sentryType = 'error'

        if (this.logBuffer && this.logBuffer.length > 0) {
            const fullLog = this.logBuffer.join('\n')

            // Common Java Exception Patterns
            const exceptionMatch = fullLog.match(/Exception in thread "[^"]+" ([\w\.]+)/) ||
                fullLog.match(/(java\.lang\.[\w]+Exception)/) ||
                fullLog.match(/(java\.lang\.[\w]+Error)/) ||
                fullLog.match(/([a-zA-Z0-9_\.]*Exception)/)

            if (exceptionMatch) {
                // Found a specific Java exception (e.g. java.lang.UnsatisfiedLinkError)
                // Use this as the error message so Sentry groups them together
                sentryMessage = `Game Crash: ${exceptionMatch[1]}`
            } else if (fullLog.includes('Out of memory') || fullLog.includes('Native memory allocation (malloc) failed')) {
                sentryMessage = 'Game Crash: Out of Memory'
            } else if (fullLog.includes('EXCEPTION_ACCESS_VIOLATION')) {
                sentryMessage = 'Game Crash: Native Access Violation'
            }

            // Append log tail to the *details* (stack trace / context) not the title/message if possible
            // But since we are using captureException(new Error(msg)), we can append it after a newline
            // Sentry usually groups by the first line or the type.
            const logTail = this.logBuffer.slice(-25).join('\n')
            sentryMessage += `\n\n--- Log Tail ---\n${logTail}`
        }

        // Ignore Sentry reports for Game OOM (it's user's machine exhaustion, not our bug)
        if (!sentryMessage.includes('Game Crash: Out of Memory')) {
            if (process.type === 'renderer') {
                HeliosAPI.ipc.send('renderer-error', sentryMessage)
            } else if (SentryService) {
                SentryService.captureMessage(sentryMessage, sentryType)
            }
        }

        // Check for Support URL again (in case preloader failed or config desync)
        let supportUrl = ConfigManager.getSupportUrl()
        if (!supportUrl) {
            try {
                // Determine remote URL from network/config
                const NetworkConfig = require('../../../../../network/config')
                const response = await fetch(NetworkConfig.SUPPORT_CONFIG_URL, { cache: 'no-store' })
                if (response.ok) {
                    const data = await response.json()
                    if (data.url) {
                        supportUrl = data.url
                        ConfigManager.setSupportUrl(supportUrl)
                        await ConfigManager.save()
                    }
                }
            } catch (err) {
                logger.warn('Failed to fetch support URL during crash handling', err)
            }
        }

        if (supportUrl) {
            await this._callUI('setOverlayContent',
                Lang.queryJS('processbuilder.exit.crash.title'),
                Lang.queryJS('processbuilder.exit.crash.body', { exitCode: code }),
                'Поддержка', // Button 1
                Lang.queryJS('processbuilder.exit.crash.disable'), // Button 2
                Lang.queryJS('processbuilder.exit.crash.close') // Button 3
            )

            if (process.type === 'renderer') {
                window.setOverlayHandler(() => {
                    shell.openExternal(supportUrl)
                    window.toggleOverlay(false)
                })
                window.setMiddleButtonHandler(() => this.disableOptionalMods())
                window.setDismissHandler(() => window.toggleOverlay(false))
            } else {
                const { ipcMain } = require('electron')
                ipcMain.once('ui:crash-support-action', () => {
                    shell.openExternal(supportUrl)
                    this._callUI('toggleOverlay', false)
                })
                ipcMain.once('ui:crash-disable-mods-action', () => this.disableOptionalMods())
                
                await this._callUI('setOverlayHandler', 'ui:crash-support-action')
                await this._callUI('setMiddleButtonHandler', 'ui:crash-disable-mods-action')
                await this._callUI('setDismissHandler', null)
            }
            await this._callUI('toggleOverlay', true, true)
        } else {
            await this._callUI('setOverlayContent',
                Lang.queryJS('processbuilder.exit.crash.title'),
                Lang.queryJS('processbuilder.exit.crash.body', { exitCode: code }),
                Lang.queryJS('processbuilder.exit.crash.close'), // Button 1
                Lang.queryJS('processbuilder.exit.crash.disable') // Button 2
            )
            
            if (process.type === 'renderer') {
                window.setOverlayHandler(() => window.toggleOverlay(false))
                window.setMiddleButtonHandler(() => this.disableOptionalMods())
                window.setDismissHandler(null)
            } else {
                const { ipcMain } = require('electron')
                ipcMain.removeAllListeners('ui:crash-disable-mods-action')
                ipcMain.removeAllListeners('ui:close-overlay')
                ipcMain.once('ui:crash-disable-mods-action', () => this.disableOptionalMods())
                ipcMain.once('ui:close-overlay', () => this._callUI('toggleOverlay', false))
                await this._callUI('setOverlayHandler', 'ui:close-overlay')
                await this._callUI('setMiddleButtonHandler', 'ui:crash-disable-mods-action')
                await this._callUI('setDismissHandler', null)
            }
            await this._callUI('toggleOverlay', true)
        }
    }

    /**
     * Execute the fix for a known crash type.
     * 
     * @param {Object} crashAnalysis The crash analysis.
     */
    async handleCrashFix(crashAnalysis) {
        if (crashAnalysis.type === 'missing-version-file') {
            const versionPath = path.join(this.commonDir, 'versions', path.basename(crashAnalysis.file, '.json'))
            if (fs.existsSync(versionPath)) {
                fs.rmSync(versionPath, { recursive: true, force: true })
            }
            await this._callUI('toggleOverlay', false)

        } else if (crashAnalysis.type === 'incompatible-mods') {
            const modsDir = path.join(this.gameDir, 'mods')
            try {
                const dropinMods = await DropinModUtil.scanForDropinMods(modsDir, this.server.rawServer.minecraftVersion)
                if (Array.isArray(dropinMods)) {
                    for (const mod of dropinMods) {
                        const filePath = path.join(modsDir, mod.fullName)
                        if (process.type === 'renderer') {
                            await window.HeliosAPI.ipc.invoke('fs:unlink', filePath)
                        } else {
                            const fsSync = require('fs')
                            if (fsSync.existsSync(filePath)) fsSync.unlinkSync(filePath)
                        }
                    }
                }
            } catch (e) {
                logger.warn('Failed to delete drop-in mods', e)
            }

            // Reset config
            let modCfg = ConfigManager.getModConfiguration(this.server.rawServer.id)
            if (modCfg) {
                modCfg.mods = {}
                ConfigManager.setModConfiguration(this.server.rawServer.id, modCfg)
                await ConfigManager.save()
            }

            this.restartGame()



        } else if (crashAnalysis.type === 'java-corruption') {
            await this.handleJavaRepair()
        } else {
            // Config file corruption
            const configPath = path.resolve(this.gameDir, 'config', crashAnalysis.file || '')
            const configDir = path.join(this.gameDir, 'config')
            const relative = path.relative(configDir, configPath)
            const isSafe = relative && !relative.startsWith('..') && !path.isAbsolute(relative)

            if (isSafe && fs.existsSync(configPath)) {
                const disabledPath = configPath + '.disabled'
                if (fs.existsSync(disabledPath)) fs.unlinkSync(disabledPath)
                fs.renameSync(configPath, disabledPath)
            }
            this.restartGame()
        }
    }

    /**
     * Disable all optional mods and save configuration.
     */
    async disableOptionalMods() {
        const modCfg = ConfigManager.getModConfiguration(this.server.rawServer.id)
        for (const mdl of this.server.modules) {
            const type = mdl.rawModule.type
            if (type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod) {
                if (!mdl.getRequired().value) {
                    modCfg.mods[mdl.getVersionlessMavenIdentifier()] = { value: false }
                }
            }
        }
        ConfigManager.setModConfiguration(this.server.rawServer.id, modCfg)
        await ConfigManager.save()

        this._callUI('setOverlayContent',
            Lang.queryJS('processbuilder.exit.disabled.title'),
            Lang.queryJS('processbuilder.exit.disabled.body'),
            Lang.queryJS('processbuilder.exit.disabled.close')
        )
        
        if (process.type === 'renderer') {
            window.setOverlayHandler(() => window.toggleOverlay(false))
            window.setMiddleButtonHandler(null)
        } else {
            const { ipcMain } = require('electron')
            ipcMain.removeAllListeners('ui:close-overlay')
            ipcMain.once('ui:close-overlay', () => this._callUI('toggleOverlay', false))
            this._callUI('setOverlayHandler', 'ui:close-overlay')
            this._callUI('setMiddleButtonHandler', null)
        }
    }

    /**
     * Attempts to repair a corrupted Java installation by deleting it and resetting config.
     */
    async handleJavaRepair() {
        const serverId = this.server.rawServer.id
        const javaPath = ConfigManager.getJavaExecutable(serverId)

        if (!javaPath) {
            logger.warn('Cannot repair Java: No Java executable configured.')
            this.restartGame()
            return
        }

        const dataDir = ConfigManager.getDataDirectory()
        // Reliable cross-platform check if path is inside data directory
        const relativeToData = path.relative(dataDir, javaPath)
        const isManaged = relativeToData && !relativeToData.startsWith('..') && !path.isAbsolute(relativeToData)

        if (isManaged) {
            logger.info(`Detected corrupted managed Java at ${javaPath}. Attempting removal...`)

            try {
                const runtimeDir = path.join(dataDir, 'runtime')
                // If the path is definitely inside runtime
                const relativeToRuntime = path.relative(runtimeDir, javaPath)
                if (relativeToRuntime && !relativeToRuntime.startsWith('..') && !path.isAbsolute(relativeToRuntime)) {
                    // Standard structure: <dataDir>/runtime/<arch>/<folder>/bin/java...
                    const relative = path.relative(runtimeDir, javaPath)
                    const parts = relative.split(path.sep)

                    // parts[0] = arch, parts[1] = java-folder
                    if (parts.length >= 2) {
                        const dirToDelete = path.join(runtimeDir, parts[0], parts[1])
                        logger.info(`Removing Java directory: ${dirToDelete}`)
                        if (fs.existsSync(dirToDelete)) {
                            fs.rmSync(dirToDelete, { recursive: true, force: true })
                        }
                    }
                }
            } catch (e) {
                logger.error('Failed to repair Java', e)
            }
        } else {
            logger.warn('Java is not managed by launcher (custom path). Resetting config to force re-selection.')
        }

        // Reset config to force re-download or re-selection
        ConfigManager.setJavaExecutable(serverId, null)
        await ConfigManager.save()
        logger.info('Java configuration reset. Restarting...')

        this.restartGame()
    }

    /**
     * Attempt to automatically restart the game.
     */
    async restartGame() {
        await this._callUI('toggleOverlay', false)
        if (process.type === 'renderer') {
            setTimeout(() => {
                const launchBtn = document.getElementById('launch_button')
                if (launchBtn) launchBtn.click()
            }, 1000)
        } else {
            // Main Process: Tell renderer to click the button or just trigger launch via IPC
            await this._callUI('clickElement', 'launch_button')
        }
    }

    /**
     * Enriches the OOM crash analysis with specific advice based on system memory.
     * @param {Object} analysis The crash analysis object.
     */
    enrichOOMAnalysis(analysis) {
        const totalMem = os.totalmem() / (1024 * 1024 * 1024) // GB
        const freeMem = os.freemem() / (1024 * 1024 * 1024) // GB

        let advice = ""
        if (totalMem < 6) {
            advice = "Мало оперативной памяти (RAM). Попробуй закрыть все лишние программы."
        } else if (freeMem < 2.5) {
            advice = "Мало свободной оперативной памяти. Закрой все лишние программы."
        } else {
            advice = "Оперативной памяти достаточно, но игра вылетела. Попробуй выделить больше памяти игре в настройках лаунчера (Настройки -> Java)."
        }

        analysis.description = `Игра закрылась из-за нехватки памяти.\n\n${advice}\n\n(Свободно: ${freeMem.toFixed(1)} GB, Всего: ${totalMem.toFixed(1)} GB)`
    }

    /**
     * Public method to perform the fix, usually called via IPC.
     */
    async performFix() {
        logger.info('Performing crash fix...')
        const analysis = GameCrashHandler.lastCrashAnalysis
        
        try {
            if (analysis) {
                logger.info(`Handling fix for crash type: ${analysis.type}`)
                
                if (analysis.type === 'incompatible-mods') {

                    const modsDir = path.join(this.gameDir, 'mods')
                    if (fs.existsSync(modsDir)) {
                        logger.info(`Deleting mods directory: ${modsDir}`)
                        // Use fs.rmSync or similar to delete directory
                        fs.rmSync(modsDir, { recursive: true, force: true })
                    }
                } else if (analysis.type === 'corrupted-config') {
                    if (analysis.file) {
                        const configFile = path.join(this.gameDir, analysis.file)
                        if (fs.existsSync(configFile)) {
                            logger.info(`Deleting corrupted config: ${configFile}`)
                            fs.unlinkSync(configFile)
                        }
                    }
                } else if (analysis.type === 'wrong-java-version') {
                    logger.info(`Resetting Java Executable due to wrong-java-version crash for server ${this.server.rawServer.id}`)
                    ConfigManager.setJavaExecutable(this.server.rawServer.id, null)
                    await ConfigManager.save()
                }
                // Add more fix types as needed
            }

            // Relaunch the launcher
            logger.info('Fix complete, requesting launcher restart.')
            const { ipcMain } = require('electron')
            ipcMain.emit('app:restart')
        } catch (err) {
            logger.error('Failed to perform crash fix:', err)
        }
    }

    /**
     * Static helper to perform fix on the last active handler.
     */
    static async performLastFix() {
        if (GameCrashHandler.lastActiveHandler) {
            await GameCrashHandler.lastActiveHandler.performFix()
        } else {
            logger.warn('No active crash handler to perform fix.')
        }
    }
}

module.exports = GameCrashHandler
