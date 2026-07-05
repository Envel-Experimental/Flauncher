
const path = require('path')
const os = require('os')
const fs = require('fs/promises')
const { extractZip } = require('../common/FileUtils')
const { LoggerUtil } = require('../util/LoggerUtil')
const { getMojangOS, isLibraryCompatible, mcVersionAtLeast } = require('../common/MojangUtils')
const { Type } = require('../common/DistributionClasses')
const ConfigManager = require('../configmanager')

const logger = LoggerUtil.getLogger('LaunchArgumentBuilder')

/**
 * Module responsible for constructing the JVM arguments and Classpath.
 * 
 * Responsibilities:
 * 1. Resolving JVM arguments for different Minecraft versions (1.12 vs 1.13+).
 * 2. Building the Classpath from Mojang libraries and Server libraries.
 * 3. Extracting Native libraries (dll/so/dylib) to a temp directory.
 * 4. Sanitizing JVM flags (e.g. Removing CMS, adding G1GC).
 */
class LaunchArgumentBuilder {

    /**
     * @param {Object} server The server distribution object.
     * @param {Object} vanillaManifest The vanilla Minecraft manifest.
     * @param {Object} modManifest The mod loader manifest (Forge/Fabric).
     * @param {Object} authUser The authenticated user object.
     * @param {string} launcherVersion The current version of the launcher.
     * @param {string} gameDir The absolute path to the game instance directory.
     * @param {string} commonDir The absolute path to the common directory.
     */
    constructor(server, vanillaManifest, modManifest, authUser, launcherVersion, gameDir, commonDir) {
        this.server = server
        this.vanillaManifest = vanillaManifest
        this.modManifest = modManifest
        this.authUser = authUser
        this.launcherVersion = launcherVersion
        this.gameDir = gameDir
        this.commonDir = commonDir
        this.libPath = path.join(commonDir, 'libraries')
    }

    /**
     * Get the platform specific classpath separator.
     * 
     * @returns {string} ';' for Windows, ':' for Unix.
     */
    static getClasspathSeparator() {
        return process.platform === 'win32' ? ';' : ':'
    }

    /**
     * Construct the full array of JVM arguments for the process.
     * 
     * @param {Array.<Object>} mods The list of enabled mods.
     * @param {string} tempNativePath The path where native libraries are extracted.
     * @param {boolean} usingFabricLoader Whether Fabric is being used.
     * @param {boolean} usingLiteLoader Whether LiteLoader is being used.
     * @param {string} llPath The path to the LiteLoader jar (if applicable).
     * @returns {Array.<string>} The complete array of JVM arguments.
     */
    async constructJVMArguments(mods, tempNativePath, usingFabricLoader, usingLiteLoader, llPath) {
        if (mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)) {
            return await this._constructJVMArguments113(mods, tempNativePath, usingFabricLoader)
        } else {
            return await this._constructJVMArguments112(mods, tempNativePath, usingLiteLoader, llPath)
        }
    }

    /**
     * Internal method to construct arguments for Minecraft 1.12 and older.
     */
    async _constructJVMArguments112(mods, tempNativePath, usingLiteLoader, llPath) {
        let args = []

        // Classpath Argument
        args.push('-cp')
        args.push((await this.classpathArg(mods, tempNativePath, usingLiteLoader, llPath, false)).join(LaunchArgumentBuilder.getClasspathSeparator()))

        // macOS specific UI/System arguments
        if (process.platform === 'darwin') {
            args.unshift('-XstartOnFirstThread')
            args.push('-Xdock:name=FLauncher')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', '..', '..', 'images', 'minecraft.icns'))
        }

        // Memory Settings
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))

        // Sanitize and append GC/Performance flags
        args = args.concat(this._resolveSanitizedJMArgs(args))
        args.push('-Djava.library.path=' + tempNativePath)

        // Main Java Class
        args.push(this.modManifest.mainClass)

        // Forge Arguments
        args = args.concat(this._resolveForgeArgs(usingLiteLoader, llPath))

        return args
    }

    /**
     * Internal method to construct arguments for Minecraft 1.13 and newer.
     */
    async _constructJVMArguments113(mods, tempNativePath, usingFabricLoader) {
        const argDiscovery = /\${*(.*)}/

        // 1. Collect all JVM arguments
        let jvmArgs = [...(this.vanillaManifest.arguments.jvm || [])]
        if (this.modManifest.arguments.jvm != null && this.modManifest !== this.vanillaManifest) {
            jvmArgs = jvmArgs.concat(this.modManifest.arguments.jvm)
        }

        // Add mandatory macOS arguments
        if (process.platform === 'darwin') {
            const hasStartOnFirstThread = jvmArgs.some(arg => {
                if (typeof arg === 'string') return arg === '-XstartOnFirstThread'
                if (typeof arg === 'object' && arg.value) {
                    if (typeof arg.value === 'string') return arg.value === '-XstartOnFirstThread'
                    if (Array.isArray(arg.value)) return arg.value.includes('-XstartOnFirstThread')
                }
                return false
            })
            
            if (!hasStartOnFirstThread) {
                jvmArgs.unshift('-XstartOnFirstThread')
            }
            if (!mcVersionAtLeast('1.17', this.server.rawServer.minecraftVersion)) {
                jvmArgs.push('-Xdock:name=FLauncher')
                jvmArgs.push('-Xdock:icon=' + path.join(__dirname, '..', '..', '..', 'app', 'assets', 'images', 'minecraft.icns'))
            }
        }

        // 1.5 Add native library path if not already present
        const hasLibPath = jvmArgs.some(arg => (typeof arg === 'string' && arg.includes('java.library.path')) || (arg.value && Array.isArray(arg.value) && arg.value.some(v => v.includes('java.library.path'))))
        if (!hasLibPath) {
            jvmArgs.push('-Djava.library.path=' + path.resolve(tempNativePath))
        }
        
        jvmArgs.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        jvmArgs.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        
        jvmArgs.push('-Djna.tmpdir=' + path.resolve(tempNativePath))
        jvmArgs.push('-Dorg.lwjgl.system.SharedLibraryExtractPath=' + path.resolve(tempNativePath))
        jvmArgs.push('-Dio.netty.native.workdir=' + path.resolve(tempNativePath))
        jvmArgs.push('-Dminecraft.launcher.brand=FLauncher')
        jvmArgs.push('-Dminecraft.launcher.version=' + this.launcherVersion)

        const extraJvmArgs = this._resolveSanitizedJMArgs(jvmArgs)
        jvmArgs = jvmArgs.concat(extraJvmArgs)

        // 2. Collect all Game arguments
        let gameArgs = [...(this.vanillaManifest.arguments.game || [])]
        if (this.modManifest.arguments.game != null && this.modManifest !== this.vanillaManifest) {
            gameArgs = gameArgs.concat(this.modManifest.arguments.game)
        }

        // 3. Process rules and placeholders for BOTH
        return this._finishConstruct113(jvmArgs, gameArgs, mods, tempNativePath, usingFabricLoader)
    }

    async _finishConstruct113(jvmArgs, gameArgs, mods, tempNativePath, usingFabricLoader) {
        const resolve = async (args) => {
            // Rule processing
            for (let i = 0; i < args.length; i++) {
                const arg = args[i]
                if (arg == null) continue
                if (typeof arg === 'object' && arg.rules != null) {
                    let allowed = false
                    for (const rule of arg.rules) {
                        let match = true
                        if (rule.os != null) {
                            if (rule.os.name && rule.os.name !== getMojangOS()) match = false
                            if (rule.os.arch && rule.os.arch !== process.arch) {
                                if (!(rule.os.arch === 'aarch64' && process.arch === 'arm64')) match = false
                            }
                            if (rule.os.version && !new RegExp(rule.os.version).test(os.release())) match = false
                        }
                        if (rule.features != null) {
                            for (const [feat, required] of Object.entries(rule.features)) {
                                if (feat === 'has_custom_resolution') {
                                    if (required !== (ConfigManager.getGameWidth() != null && ConfigManager.getGameHeight() != null)) match = false
                                } else if (feat === 'is_demo_user') {
                                    // NEVER allow demo mode rules
                                    match = false
                                } else {
                                    // Any other feature (quick play, etc) is not supported by default
                                    if (required === true) match = false
                                }
                            }
                        }
                        if (match) allowed = (rule.action === 'allow')
                    }
                    if (allowed) {
                        if (Array.isArray(arg.value)) {
                            // Ensure no --demo is hiding in the array values
                            const filteredValue = arg.value.filter(v => v !== '--demo')
                            args.splice(i, 1, ...filteredValue)
                            i--
                        } else {
                            if (arg.value === '--demo') {
                                args[i] = null
                            } else {
                                args[i] = arg.value
                            }
                        }
                    } else {
                        args[i] = null
                    }
                }
            }
            // Placeholder processing
            const final = []
            for (let i = 0; i < args.length; i++) {
                let arg = args[i]
                if (arg == null || arg === '' || arg === '--demo') continue
                if (typeof arg === 'string') {
                    arg = arg.trim()
                    if (arg === this.vanillaManifest.mainClass || arg === 'net.minecraft.client.main.Main') continue
                    
                    // Fix spaces in properties (e.g. -Dprop= value -> -Dprop=value)
                    if (arg.startsWith('-D') && arg.includes('=')) {
                        arg = arg.replace(/=\s+/, '=')
                    }
                    const matches = [...arg.matchAll(/\${(.*?)}/g)]
                    let resolved = arg
                    let anyNull = false
                    for (const match of matches) {
                        const identifier = match[1]
                        let val = null
                        switch (identifier) {
                            case 'auth_player_name': val = this.authUser.displayName.trim(); break;
                            case 'version_name': val = this.server.rawServer.id; break;
                            case 'game_directory': val = this.gameDir; break;
                            case 'assets_root': val = path.join(this.commonDir, 'assets'); break;
                            case 'assets_index_name': val = this.vanillaManifest.assets; break;
                            case 'auth_uuid': val = this.authUser.uuid.trim(); break;
                            case 'auth_access_token': val = this.authUser.accessToken; break;
                            case 'user_type': val = this.authUser.type === 'microsoft' ? 'msa' : 'mojang'; break;
                            case 'version_type': val = this.vanillaManifest.type; break;
                            case 'resolution_width': val = ConfigManager.getGameWidth(); break;
                            case 'resolution_height': val = ConfigManager.getGameHeight(); break;
                            case 'library_directory': val = this.libPath; break;
                            case 'natives_directory': val = tempNativePath; break;
                            case 'launcher_name': val = 'FLauncher'; break;
                            case 'launcher_version': val = this.launcherVersion; break;
                            case 'classpath': val = (await this.classpathArg(mods, tempNativePath, false, null, usingFabricLoader)).join(LaunchArgumentBuilder.getClasspathSeparator()); break;

                            case 'clientid': val = this.authUser.clientId || this.authUser.uuid.trim(); break;
                            case 'auth_xuid': val = this.authUser.xuid || this.authUser.uuid.trim(); break;
                            
                            // Unsupported quick play placeholders -> set to null to trigger removal
                            case 'quickPlayPath':
                            case 'quickPlaySingleplayer':
                            case 'quickPlayMultiplayer':
                            case 'quickPlayRealms':
                                val = null;
                                break;
                        }
                        if (val != null) {
                            resolved = resolved.replaceAll('${' + identifier + '}', val)
                        } else {
                            anyNull = true
                        }
                    }
                    if (anyNull) {
                        // If it contains an unsupported placeholder, we remove this argument.
                        // We also check if the PREVIOUS argument was a flag for this placeholder.
                        if (final.length > 0) {
                            const last = final[final.length - 1]
                            if (last.startsWith('--quickPlay')) {
                                final.pop()
                            }
                        }
                        continue
                    }
                    arg = resolved
                }
                if (arg != null && arg !== '') final.push(arg)
            }
            return final
        }

        const finalJvm = await resolve(jvmArgs)
        const finalGame = await resolve(gameArgs)

        // Deduplicate -XstartOnFirstThread specifically to avoid macOS issues
        let filteredJvm = []
        let hasXstart = false
        for (const arg of finalJvm) {
            if (arg === '-XstartOnFirstThread') {
                if (hasXstart) continue
                hasXstart = true
            }
            filteredJvm.push(arg)
        }

        return filteredJvm.concat([this.modManifest.mainClass]).concat(finalGame)
    }

    /**
     * Removes deprecated JVM flags (CMS) and ensures valid GC flags (G1GC) are present.
     * 
     * @param {Array.<string>} currentArgs The current list of arguments.
     * @returns {Array.<string>} Sanitized extra JVM options.
     */
    _resolveSanitizedJMArgs(currentArgs) {
        const forbidden = ['-XX:+UseConcMarkSweepGC', '-XX:+CMSIncrementalMode']
        const gcFlags = ['-XX:+UseG1GC', '-XX:+UseSerialGC', '-XX:+UseParallelGC', '-XX:+UseZGC', '-XX:+UseShenandoahGC']
        let args = ConfigManager.getJVMOptions(this.server.rawServer.id) || []

        // Filter out forbidden flags
        args = args.filter(arg => !forbidden.includes(arg))

        // Check if any GC is present, otherwise default to G1GC
        const hasGC = args.some(arg => gcFlags.includes(arg)) || currentArgs.some(arg => gcFlags.includes(arg))
        if (!hasGC) args.push('-XX:+UseG1GC')

        return args
    }

    /**
     * Resolves the arguments required by Forge.
     */
    _resolveForgeArgs(usingLiteLoader, llDir) {
        const mcArgs = this.modManifest.minecraftArguments.split(' ')
        const argDiscovery = /\${*(.*)}/
        for (let i = 0; i < mcArgs.length; ++i) {
            if (argDiscovery.test(mcArgs[i])) {
                const identifier = mcArgs[i].match(argDiscovery)[1]
                let val = null
                switch (identifier) {
                    case 'auth_player_name': val = this.authUser.displayName.trim(); break;
                    case 'version_name': val = this.server.rawServer.id; break;
                    case 'game_directory': val = this.gameDir; break;
                    case 'assets_root': val = path.join(this.commonDir, 'assets'); break;
                    case 'assets_index_name': val = this.vanillaManifest.assets; break;
                    case 'auth_uuid': val = this.authUser.uuid.trim(); break;
                    case 'auth_access_token': val = this.authUser.accessToken; break;
                    case 'user_type': val = this.authUser.type === 'microsoft' ? 'msa' : 'mojang'; break;
                    case 'user_properties': val = '{}'; break;
                    case 'version_type': val = this.vanillaManifest.type; break;
                }
                if (val != null) mcArgs[i] = val
            }
        }

        if (ConfigManager.getFullscreen()) {
            mcArgs.push('--fullscreen', true)
        } else {
            mcArgs.push('--width', ConfigManager.getGameWidth(), '--height', ConfigManager.getGameHeight())
        }

        // REFACTOR NOTE: Legacy '--modListFile' argument is handled by the caller (ProcessBuilder)
        // because it involves path logic best resolved at that level.

        return mcArgs
    }



    /**
     * Build the classpath array.
     * 
     * @param {Array.<Object>} mods Enabled mods.
     * @param {string} tempNativePath Path for native extraction.
     * @param {boolean} usingLiteLoader usage flag.
     * @param {string} llPath LiteLoader path.
     * @param {boolean} usingFabricLoader usage flag.
     * @returns {Array.<string>} The array of paths for the classpath.
     */
    async classpathArg(mods, tempNativePath, usingLiteLoader, llPath, usingFabricLoader) {
        let cpArgs = []

        // Add Version Jar (Mojang) - Not needed for Forge 1.17+
        if (!mcVersionAtLeast('1.17', this.server.rawServer.minecraftVersion) || usingFabricLoader) {
            const version = this.vanillaManifest.id
            cpArgs.push(path.join(this.commonDir, 'versions', version, version + '.jar'))
        }
        if (usingLiteLoader) cpArgs.push(llPath)

        // Resolve Libraries
        const mojangLibs = await this._resolveMojangLibraries(tempNativePath)
        const servLibs = this._resolveServerLibraries(mods)
        const finalLibs = { ...mojangLibs, ...servLibs }
        cpArgs = cpArgs.concat(Object.values(finalLibs))

        // Clean up paths (remove trailing jar if duplicated or malformed)
        const { ensureDecodedPath } = require('../util/NodeUtil')
        const ext = '.jar'
        for (let i = 0; i < cpArgs.length; i++) {
            const extIndex = cpArgs[i].lastIndexOf(ext)
            if (extIndex > -1 && extIndex !== cpArgs[i].length - ext.length) {
                cpArgs[i] = cpArgs[i].substring(0, extIndex + ext.length)
            }
            cpArgs[i] = ensureDecodedPath(cpArgs[i])
        }
        return cpArgs
    }

    /**
     * Resolve and extract Mojang declared libraries.
     */
    async _resolveMojangLibraries(tempNativePath) {
        const nativesRegex = /.+:natives-([^-]+)(?:-(.+))?/
        const libs = {}
        const libArr = this.vanillaManifest.libraries

        await fs.mkdir(tempNativePath, { recursive: true })

        // Use a simple internal pool to avoid p-limit (ESM) import issues in CJS
        const limit = 8
        const executing = new Set()
        const tasks = []
        const globalExclusions = new Set()

        logger.info(`Extracting ${libArr.length} Mojang libraries...`)

        for (const lib of libArr) {
            const p = (async () => {
                if (!isLibraryCompatible(lib.rules, lib.natives)) return

                let exclusions = []
                if (lib.natives != null) {
                    exclusions = await this._extractNative(lib, tempNativePath)
                } else if (lib.name.includes('natives-')) {
                    exclusions = await this._extractNativeNew(lib, tempNativePath, nativesRegex)
                } else {
                    const dlInfo = lib.downloads
                    const artifact = dlInfo.artifact
                    const sanitizedArtifactPath = artifact.path.replace(/\.\.+/g, '.')
                    const to = path.join(this.libPath, sanitizedArtifactPath)
                    const versionIndependentId = lib.name.substring(0, lib.name.lastIndexOf(':'))
                    libs[versionIndependentId] = to
                }

                if (exclusions) {
                    exclusions.forEach(e => globalExclusions.add(e))
                }
            })()

            tasks.push(p)
            executing.add(p)
            p.then(() => executing.delete(p)).catch(() => executing.delete(p))

            if (executing.size >= limit) {
                await Promise.race(executing)
            }
        }

        await Promise.all(tasks)
        logger.info('Mojang libraries extraction complete.')

        // Post-Extraction Cleanup (Synchronized)
        // Remove META-INF and other exclusions *after* all files are extracted.
        for (const item of globalExclusions) {
            const target = path.join(tempNativePath, item)
            // Force remove, ignore errors if already gone
            try {
                await fs.rm(target, { recursive: true, force: true })
            } catch (e) {
                logger.warn('Failed to clean up native exclusion:', target, e)
            }
        }

        return libs
    }

    async _extractNative(lib, tempNativePath) {
        const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/']
        const artifact = lib.downloads.classifiers[lib.natives[getMojangOS()].replace('${arch}', process.arch.replace('x', ''))]
        const sanitizedArtifactPath = artifact.path.replace(/\.\.+/g, '.')
        const to = path.join(this.libPath, sanitizedArtifactPath)
        await this._unzip(to, tempNativePath)
        return exclusionArr
    }

    async _extractNativeNew(lib, tempNativePath, nativesRegex) {
        const regexTest = nativesRegex.exec(lib.name)
        let arch = regexTest[2] ?? 'x64'
        if (arch !== process.arch) {
            // Support aarch64 synonym for arm64
            if (!(arch === 'aarch64' && process.arch === 'arm64')) {
                return null
            }
        }

        const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/', '.git', '.sha1']
        const artifact = lib.downloads.artifact
        const sanitizedArtifactPath = artifact.path.replace(/\.\.+/g, '.')
        const to = path.join(this.libPath, sanitizedArtifactPath)

        await this._unzip(to, tempNativePath)
        return exclusionArr
    }

    async _unzip(zipPath, dest) {
        try {
            await extractZip(zipPath, dest)
        } catch (e) {
            logger.error('Error extracting native:', e)
        }
    }

    /**
     * Resolve libraries declared by the server/mods.
     */
    _resolveServerLibraries(mods) {
        const mdls = this.server.modules
        let libs = {}

        // 1. Resolve from Server Modules
        for (let mdl of mdls) {
            const type = mdl.rawModule.type
            if (type === Type.ForgeHosted || type === Type.Fabric || type === Type.Library) {
                libs[mdl.getVersionlessMavenIdentifier()] = mdl.getPath()
                if (mdl.subModules.length > 0) {
                    libs = { ...libs, ...this._resolveModuleLibraries(mdl) }
                }
            }
        }

        // 2. Resolve from Enabled Mods
        for (let i = 0; i < mods.length; i++) {
            // Corrected logic to check subModules on the mod object
            if (mods[i].subModules && mods[i].subModules.length > 0) {
                libs = { ...libs, ...this._resolveModuleLibraries(mods[i]) }
            }
        }
        return libs
    }

    _resolveModuleLibraries(mdl) {
        if (mdl.subModules.length === 0) return {}
        let libs = {}
        for (let sm of mdl.subModules) {
            if (sm.rawModule.type === Type.Library && (sm.rawModule.classpath ?? true)) {
                libs[sm.getVersionlessMavenIdentifier()] = sm.getPath()
            }
            if (sm.subModules.length > 0) {
                libs = { ...libs, ...this._resolveModuleLibraries(sm) }
            }
        }
        return libs
    }

}
module.exports = LaunchArgumentBuilder
