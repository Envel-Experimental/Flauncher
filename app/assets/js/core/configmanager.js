// @ts-check
const fs = require('fs/promises')
const { LoggerUtil } = require('./util/LoggerUtil')
const os = require('os')
const path = require('path')
const pathutil = require('./pathutil')
const SecurityUtils = require('./util/SecurityUtils')

const logger = LoggerUtil.getLogger('ConfigManager')

const isRenderer = process.type === 'renderer'

/**
 * @typedef {Object} GameSettings
 * @property {number} resWidth
 * @property {number} resHeight
 * @property {boolean} fullscreen
 * @property {boolean} launchDetached
 */

/**
 * @typedef {Object} LauncherSettings
 * @property {boolean} allowPrerelease
 * @property {string} dataDirectory
 * @property {boolean} totalRAMWarningShown
 */

/**
 * @typedef {Object} DeliverySettings
 * @property {boolean} localOptimization
 * @property {boolean} globalOptimization
 * @property {boolean} p2pUploadEnabled
 * @property {number} p2pUploadLimit
 * @property {boolean} p2pOnlyMode
 * @property {boolean} noMojang
 * @property {boolean} noServers
 */

/**
 * @typedef {Object} AuthAccount
 * @property {string} uuid
 * @property {string} displayName
 * @property {string} accessToken
 * @property {string} username
 * @property {'mojang'|'microsoft'} type
 * @property {number} expiresAt
 * @property {Object} [microsoft]
 */

/**
 * @typedef {Object} JavaConfig
 * @property {string} minRAM
 * @property {string} maxRAM
 * @property {Object.<string, {minRAM?: string, maxRAM?: string}>} [overrides]
 */

/**
 * @typedef {Object} Config
 * @property {Object} settings
 * @property {GameSettings} settings.game
 * @property {LauncherSettings} settings.launcher
 * @property {DeliverySettings} settings.deliveryOptimization
 * @property {boolean} settings.p2pPromptShown
 * @property {string|null} clientToken
 * @property {string|null} selectedServer
 * @property {string|null} selectedAccount
 * @property {Object.<string, AuthAccount>} authenticationDatabase
 * @property {Object.<string, any>} modConfigurations
 * @property {JavaConfig} javaConfig
 * @property {string|null} supportUrl
 * @property {boolean} [firstLaunch]
 */

/**
 * @type {Config}
 */
let config = null

const DEFAULT_CONFIG = {
    settings: {
        game: {
            resWidth: 1280,
            resHeight: 720,
            fullscreen: false,
            launchDetached: true
        },
        launcher: {
            allowPrerelease: false,
            dataDirectory: '',
            totalRAMWarningShown: false,
            backgroundVideoPaused: false,
            backgroundVideoInitialized: false
        },
        deliveryOptimization: {
            localOptimization: false,
            globalOptimization: false,
            p2pUploadEnabled: false,
            p2pUploadLimit: 5,
            p2pOnlyMode: false,
            noMojang: false,
            noServers: false
        },
        p2pPromptShown: false
    },
    clientToken: null,
    selectedServer: null,
    selectedAccount: null,
    authenticationDatabase: {},
    modConfigurations: {},
    javaConfig: {
        minRAM: '1G',
        maxRAM: '3G'
    },
    supportUrl: null,
    lastLauncherVersion: null
}

let configPath = null
let configPathLEGACY = null
let firstLaunch = false

/**
 * Retrieve the absolute path of the launcher directory.
 */
exports.getLauncherDirectory = async function () {
    if (isRenderer) {
        console.log('[ConfigManager] Requesting launcher directory from Main...')
        return await /** @type {any} */ (window).HeliosAPI.ipc.invoke('config:getLauncherDirectory')
    }
    const { app } = require('electron')
    const path = pathutil.resolveDataPathSync(app)
    console.log('[ConfigManager] Evaluated launcher directory (Main):', path)
    return path
}

/**
 * Retrieve the absolute path of the launcher directory synchronously.
 */
exports.getLauncherDirectorySync = function () {
    if (isRenderer) {
        return /** @type {any} */ (window).HeliosAPI.launcher.dataDirectory
    }
    const { app } = require('electron')
    return pathutil.resolveDataPathSync(app)
}

/**
 * REST Fetch utility with timeout.
 * 
 * @param {string} url 
 * @param {Object} options 
 * @param {number} timeout 
 * @returns {Promise<Response>}
 */
exports.fetchWithTimeout = function (url, options, timeout) {
    let timeoutId
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('timeout')), timeout)
        if (timeoutId.unref) timeoutId.unref()
    })

    return Promise.race([
        fetch(url, options).finally(() => clearTimeout(timeoutId)),
        timeoutPromise
    ])
}


/**
 * Get the common directory.
 */
exports.getCommonDirectory = async function () {
    return path.join(await exports.getLauncherDirectory(), 'common')
}

exports.getCommonDirectorySync = function () {
    return path.join(exports.getLauncherDirectorySync(), 'common')
}

/**
 * Get the instances directory.
 */
exports.getInstanceDirectory = async function () {
    return path.join(await exports.getLauncherDirectory(), 'instances')
}

exports.getInstanceDirectorySync = function () {
    return path.join(exports.getLauncherDirectorySync(), 'instances')
}

/**
 * Get the launcher's data directory.
 */
exports.getDataDirectory = function (def = false) {
    if (!config || !config.settings) return DEFAULT_CONFIG.settings.launcher.dataDirectory
    const val = config.settings.launcher.dataDirectory
    if (!def && (!val || val === '')) {
        return exports.getLauncherDirectorySync()
    }
    return !def ? val : DEFAULT_CONFIG.settings.launcher.dataDirectory
}

/**
 * Load the configuration.
 */
exports.load = async function () {

    if (isRenderer) {
        try {
            console.log('[ConfigManager] Loading config from Main (with 10s timeout)...')
            const loadPromise = /** @type {any} */ (window).HeliosAPI.ipc.invoke('config:load')
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Config load timed out')), 10000)
            )
            const res = await Promise.race([loadPromise, timeoutPromise])
            if (res) {
                config = res
                firstLaunch = !!res.firstLaunch
                delete config.firstLaunch
            } else {
                config = DEFAULT_CONFIG
            }
            logger.info('Configuration successfully proxied from Main Process (First launch: ' + firstLaunch + ')')
            return
        } catch (err) {
            logger.error('Failed to proxy configuration:', err)
            config = DEFAULT_CONFIG
            return
        }
    }

    console.log('[ConfigManager] Initializing for Main Process')
    const fsSync = require('fs')
    const launcherDir = exports.getLauncherDirectorySync()

    // Clean up leftover temporary files in the launcher directory
    try {
        if (fsSync.existsSync(launcherDir)) {
            const files = fsSync.readdirSync(launcherDir)
            for (const file of files) {
                if (file.startsWith('config.json.tmp.')) {
                    try {
                        fsSync.unlinkSync(path.join(launcherDir, file))
                    } catch (err) {
                        // Ignore individual unlink errors
                    }
                }
            }
        }
    } catch (e) {
        console.error('[ConfigManager] Failed to clean up temp files:', e)
    }

    configPath = path.join(launcherDir, 'config.json')
    console.log('[ConfigManager] Target config path: ' + configPath)
    configPathLEGACY = path.join(require('electron').app.getPath('userData'), 'config.json')

    console.log('[ConfigManager] Checking existence of config...')
    const configExists = fsSync.existsSync(configPath)
    if (!configExists) {
        console.log('[ConfigManager] Config not found, ensuring directory...')
        await fs.mkdir(path.dirname(configPath), { recursive: true })
        if (fsSync.existsSync(configPathLEGACY)) {
            console.log('[ConfigManager] Migrating legacy config...')
            const { move } = require('./util')
            await move(configPathLEGACY, configPath)
        } else {
            console.log('[ConfigManager] Creating default config...')
            DEFAULT_CONFIG.settings.launcher.dataDirectory = await exports.getLauncherDirectory()
            config = DEFAULT_CONFIG
            firstLaunch = true
            await exports.save()
            return
        }
    }

    try {
        const { safeReadJson } = require('./util')
        console.log('[ConfigManager] Reading config via safeReadJson...')
        config = await safeReadJson(configPath)

        // Ensure structure
        if (!config.settings) {
            console.log('[ConfigManager] Restoring missing settings structure...')
            config.settings = JSON.parse(JSON.stringify(DEFAULT_CONFIG.settings))
        }
        if (!config.settings.launcher) {
            config.settings.launcher = JSON.parse(JSON.stringify(DEFAULT_CONFIG.settings.launcher))
        }
        if (!config.settings.deliveryOptimization) {
            config.settings.deliveryOptimization = JSON.parse(JSON.stringify(DEFAULT_CONFIG.settings.deliveryOptimization))
        }
        if (!config.settings.launcher.dataDirectory) {
            config.settings.launcher.dataDirectory = await exports.getLauncherDirectory()
        }
        if (!config.authenticationDatabase) config.authenticationDatabase = {}

        // Decrypt (Only in Main)
        if (config.authenticationDatabase) {
            console.log('[ConfigManager] Decrypting auth database...')
            for (const uuid in config.authenticationDatabase) {
                const acc = config.authenticationDatabase[uuid]
                if (acc.accessToken) acc.accessToken = SecurityUtils.decryptString(acc.accessToken)
            }
        }

        config = validateKeySet(DEFAULT_CONFIG, config)

        // Smart RAM distribution logic
        // If maxRAM is default or not set, try to allocate 3GB, but within 70% and 12GB limits.
        if (!config.javaConfig.maxRAM || config.javaConfig.maxRAM === DEFAULT_CONFIG.javaConfig.maxRAM) {
            const absoluteMax = exports.getAbsoluteMaxRAM()
            const smartRAM = Math.min(3, absoluteMax)
            config.javaConfig.maxRAM = smartRAM + 'G'
            // Ensure minRAM is not higher
            const currentMin = parseInt(config.javaConfig.minRAM)
            if (currentMin > smartRAM) {
                config.javaConfig.minRAM = Math.max(1, Math.floor(smartRAM / 2)) + 'G'
            }
        }

        console.log('[ConfigManager] Config validation complete. Saving...')
        await exports.save()
    } catch (err) {
        console.error('[ConfigManager] Load Error:', err)
        config = DEFAULT_CONFIG
    }
}

let saveEnabled = true

exports.setSaveEnabled = (enabled) => {
    saveEnabled = enabled
}

/**
 * Save the configuration.
 */
exports.save = async function () {
    if (!saveEnabled) return
    if (isRenderer) {
        await /** @type {any} */ (window).HeliosAPI.ipc.invoke('config:save', config)
        return
    }

    if (!config) return

    const configToSave = JSON.parse(JSON.stringify(config))
    if (configToSave.authenticationDatabase) {
        for (const uuid in configToSave.authenticationDatabase) {
            const acc = configToSave.authenticationDatabase[uuid]
            if (acc.accessToken) acc.accessToken = SecurityUtils.encryptString(acc.accessToken)
        }
    }

    const { safeWriteJson } = require('./util')
    try {
        await safeWriteJson(configPath, configToSave)
    } catch (err) {
        if (err.code === 'ENOSPC') {
            console.error('[ConfigManager] Disk full! Cannot save configuration.')
            if (!isRenderer) {
                try {
                    const { dialog } = require('electron')
                    dialog.showErrorBox(
                        'Недостаточно места на диске',
                        'Не удалось сохранить файлы лаунчера, так как на твоём диске закончилось свободное место. Пожалуйста, освободи пространство и попробуй снова.'
                    )
                } catch (e) { /* ignore dialog errors during shutdown */ }
            }
        }
        throw err
    }
}

function validateKeySet(srcObj, destObj) {
    if (srcObj == null) srcObj = {}
    const keys = Object.keys(srcObj)
    for (const key of keys) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
        if (typeof destObj[key] === 'undefined') {
            destObj[key] = srcObj[key]
        } else if (typeof srcObj[key] === 'object' && srcObj[key] != null && !Array.isArray(srcObj[key])) {
            if (typeof destObj[key] !== 'object' || destObj[key] == null || Array.isArray(destObj[key])) {
                destObj[key] = {}
            }
            destObj[key] = validateKeySet(srcObj[key], destObj[key])
        }
    }
    return destObj
}

// Getters with safe navigation
exports.getSettings = () => config?.settings || DEFAULT_CONFIG.settings
exports.getSelectedServer = () => config?.selectedServer || DEFAULT_CONFIG.selectedServer
exports.getAuthAccounts = () => config?.authenticationDatabase || {}
exports.getSelectedAccount = () => {
    const selected = config?.selectedAccount
    return selected ? config?.authenticationDatabase?.[selected] || null : null
}
exports.getAuthAccount = (uuid) => config?.authenticationDatabase?.[uuid] || null

exports.removeAuthAccount = (uuid) => {
    if (!config || !config.authenticationDatabase) return
    delete config.authenticationDatabase[uuid]
    if (config.selectedAccount === uuid) {
        config.selectedAccount = Object.keys(config.authenticationDatabase)[0] || null
    }
}

exports.addMojangAuthAccount = function (uuid, accessToken, username, displayName) {
    if (!config) return
    if (!config.authenticationDatabase) config.authenticationDatabase = {}
    config.authenticationDatabase[uuid] = {
        type: 'mojang',
        accessToken,
        username,
        uuid,
        displayName
    }
    config.selectedAccount = uuid
    return config.authenticationDatabase[uuid]
}

exports.addMicrosoftAuthAccount = function (uuid, accessToken, name, expiresAt, msToken, msRefresh, msExpiresAt) {
    if (!config) return
    if (!config.authenticationDatabase) config.authenticationDatabase = {}
    config.authenticationDatabase[uuid] = {
        type: 'microsoft',
        accessToken,
        username: name,
        uuid,
        displayName: name,
        expiresAt,
        microsoft: {
            access_token: msToken,
            refresh_token: msRefresh,
            expires_at: msExpiresAt
        }
    }
    config.selectedAccount = uuid
    return config.authenticationDatabase[uuid]
}

exports.updateMicrosoftAuthAccount = function (uuid, accessToken, msToken, msRefresh, msExpiresAt, mcExpiresAt) {
    if (!config || !config.authenticationDatabase || !config.authenticationDatabase[uuid]) return
    const acc = config.authenticationDatabase[uuid]
    acc.accessToken = accessToken
    acc.expiresAt = mcExpiresAt
    acc.microsoft.access_token = msToken
    acc.microsoft.refresh_token = msRefresh
    acc.microsoft.expires_at = msExpiresAt
}
exports.getModConfigurations = () => config?.modConfigurations || {}
exports.getClientToken = () => config?.clientToken || null
exports.getJavaConfig = () => config?.javaConfig || DEFAULT_CONFIG.javaConfig

exports.getMinRAM = (id, def = false) => {
    const cfg = config?.javaConfig?.[id]
    if (cfg && cfg.minRAM) return !def ? cfg.minRAM : DEFAULT_CONFIG.javaConfig.minRAM
    return (!def ? config?.javaConfig?.minRAM : DEFAULT_CONFIG.javaConfig.minRAM) || DEFAULT_CONFIG.javaConfig.minRAM
}

exports.getMaxRAM = (id, def = false) => {
    const cfg = config?.javaConfig?.[id]
    if (cfg && cfg.maxRAM) return !def ? cfg.maxRAM : DEFAULT_CONFIG.javaConfig.maxRAM
    return (!def ? config?.javaConfig?.maxRAM : DEFAULT_CONFIG.javaConfig.maxRAM) || DEFAULT_CONFIG.javaConfig.maxRAM
}

exports.getJVMOptions = (id, def = false) => {
    if (!config || !config.javaConfig) return []
    const cfg = config.javaConfig[id]
    if (cfg && Array.isArray(cfg.opts)) return cfg.opts
    return []
}

exports.getJavaExecutable = (id) => {
    if (!config || !config.javaConfig) return null
    const cfg = config.javaConfig[id]
    return cfg?.javaExecutable || null
}

exports.setJavaExecutable = (id, val) => {
    if (!config) return
    if (!config.javaConfig) config.javaConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG.javaConfig))
    if (!config.javaConfig[id]) {
        config.javaConfig[id] = {}
    }
    config.javaConfig[id].javaExecutable = val
}

// Restored getters for Delivery/P2P
exports.getLocalOptimization = () => config?.settings?.deliveryOptimization?.localOptimization || false
exports.getGlobalOptimization = () => config?.settings?.deliveryOptimization?.globalOptimization || false
exports.getP2PUploadEnabled = () => config?.settings?.deliveryOptimization?.p2pUploadEnabled || false
exports.getP2PUploadLimit = () => config?.settings?.deliveryOptimization?.p2pUploadLimit || 5
exports.getP2POnlyMode = () => config?.settings?.deliveryOptimization?.p2pOnlyMode || false
exports.getNoMojang = () => config?.settings?.deliveryOptimization?.noMojang || false
exports.getNoServers = () => config?.settings?.deliveryOptimization?.noServers || false
exports.getAllowPrerelease = () => config?.settings?.launcher?.allowPrerelease || false
exports.getSupportUrl = () => config?.supportUrl || DEFAULT_CONFIG.supportUrl
exports.getP2PPromptShown = () => config?.settings?.p2pPromptShown || false
exports.getBackgroundVideoPaused = () => config?.settings?.launcher?.backgroundVideoPaused || false
exports.getBackgroundVideoInitialized = () => config?.settings?.launcher?.backgroundVideoInitialized || false

exports.getModConfiguration = (id) => {
    if (!config || !config.modConfigurations) return { mods: {} }
    return config.modConfigurations[id] || { mods: {} }
}

exports.setModConfiguration = (id, modConf) => {
    if (!config) return
    if (!config.modConfigurations) config.modConfigurations = {}
    config.modConfigurations[id] = modConf
}

exports.getAbsoluteMaxRAM = (serverMax) => {
    const totalMemBytes = os.totalmem()
    const totalMemGb = Math.floor(totalMemBytes / 1024 / 1024 / 1024)

    // Rule: Not more than 70% of total RAM
    let limitGb = Math.floor(totalMemGb * 0.7)

    // Rule: Hard cap of 12 GB
    limitGb = Math.min(limitGb, 12)

    // Safety minimum for the slider
    limitGb = Math.max(limitGb, 1)

    if (serverMax && !isNaN(serverMax)) {
        const serverMaxGb = Math.ceil(Number(serverMax) / 1024)
        return Math.min(limitGb, serverMaxGb)
    }
    return limitGb
}

exports.getAbsoluteMinRAM = (serverMin) => {
    if (serverMin && !isNaN(serverMin)) {
        const serverMinGb = Math.ceil(Number(serverMin) / 1024)
        return Math.max(1, serverMinGb)
    }
    return 1
}

exports.isFirstLaunch = () => firstLaunch

exports.getGameWidth = (def = false) => {
    return (!def ? config?.settings?.game?.resWidth : DEFAULT_CONFIG.settings.game.resWidth) || DEFAULT_CONFIG.settings.game.resWidth
}

exports.getGameHeight = (def = false) => {
    return (!def ? config?.settings?.game?.resHeight : DEFAULT_CONFIG.settings.game.resHeight) || DEFAULT_CONFIG.settings.game.resHeight
}

exports.getFullscreen = (def = false) => {
    if (!config || !config.settings) return DEFAULT_CONFIG.settings.game.fullscreen
    return !def ? config.settings.game.fullscreen : DEFAULT_CONFIG.settings.game.fullscreen
}



exports.getLaunchDetached = (def = false) => {
    if (!config || !config.settings) return DEFAULT_CONFIG.settings.game.launchDetached
    return !def ? config.settings.game.launchDetached : DEFAULT_CONFIG.settings.game.launchDetached
}

exports.getTempNativeFolder = () => 'natives'

// Setters
exports.setSelectedServer = (id) => { 
    if (config) {
        console.log(`[ConfigManager] Setting selectedServer from ${config.selectedServer} to ${id}`)
        config.selectedServer = id 
    } else {
        console.warn('[ConfigManager] Cannot set selectedServer: config is null!')
    }
}
exports.setSelectedAccount = (uuid) => { if (config) config.selectedAccount = uuid }
exports.setClientToken = (token) => { if (config) config.clientToken = token }
exports.setModConfigurations = (configs) => { if (config) config.modConfigurations = configs }
exports.setLocalOptimization = (val) => { if (config) { if (!config.settings.deliveryOptimization) config.settings.deliveryOptimization = {}; config.settings.deliveryOptimization.localOptimization = val } }
exports.setGlobalOptimization = (val) => { if (config) { if (!config.settings.deliveryOptimization) config.settings.deliveryOptimization = {}; config.settings.deliveryOptimization.globalOptimization = val } }
exports.setP2PUploadEnabled = (val) => { if (config) { if (!config.settings.deliveryOptimization) config.settings.deliveryOptimization = {}; config.settings.deliveryOptimization.p2pUploadEnabled = val } }
exports.setP2POnlyMode = (val) => { if (config) { if (!config.settings.deliveryOptimization) config.settings.deliveryOptimization = {}; config.settings.deliveryOptimization.p2pOnlyMode = val } }
exports.setNoMojang = (val) => { if(config) { if(!config.settings.deliveryOptimization) config.settings.deliveryOptimization = {}; config.settings.deliveryOptimization.noMojang = val } }
exports.setNoServers = (val) => { if(config) { if(!config.settings.deliveryOptimization) config.settings.deliveryOptimization = {}; config.settings.deliveryOptimization.noServers = val } }
exports.setP2PPromptShown = (val) => { if(config) config.settings.p2pPromptShown = val }
exports.setBackgroundVideoPaused = (val) => { if(config) { if(!config.settings.launcher) config.settings.launcher = {}; config.settings.launcher.backgroundVideoPaused = val } }
exports.setBackgroundVideoInitialized = (val) => { if(config) { if(!config.settings.launcher) config.settings.launcher = {}; config.settings.launcher.backgroundVideoInitialized = val } }
exports.setGameWidth = (val) => { if (config) config.settings.game.resWidth = Number(val) }
exports.setGameHeight = (val) => { if (config) config.settings.game.resHeight = Number(val) }
exports.setFullscreen = (val) => { if (config) config.settings.game.fullscreen = val }

exports.setLaunchDetached = (val) => { if (config) config.settings.game.launchDetached = val }
exports.setAllowPrerelease = (val) => { if (config) config.settings.launcher.allowPrerelease = val }
exports.setJVMOptions = (id, val) => {
    if (!config) return
    if (!config.javaConfig) config.javaConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG.javaConfig))
    if (!config.javaConfig[id]) config.javaConfig[id] = {}
    config.javaConfig[id].opts = val
}
exports.setDataDirectory = (val) => { if (config) config.settings.launcher.dataDirectory = val }
exports.setConfig = (newConfig) => { config = newConfig }

exports.ensureJavaConfig = (id, opts, ram) => {
    if (!config) return
    if (!config.javaConfig) config.javaConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG.javaConfig))
    if (!config.javaConfig[id]) {
        config.javaConfig[id] = {
            opts,
            ram
        }
    }
}

exports.setMinRAM = (id, val) => {
    if (!config) return
    if (!config.javaConfig) config.javaConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG.javaConfig))
    if (config.javaConfig[id]) {
        config.javaConfig[id].minRAM = val
    } else {
        config.javaConfig.minRAM = val
    }
}

exports.setMaxRAM = (id, val) => {
    if (!config) return
    if (!config.javaConfig) config.javaConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG.javaConfig))
    if (config.javaConfig[id]) {
        config.javaConfig[id].maxRAM = val
    } else {
        config.javaConfig.maxRAM = val
    }
}

exports.markFirstLaunchCompleted = () => {
    firstLaunch = false
}

/**
 * @returns {boolean} Whether or not the manager has been loaded.
 */
exports.isLoaded = function () {
    return config != null
}

exports.getConfig = function () {
    return {
        ...config,
        firstLaunch
    }
}

exports.setConfig = function (newConfig) {
    config = newConfig
}

exports.isSaveEnabled = () => saveEnabled

exports.getSupportUrl = () => config?.supportUrl || DEFAULT_CONFIG.supportUrl
exports.setSupportUrl = (url) => {
    if (config) config.supportUrl = url
}

exports.getLastLauncherVersion = () => { if (config) return config.lastLauncherVersion; return null }
exports.setLastLauncherVersion = (version) => { if (config) config.lastLauncherVersion = version }

/**
 * Check if the user has accepted the mandatory agreement.
 * 
 * @returns {Promise<boolean>} True if accepted, false otherwise.
 */
exports.hasAcceptedAgreement = async function () {
    const launcherDir = await exports.getLauncherDirectory()
    const agreementPath = path.join(launcherDir, 'agreement.json')
    try {
        await fs.access(agreementPath)
        return true
    } catch (e) {
        return false
    }
}

/**
 * Accept the mandatory agreement and record the event.
 */
exports.acceptAgreement = async function () {
    const launcherDir = await exports.getLauncherDirectory()
    const agreementPath = path.join(launcherDir, 'agreement.json')
    const now = new Date()
    
    const agreementData = {
        acceptedAt: now.toISOString(),
        timestamp: now.getTime(),
        version: exports.getLastLauncherVersion() || 'unknown',
        platform: os.platform(),
        arch: os.arch(),
        accepted: true
    }
    
    await fs.writeFile(agreementPath, JSON.stringify(agreementData, null, 4))
    logger.info('Mandatory agreement accepted and recorded.')
}

/**
 * Check if the user has accepted the NEW P2P legal agreement.
 * 
 * @returns {boolean} True if accepted.
 */
exports.hasAcceptedP2PLegalAgreement = function () {
    if (!config) return false
    return config.settings?.p2pLegalAgreementAccepted || false
}

/**
 * Accept the NEW P2P legal agreement.
 */
exports.acceptP2PLegalAgreement = function () {
    if (!config) return
    if (!config.settings) config.settings = {}
    config.settings.p2pLegalAgreementAccepted = true
    exports.setP2PPromptShown(true) // Also mark the old one as shown to prevent popups
}
