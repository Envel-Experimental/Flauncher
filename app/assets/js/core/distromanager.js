/**
 * Service for managing the distribution index and remote distribution sources.
 * It provides a wrapper around the DistributionAPI with automatic retries and 
 * signature validation handling.
 * 
 * @module DistroManager
 */

const { DistributionAPI } = require('./common/DistributionAPI')
const { retry } = require('./util')
const ConfigManager = require('./configmanager')

/**
 * The default remote distribution index URL.
 * @type {string}
 */
exports.REMOTE_DISTRO_URL = 'https://f-launcher.ru/fox/new/distribution.json'

const { MOJANG_MIRRORS, DISTRO_PUB_KEYS } = require('../../../../network/config')
const Lang = require('./langloader')

/**
 * List of distribution sources to check.
 * @type {string[]}
 */
const distributionSources = [exports.REMOTE_DISTRO_URL]
if (MOJANG_MIRRORS && Array.isArray(MOJANG_MIRRORS)) {
    MOJANG_MIRRORS.forEach(mirror => {
        if (mirror.distribution) {
            distributionSources.push(mirror.distribution)
        }
    })
}

/**
 * Singleton instance of the DistributionAPI.
 * @type {DistributionAPI|null}
 */
let api = null

/**
 * Interceptor for the DistributionAPI.pullRemote method.
 * Handles signature validation failures by showing a user overlay.
 * 
 * @this {DistributionAPI}
 * @returns {Promise<Object>} The distribution data.
 * @private
 */
async function pullRemoteInterceptor() {
    const originalPullRemote = DistributionAPI.prototype.pullRemote.bind(this)
    let result
    try {
        result = await originalPullRemote()
    } catch (err) {
        if (err.dataPackage && err.dataPackage.signatureValid === false) {
            console.log('[DistroManager] Signature INVALID! Triggering overlay.')
            result = err.dataPackage
        } else {
            throw err
        }
    }

    if (result.data != null && result.signatureValid === false) {
        return new Promise((resolve) => {
            const showSigError = () => {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', showSigError, { once: true })
                    return
                }
                const btnAck = document.getElementById('overlayAcknowledge')
                const btnAckMid = document.getElementById('overlayAcknowledgeMid')
                
                const originalColor = btnAck.style.backgroundColor
                btnAck.style.backgroundColor = '#28a745'

                const originalColorMid = btnAckMid.style.backgroundColor
                const originalBorderMid = btnAckMid.style.border
                const originalBoxShadowMid = btnAckMid.style.boxShadow
                btnAckMid.style.backgroundColor = 'transparent'
                btnAckMid.style.border = '1px solid #dc3545'
                btnAckMid.style.boxShadow = 'none'

                const resetUI = () => {
                    btnAck.style.backgroundColor = originalColor
                    btnAckMid.style.backgroundColor = originalColorMid
                    btnAckMid.style.border = originalBorderMid
                    btnAckMid.style.boxShadow = originalBoxShadowMid
                    toggleOverlay(false)
                }

                setOverlayContent(
                    Lang.queryJS('distro.verification.title'),
                    Lang.queryJS('distro.verification.desc'),
                    Lang.queryJS('distro.verification.retry'),
                    Lang.queryJS('distro.verification.proceed'),
                    Lang.queryJS('distro.verification.close')
                )

                setOverlayHandler(async () => {
                    resetUI()
                    setTimeout(async () => {
                        try {
                            resolve(await this.pullRemote())
                        } catch (e) {
                            resolve(await this.pullRemote())
                        }
                    }, 500)
                })

                setMiddleButtonHandler(async () => {
                    resetUI()
                    const localData = await this.pullLocal()
                    if (localData != null) {
                        resolve({
                            data: localData,
                            responseStatus: 0, // Success
                            signatureValid: true
                        })
                    } else {
                        // If no local data, we have to retry
                        setTimeout(async () => {
                            resolve(await this.pullRemote())
                        }, 500)
                    }
                })

                setDismissHandler(() => {
                    HeliosAPI.window.close()
                })

                toggleOverlay(true, true)
            }
            showSigError()
        })
    }

    this._remoteFailed = (result.data == null)
    return result
}

/**
 * Wrapper for DistributionAPI.getDistribution with automatic retry logic.
 * 
 * @this {DistributionAPI}
 * @returns {Promise<Object|null>} The distribution index or null if all retries failed.
 * @private
 */
async function getDistributionRetry() {
    const MAX_DOWNLOAD_RETRIES = 3
    const DOWNLOAD_RETRY_DELAY = 1000

    const realGetDistribution = DistributionAPI.prototype.getDistribution.bind(this)
    return await retry(
        realGetDistribution,
        MAX_DOWNLOAD_RETRIES,
        DOWNLOAD_RETRY_DELAY,
        // Retry on network/transient errors, but not on security violations
        (err) => !err.message?.includes('replay') && !err.message?.includes('signature')
    ).catch((err) => {
        console.error('Failed to download distribution index after multiple retries.', err)
        return null
    })
}

/**
 * Initialize the DistributionManager.
 * Creates and configures the DistributionAPI instance.
 * 
 * @returns {Promise<DistributionAPI>} The initialized API instance.
 */
exports.init = async function() {
    if (api) return api
    const launcherDir = await ConfigManager.getLauncherDirectory()
    const commonDir = await ConfigManager.getCommonDirectory()
    const instanceDir = await ConfigManager.getInstanceDirectory()
    const env = (typeof window !== 'undefined' && window.HeliosAPI) ? window.HeliosAPI.system.getEnv() : process.env
    const devMode = env.HELIOS_DEV_MODE === 'true' || false
    console.log('[DistroManager] HELIOS_DEV_MODE:', env.HELIOS_DEV_MODE, '-> devMode:', devMode)
    api = new DistributionAPI(
        launcherDir,
        commonDir,
        instanceDir,
        distributionSources,
        devMode,
        DISTRO_PUB_KEYS
    )

    if (process.type === 'renderer') {
        api.pullRemote = pullRemoteInterceptor.bind(api)
        api.getDistribution = getDistributionRetry.bind(api)
    }
    
    // Legacy Global Exposure
    if (typeof window !== 'undefined') {
        window.DistroAPI = api
    }

    /** @type {DistributionAPI} */
    exports.DistroAPI = api
    return api
}

/**
 * Get the current distribution index.
 * 
 * @returns {Promise<Object|null>} The distribution index.
 */
exports.getDistribution = async function() {
    const instance = await exports.init()
    return await instance.getDistribution()
}

/**
 * Refresh the distribution index or return the cached fallback.
 * 
 * @returns {Promise<Object|null>} The distribution index.
 */
exports.refreshDistributionOrFallback = async function() {
    const instance = await exports.init()
    return await instance.refreshDistributionOrFallback()
}

/**
 * Toggle developer mode for the distribution manager.
 * 
 * @param {boolean} dev Whether or not developer mode is enabled.
 */
exports.toggleDevMode = async function(dev) {
    const instance = await exports.init()
    instance.toggleDevMode(dev)
}
