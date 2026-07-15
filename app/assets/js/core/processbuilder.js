
const child_process = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { LoggerUtil } = require('./util/LoggerUtil')
const { Type } = require('./common/DistributionClasses')
const { mcVersionAtLeast } = require('./common/MojangUtils')
const pathutil = require('./pathutil')
const ConfigManager = require('./configmanager')

// New Modules
const ModConfigResolver = require('./game/ModConfigResolver')
const LaunchArgumentBuilder = require('./game/LaunchArgumentBuilder')
const GameCrashHandler = require('./game/GameCrashHandler')

const logger = LoggerUtil.getLogger('ProcessBuilder')

/**
 * Orchestrator class for the Minecraft launch process.
 * 
 * Responsibilities:
 * 1. Coordinating the launch steps: Mod resolution, Argument building, Process spawning.
 * 2. Managing the lifecycle of the game process.
 * 3. Handling process output logging.
 * 4. Delegating specific tasks to specialized helper classes.
 */
class ProcessBuilder {

    /**
     * @param {Object} distroServer The server distribution object.
     * @param {Object} vanillaManifest The vanilla Minecraft manifest.
     * @param {Object} modManifest The mod loader manifest.
     * @param {Object} authUser The authenticated user.
     * @param {string} launcherVersion The launcher version.
     */
    constructor(distroServer, vanillaManifest, modManifest, authUser, launcherVersion) {
        this.server = distroServer
        this.vanillaManifest = vanillaManifest
        this.modManifest = modManifest
        this.authUser = authUser
        this.launcherVersion = launcherVersion

        // Paths
        const sanitizedId = distroServer.rawServer.id.replace(/[<>:"/\\|?*]/g, '_').replace(/\.+/g, '.')
        this.gameDir = path.join(ConfigManager.getInstanceDirectorySync(), sanitizedId)
        this.commonDir = ConfigManager.getCommonDirectorySync()
        this.libPath = path.join(this.commonDir, 'libraries')

        // State
        this.usingLiteLoader = false
        this.usingFabricLoader = false
        this.llPath = null

        // Helpers
        this.modResolver = new ModConfigResolver(this.server, this.modManifest, this.commonDir)
        this.argBuilder = new LaunchArgumentBuilder(this.server, this.vanillaManifest, this.modManifest, this.authUser, this.launcherVersion, this.gameDir, this.commonDir)
    }

    /**
     * Main method to build and spawn the Minecraft process.
     * 
     * @returns {Promise<import('child_process').ChildProcess>} The spawned child process.
     */
    async build() {
        fs.mkdirSync(this.gameDir, { recursive: true })
        const tempNativePath = this._setupTempNatives()

        // 1. Resolve Mods
        logger.info('Resolving mod configuration...')
        this._setupLoaders()
        const modObj = this.modResolver.resolveModConfiguration(
            ConfigManager.getModConfiguration(this.server.rawServer.id).mods,
            this.server.modules
        )
        logger.info('Mod configuration resolved.')

        // 2. Write Mod Lists (Pre-1.13)
        if (!mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)) {
            const fmlDir = path.join(this.gameDir, 'forgeModList.json')
            const llDir = path.join(this.gameDir, 'liteloaderModList.json')

            this.modResolver.constructJSONModList('forge', modObj.fMods, fmlDir, llDir, true)
            if (this.usingLiteLoader) {
                this.modResolver.constructJSONModList('liteloader', modObj.lMods, fmlDir, llDir, true)
            }
        }

        // 3. Construct Arguments
        logger.info('Constructing JVM arguments...')
        let args = await this.argBuilder.constructJVMArguments(
            modObj.fMods.concat(modObj.lMods),
            tempNativePath,
            this.usingFabricLoader,
            this.usingLiteLoader,
            this.llPath
        )
        logger.info('JVM arguments constructed.')

        // 4. Mod List (1.13+)
        if (mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)) {
            const forgeModListFile = path.join(this.gameDir, 'forgeMods.list')
            const modArgs = this.modResolver.constructModList(modObj.fMods, forgeModListFile, this.usingFabricLoader)
            args = args.concat(modArgs)
        }

        // 5. Appending Legacy Forge Args
        if (!mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)) {
            const fmlDir = path.join(this.gameDir, 'forgeModList.json')
            args.push('--modListFile')
            if (this.modResolver._lteMinorVersion(9)) {
                args.push(path.basename(fmlDir))
            } else {
                args.push('absolute:' + fmlDir)
            }
        }

        // 6. Spawn Process
        const { ensureDecodedPath } = require('./util/NodeUtil')
        const { isJavaExecPath } = require('./java/JavaGuard')
        const { javaExecFromRoot } = require('./java/JavaUtils')
        let resolvedJavaPath = ensureDecodedPath(ConfigManager.getJavaExecutable(this.server.rawServer.id))
        if (resolvedJavaPath && !isJavaExecPath(resolvedJavaPath)) {
            resolvedJavaPath = javaExecFromRoot(resolvedJavaPath)
        }
        this.javaPath = resolvedJavaPath
        const javaPath = this.javaPath
        
        let finalArgs = args
        if (process.platform === 'win32') {
            finalArgs = args.map(arg => {
                if (typeof arg !== 'string') return arg
                
                const makeRelative = (p) => {
                    if (path.isAbsolute(p)) {
                        if (p.startsWith(this.gameDir) || p.startsWith(this.commonDir)) {
                            return path.relative(this.gameDir, p) || '.'
                        }
                    }
                    return p
                }

                if (arg.includes(';')) {
                    return arg.split(';').map(makeRelative).join(';')
                }

                if (arg.startsWith('@') && path.isAbsolute(arg.substring(1))) {
                    return '@' + makeRelative(arg.substring(1))
                }

                if (arg.startsWith('-D') && arg.includes('=')) {
                    const eqIdx = arg.indexOf('=')
                    const key = arg.substring(0, eqIdx)
                    const val = arg.substring(eqIdx + 1)
                    return key + '=' + makeRelative(val)
                }

                return makeRelative(arg)
            })
        }
        this.args = finalArgs

        const sanitizedArgs = finalArgs.filter(arg => arg != null).map((arg, index, arr) => {
            if (index > 0 && (arr[index - 1] === '--accessToken' || arr[index - 1] === '--uuid')) return '***'
            return arg
        })
        logger.info(`Platform: ${process.platform}, Arch: ${process.arch}`)
        logger.info('Launch Arguments:', sanitizedArgs)
        logger.info('Full Command:', [javaPath, ...sanitizedArgs].join(' '))

        if (!javaPath || !fs.existsSync(javaPath)) {
            throw new Error('Не удалось найти Java. Проверьте настройки в разделе Java.')
        }

        try {
            fs.accessSync(javaPath, fs.constants.X_OK)
        } catch (e) {
            throw new Error('Проблема с доступом к файлам Java (недостаточно прав).', { cause: e })
        }

        const child = child_process.spawn(javaPath, finalArgs, {
            cwd: this.gameDir,
            detached: ConfigManager.getLaunchDetached()
        })

        if (ConfigManager.getLaunchDetached()) {
            child.unref()
        }

        this._setupLogging(child, javaPath, sanitizedArgs)

        // 7. Handle Exit / Crash
        // We defer this entirely to GameCrashHandler
        const crashHandler = new GameCrashHandler(this.gameDir, this.commonDir, this.server, this.logBuffer)

        child.on('close', async (code, signal) => {
            child._hasClosed = true
            child._closeCode = code
            // Cleanup Natives
            this._cleanupTempNatives(tempNativePath)
            // Handle Crash UI
            await crashHandler.handleExit(code)
        })

        child.on('error', (err) => {
            logger.error('Failed to start Minecraft process:', err)
            // Emit an error string into the log buffer so the UI crash handler can see it
            if (this.logBuffer) {
                this.logBuffer.push(`[Process Error]: Failed to start Java process: ${err.message}`)
            }
        })

        return child
    }

    /**
     * Determine which mod loaders (LiteLoader, Fabric) are being used.
     */
    _setupLoaders() {
        // LiteLoader
        for (let ll of this.server.modules) {
            if (ll.rawModule.type === Type.LiteLoader) {
                const req = ll.getRequired()
                const modCfg = ConfigManager.getModConfiguration(this.server.rawServer.id).mods
                const enabled = ModConfigResolver.isModEnabled(modCfg[ll.getVersionlessMavenIdentifier()], req)

                if ((!req.value && enabled) || req.value) {
                    if (fs.existsSync(ll.getPath())) {
                        this.usingLiteLoader = true
                        this.llPath = ll.getPath()
                    }
                }
            }
        }
        logger.info('Using liteloader:', this.usingLiteLoader)

        // Fabric
        this.usingFabricLoader = this.server.modules.some(mdl => mdl.rawModule.type === Type.Fabric)
        logger.info('Using fabric loader:', this.usingFabricLoader)
    }

    _setupTempNatives() {
        const currentSystemTemp = os.tmpdir()
        let nativeBasePath = currentSystemTemp
        const isWindows = process.platform === 'win32'

        if ((isWindows && currentSystemTemp.includes('~')) || !pathutil.isPathValid(currentSystemTemp)) {
            nativeBasePath = path.join(this.commonDir, 'temp_natives')
            try {
                fs.mkdirSync(nativeBasePath, { recursive: true })
            } catch (err) {
                nativeBasePath = currentSystemTemp
            }
        }
        const finalPath = path.join(nativeBasePath, ConfigManager.getTempNativeFolder(), crypto.randomBytes(16).toString('hex'))
        return pathutil.toShortPath(finalPath)
    }

    /**
     * Clean up the temporary native directory after process exit.
     */
    _cleanupTempNatives(tempNativePath) {
        try {
            fs.promises.rm(tempNativePath, { recursive: true, force: true }).catch(err => logger.warn('Failed to clean temp natives', err))
        } catch (e) {
            // ignore
        }
    }

    /**
     * Pipe process output to logger and internal memory buffer for crash analysis.
     */
    _setupLogging(child, javaPath, sanitizedArgs) {
        this.logBuffer = []
        
        // Inject Launch Context into the crash buffer
        const contextString = `====================================================\nLaunch Context:\nJava Path: ${javaPath}\nArguments: ${sanitizedArgs.join(' ')}\n====================================================\n`
        
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        const handleLog = (data, isErr) => {
            const lines = data.split('\n')
            let added = false
            for (let x of lines) {
                const trimmed = x.trim()
                if (trimmed.length > 0) {
                    const color = isErr ? '\x1b[31m' : '\x1b[32m'
                    console.log(`${color}[Minecraft]\x1b[0m ${trimmed}`)
                    this.logBuffer.push(trimmed)
                    added = true
                }
            }
            if (added && this.logBuffer.length > 1000) {
                this.logBuffer = this.logBuffer.slice(-1000)
            }
        }

        // Print context directly
        handleLog(contextString, false)

        child.stdout.on('data', d => handleLog(d, false))
        child.stderr.on('data', d => handleLog(d, true))
    }

    /**
     * Get class path separator for the current platform.
     */
    static getClasspathSeparator() {
        return process.platform === 'win32' ? ';' : ':'
    }
}

module.exports = ProcessBuilder
