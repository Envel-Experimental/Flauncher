/**
 * Initialize UI functions which depend on internal modules.
 * Loaded after core UI functions are initialized in uicore.js.
 */
// Requirements
const { Type } = require('@core/common/DistributionClasses')

const AuthManager = require('@core/authmanager')
const ConfigManager = require('@core/configmanager')
const DistroManager = require('@core/distromanager')

console.log('[UIBinder] Module Loading...')


export let rscShouldLoad = false
export let fatalStartupError = false

// Mapping of each view to their container IDs.
export const VIEWS = {
    landing: '#landingContainer',
    loginOptions: '#loginContainer',
    login: '#loginContainer',
    settings: '#settingsContainer',
    welcome: '#welcomeContainer',
    waiting: '#waitingContainer',
    agreement: '#agreementContainer',
    p2pAgreement: '#p2pAgreementContainer'
}

// The currently shown view container.
export let currentView

// Shared view-control variables (must be global for cross-module access)
window.loginViewOnSuccess = VIEWS.landing
window.loginViewOnCancel = VIEWS.settings
window.loginViewCancelHandler = null

window.loginOptionsViewOnLoginSuccess = VIEWS.landing
window.loginOptionsViewOnLoginCancel = VIEWS.loginOptions
window.loginOptionsViewOnCancel = VIEWS.landing
window.loginOptionsViewCancelHandler = null

// Legacy Global Exposure
window.VIEWS = VIEWS
window.switchView = switchView
window.getCurrentView = () => currentView
window.fatalStartupError = fatalStartupError
window.updateSelectedServer = updateSelectedServer
// window.prepareSettings is handled in settings.js
// Note: currentView update is handled in switchView function below

/**
 * Switch launcher views.
 *
 * @param {string} current The ID of the current view container.
 * @param {*} next The ID of the next view container.
 * @param {*} currentFadeTime Optional. The fade out time for the current view.
 * @param {*} nextFadeTime Optional. The fade in time for the next view.
 * @param {*} onCurrentFade Optional. Callback function to execute when the current
 * view fades out.
 * @param {*} onNextFade Optional. Callback function to execute when the next view
 * fades in.
 */
export function switchView(current, next, currentFadeTime = 500, nextFadeTime = 500, onCurrentFade = () => { }, onNextFade = () => { }) {
    console.log(`[UIBinder] Switching view: ${current} -> ${next}`)
    currentView = next

    // Pause video when entering settings to save resources, resume when returning to landing
    const vid = document.getElementById('background-video')
    if (next === VIEWS.settings) {
        if (vid) vid.pause()
    } else if (next === VIEWS.landing) {
        if (vid && !ConfigManager.getBackgroundVideoPaused()) {
            vid.play().catch(() => {})
        }
    }

    fadeOut(document.querySelector(current), currentFadeTime, async () => {
        try {
            await onCurrentFade()
        } catch (err) {
            console.error(`[UIBinder] Error in onCurrentFade for ${next}:`, err)
        }
        
        fadeIn(document.querySelector(next), nextFadeTime, async () => {
            try {
                await onNextFade()
            } catch (err) {
                console.error(`[UIBinder] Error in onNextFade for ${next}:`, err)
            }
        })
    })
}

/**
 * Get the currently shown view container.
 *
 * @returns {string} The currently shown view container.
 */
export function getCurrentView() {
    return currentView
}

/**
 * Enable or disable the launch button.
 *
 * @param {boolean} val True to enable, false to disable.
 */
export function setLaunchEnabled(val) {
    document.getElementById('launch_button').disabled = !val
}

/**
 * Bind selected server
 */
export async function updateSelectedServer(serv) {
    const requestedId = serv != null ? serv.rawServer.id : 'null'
    console.log(`[UIBinder] updateSelectedServer: requested server: ${requestedId}`)
    
    if (getCurrentView() === VIEWS.settings) {
        console.log('[UIBinder] updateSelectedServer: saving settings before switch...')
        await fullSettingsSave()
    }
    
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    const savedServer = ConfigManager.getSelectedServer()
    console.log(`[UIBinder] updateSelectedServer: ConfigManager state updated to: ${savedServer}`)
    
    await ConfigManager.save()
    console.log('[UIBinder] updateSelectedServer: Config saved to disk.')
    
    const serverSelectionBtn = document.getElementById('server_selection_button')
    if (serverSelectionBtn) {
        serverSelectionBtn.innerHTML = (serv != null ? serv.rawServer.name : Lang.queryJS('landing.noSelection'))
    }
    
    if (getCurrentView() === VIEWS.settings) {
        animateSettingsTabRefresh()
    }
    setLaunchEnabled(serv != null)

    window.dispatchEvent(new CustomEvent('server-changed', { detail: serv != null ? serv.rawServer.id : null }));
}

/**
 * Bind selected account
 */
export function updateSelectedAccount(authUser) {
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    if (authUser != null) {
        if (authUser.displayName != null) {
            username = authUser.displayName
        }
        if (authUser.uuid != null) {
            const avatarContainer = document.getElementById('avatarContainer')
            if (avatarContainer) {
                const { getCachedAvatar } = require('../core/util/AvatarCache')
                const isOffline = authUser.accessToken === 'offline-access-token'
                const identifier = (isOffline || !authUser.uuid) 
                    ? (authUser.displayName || authUser.username || authUser.uuid) 
                    : authUser.uuid
                
                const cachedUrl = getCachedAvatar(identifier, 'body', (newUrl) => {
                    avatarContainer.style.backgroundImage = `url('${newUrl}')`
                })
                avatarContainer.style.backgroundImage = `url('${cachedUrl}')`
            }
        }
    }
    const userText = document.getElementById('user_text')
    if (userText) userText.innerHTML = username

    // Notify React components
    window.dispatchEvent(new CustomEvent('account-changed', { detail: authUser }));
}

export async function showMainUI(data) {
    const _isDev = window.isDev || (typeof isDev !== 'undefined' ? isDev : false)
    if (!_isDev) {
        if (window.loggerAutoUpdater) {
            window.loggerAutoUpdater.info('Initializing..')
        }
        ipcRenderer.send('autoUpdateAction', 'initAutoUpdater', ConfigManager.getAllowPrerelease())
    }



    // 1. Initial Server Selection (MUST be before prepareSettings)
    let selectedServ = data.getServerById(ConfigManager.getSelectedServer())
    if (selectedServ == null) {
        selectedServ = data.getMainServer()
        if (selectedServ) {
            console.log('[UIBinder] Auto-selecting main server:', selectedServ.rawServer.id)
            ConfigManager.setSelectedServer(selectedServ.rawServer.id)
            await ConfigManager.save()
        }
    }

    console.log('[UIBinder] Preparing settings...')
    await prepareSettings(true)
    console.log('[UIBinder] Settings prepared.')
    
    let selectedAcc = ConfigManager.getSelectedAccount()
    if (selectedAcc == null) {
        const accounts = ConfigManager.getAuthAccounts()
        const keys = Object.keys(accounts)
        if (keys.length > 0) {
            ConfigManager.setSelectedAccount(keys[0])
            selectedAcc = ConfigManager.getSelectedAccount()
            await ConfigManager.save()
        }
    }
    console.log('[UIBinder] Updating selected account to:', selectedAcc?.displayName)
    updateSelectedAccount(selectedAcc)

    console.log('[UIBinder] Updating selected server to:', selectedServ?.rawServer?.id)
    await updateSelectedServer(selectedServ)

    if (data.rawDistribution.supportUrl) {
        ConfigManager.setSupportUrl(data.rawDistribution.supportUrl)
    }
    setTimeout(async () => {
        // Stop loading monitors because we are now transitioning to the main UI/Agreements
        window._loadingMonitorPaused = true
        if (window._loadingTimer) {
            clearTimeout(window._loadingTimer)
            window._loadingTimer = null
        }
        if (window._failsafeTimer) {
            clearTimeout(window._failsafeTimer)
            window._failsafeTimer = null
        }
        const loadingStatusText = document.getElementById('loadingStatusText')
        if (loadingStatusText) loadingStatusText.style.display = 'none'

        initBackgroundVideo()
        console.log('[UIBinder] Showing main container...')
        document.body.classList.add('main-ui-active')
        const fallbackImg = document.getElementById('background-fallback-img')
        if (fallbackImg) {
            fallbackImg.style.display = 'block'
            fallbackImg.style.opacity = '1'
        }
        document.getElementById('frameBar').style.backgroundColor = 'transparent'
        show(document.getElementById('main'))
        console.log('[UIBinder] Main container visibility set to show.')
        
        // Ensure launch area is shown (not in loading state)
        if (typeof window.toggleLaunchArea === 'function') {
            window.toggleLaunchArea(false)
        }

        const isLoggedIn = Object.keys(ConfigManager.getAuthAccounts()).length > 0
        const hasAcceptedAgreement = await ConfigManager.hasAcceptedAgreement()

        if (!hasAcceptedAgreement) {
            console.log('[UIBinder] Mandatory agreement not accepted. Showing agreement view.')
            currentView = VIEWS.agreement
            const agreementEl = document.querySelector(VIEWS.agreement)
            if (agreementEl) show(agreementEl)
        } else if (!ConfigManager.hasAcceptedP2PLegalAgreement()) {
            console.log('[UIBinder] P2P legal agreement not accepted. Showing P2P agreement view.')
            currentView = VIEWS.p2pAgreement
            const p2pAgreementEl = document.querySelector(VIEWS.p2pAgreement)
            if (p2pAgreementEl) show(p2pAgreementEl)
        } else {
            await finishOnboarding()
        }

        setTimeout(() => {
            fadeOut(document.getElementById('loadingContainer'), 500, () => {
                const spinner = document.getElementById('loadSpinnerImage')
                if (spinner) {
                    spinner.classList.remove('rotating')
                }
            })
        }, 250)

    }, 750)
}

/**
 * Finalize onboarding and transition to login or landing.
 */
export async function finishOnboarding() {
    const isLoggedIn = Object.keys(ConfigManager.getAuthAccounts()).length > 0
    const isDev = process.env.NODE_ENV === 'development'

    // If this is enabled in a development environment we'll get ratelimited.
    // The relaunch frequency is usually far too high.
    if (!isDev && isLoggedIn) {
        validateSelectedAccount()
    }

    if (isLoggedIn) {
        const nextView = VIEWS.landing
        if (currentView) {
            switchView(currentView, nextView)
        } else {
            currentView = nextView
            const el = document.querySelector(nextView)
            if (el) show(el)
        }
        
        console.log('[UIBinder] Initializing landing...')
        const distro = await DistroAPI.getDistribution()
        if (distro) {
            onDistroRefresh(distro)
        }
        toggleLaunchArea(false)
    } else {
        console.log('[UIBinder] No logged in accounts. Jumping directly to nickname login.')
        loginCancelEnabled(false)
        window.loginViewOnSuccess = VIEWS.landing
        window.loginViewOnCancel = VIEWS.login
        
        const nextView = VIEWS.login
        if (currentView) {
            switchView(currentView, nextView)
        } else {
            currentView = nextView
            const el = document.querySelector(nextView)
            if (el) show(el)
        }
    }
}
window.finishOnboarding = finishOnboarding

export function showFatalStartupError() {
    setTimeout(() => {
        fadeOut(document.getElementById('loadingContainer'), 250, () => {
            document.getElementById('overlayContainer').style.background = 'none'
            setOverlayContent(
                Lang.queryJS('uibinder.startup.fatalErrorTitle'),
                Lang.queryJS('uibinder.startup.fatalErrorMessage'),
                Lang.queryJS('uibinder.startup.closeButton')
            )
            setOverlayHandler(() => {
                HeliosAPI.window.close()
            })
            toggleOverlay(true)
        })
    }, 750)
}

/**
 * Common functions to perform after refreshing the distro index.
 *
 * @param {Object} data The distro index object.
 */
export async function onDistroRefresh(data) {
    if (!data) return

    const currentSelectedId = ConfigManager.getSelectedServer()
    let selectedServ = data.getServerById(currentSelectedId)
    
    if (selectedServ == null) {
        console.log(`[UIBinder] onDistroRefresh: Current server ${currentSelectedId} not found in index. Falling back to main.`)
        selectedServ = data.getMainServer()
        await updateSelectedServer(selectedServ)
    } else {
        // Just refresh the button text and status without a full config save/cycle
        console.log(`[UIBinder] onDistroRefresh: Server ${currentSelectedId} is still valid. Updating UI.`)
        const serverSelectionBtn = document.getElementById('server_selection_button')
        if (serverSelectionBtn) {
            serverSelectionBtn.innerHTML = selectedServ.rawServer.name
        }
    }
    
    await syncModConfigurations(data)
    await ensureJavaSettings(data)
}

/**
 * Sync the mod configurations with the distro index.
 *
 * @param {Object} data The distro index object.
 */
export async function syncModConfigurations(data) {

    const syncedCfgs = {}

    for (let serv of data.servers) {

        const id = serv.rawServer.id
        const mdls = serv.modules
        const cfg = ConfigManager.getModConfiguration(id)

        if (cfg != null && cfg.mods != null) {

            const modsOld = cfg.mods
            const mods = {}

            for (let mdl of mdls) {
                const type = mdl.rawModule.type

                if (type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod) {
                    if (!mdl.getRequired().value) {
                        const mdlID = mdl.getVersionlessMavenIdentifier()
                        if (modsOld[mdlID] == null) {
                            mods[mdlID] = scanOptionalSubModules(mdl.subModules, mdl)
                        } else {
                            mods[mdlID] = mergeModConfiguration(modsOld[mdlID], scanOptionalSubModules(mdl.subModules, mdl), false)
                        }
                    } else {
                        if (mdl.subModules.length > 0) {
                            const mdlID = mdl.getVersionlessMavenIdentifier()
                            const v = scanOptionalSubModules(mdl.subModules, mdl)
                            if (typeof v === 'object') {
                                if (modsOld[mdlID] == null) {
                                    mods[mdlID] = v
                                } else {
                                    mods[mdlID] = mergeModConfiguration(modsOld[mdlID], v, true)
                                }
                            }
                        }
                    }
                }
            }

            syncedCfgs[id] = {
                mods
            }

        } else {

            const mods = {}

            for (let mdl of mdls) {
                const type = mdl.rawModule.type
                if (type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod) {
                    if (!mdl.getRequired().value) {
                        mods[mdl.getVersionlessMavenIdentifier()] = scanOptionalSubModules(mdl.subModules, mdl)
                    } else {
                        if (mdl.subModules.length > 0) {
                            const v = scanOptionalSubModules(mdl.subModules, mdl)
                            if (typeof v === 'object') {
                                mods[mdl.getVersionlessMavenIdentifier()] = v
                            }
                        }
                    }
                }
            }

            syncedCfgs[id] = {
                mods
            }

        }
    }

    ConfigManager.setModConfigurations(syncedCfgs)
    await ConfigManager.save()
}

/**
 * Ensure java configurations are present for the available servers.
 *
 * @param {Object} data The distro index object.
 */
export async function ensureJavaSettings(data) {

    // Nothing too fancy for now.
    if (window.setLoadingStatus) {
        window.setLoadingStatus('js.uibinder.loading.checkingJava')
    }
    for (const serv of data.servers) {
        ConfigManager.ensureJavaConfig(serv.rawServer.id, serv.effectiveJavaOptions, serv.rawServer.javaOptions?.ram)
    }

    await ConfigManager.save()
}

/**
 * Recursively scan for optional sub modules. If none are found,
 * this function returns a boolean. If optional sub modules do exist,
 * a recursive configuration object is returned.
 *
 * @returns {boolean | Object} The resolved mod configuration.
 */
export function scanOptionalSubModules(mdls, origin) {
    if (mdls != null) {
        const mods = {}

        for (let mdl of mdls) {
            const type = mdl.rawModule.type
            // Optional types.
            if (type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod) {
                // It is optional.
                const mdlID = mdl.getVersionlessMavenIdentifier()
                const mdlName = (typeof mdl.rawModule.name === 'string' ? mdl.rawModule.name : (mdl.rawModule.name?.value || 'Unknown Mod'))
                
                if (!mdl.getRequired().value) {
                    mods[mdlID] = scanOptionalSubModules(mdl.subModules, mdl)
                } else {
                    if (mdl.hasSubModules()) {
                        const v = scanOptionalSubModules(mdl.subModules, mdl)
                        if (typeof v === 'object') {
                            mods[mdlID] = v
                        }
                    }
                }
            }
        }

        if (Object.keys(mods).length > 0) {
            const ret = {
                mods
            }
            if (!origin.getRequired().value) {
                ret.value = origin.getRequired().def
            }
            return ret
        }
    }
    return origin.getRequired().def
}

/**
 * Recursively merge an old configuration into a new configuration.
 *
 * @param {boolean | Object} o The old configuration value.
 * @param {boolean | Object} n The new configuration value.
 * @param {boolean} nReq If the new value is a required mod.
 *
 * @returns {boolean | Object} The merged configuration.
 */
export function mergeModConfiguration(o, n, nReq = false) {
    if (typeof o === 'boolean') {
        if (typeof n === 'boolean') return o
        else if (typeof n === 'object') {
            if (!nReq) {
                n.value = o
            }
            return n
        }
    } else if (typeof o === 'object') {
        if (typeof n === 'boolean') return typeof o.value !== 'undefined' ? o.value : true
        else if (typeof n === 'object') {
            if (!nReq) {
                n.value = typeof o.value !== 'undefined' ? o.value : true
            }

            const newMods = Object.keys(n.mods)
            for (let i = 0; i < newMods.length; i++) {

                const mod = newMods[i]
                if (o.mods[mod] != null) {
                    n.mods[mod] = mergeModConfiguration(o.mods[mod], n.mods[mod])
                }
            }

            return n
        }
    }
    // If for some reason we haven't been able to merge,
    // wipe the old value and use the new one. Just to be safe
    return n
}

async function validateSelectedAccount() {
    try {
        const selectedAcc = ConfigManager.getSelectedAccount()
        if (selectedAcc != null) {
            const val = await AuthManager.validateSelected()
            if (!val) {
                ConfigManager.removeAuthAccount(selectedAcc.uuid)
                await ConfigManager.save()
                const accLen = Object.keys(ConfigManager.getAuthAccounts()).length
                setOverlayContent(
                    Lang.queryJS('uibinder.validateAccount.failedMessageTitle'),
                    accLen > 0
                        ? Lang.queryJS('uibinder.validateAccount.failedMessage', { 'account': selectedAcc.displayName })
                        : Lang.queryJS('uibinder.validateAccount.failedMessageSelectAnotherAccount', { 'account': selectedAcc.displayName }),
                    Lang.queryJS('uibinder.validateAccount.loginButton'),
                    Lang.queryJS('uibinder.validateAccount.selectAnotherAccountButton')
                )
                setOverlayHandler(() => {

                    const isMicrosoft = selectedAcc.type === 'microsoft'

                    if (isMicrosoft) {
                        // Empty for now
                    } else {
                        // Mojang
                        // For convenience, pre-populate the username of the account.
                        document.getElementById('loginUsername').value = selectedAcc.username
                        validateEmail(selectedAcc.username)
                    }

                    window.loginViewOnSuccess = getCurrentView()
                    window.loginViewOnCancel = VIEWS.login

                    if (accLen > 0) {
                        window.loginViewOnCancel = getCurrentView()
                        window.loginViewCancelHandler = async () => {
                            if (isMicrosoft) {
                                ConfigManager.addMicrosoftAuthAccount(
                                    selectedAcc.uuid,
                                    selectedAcc.accessToken,
                                    selectedAcc.username,
                                    selectedAcc.expiresAt,
                                    selectedAcc.microsoft.access_token,
                                    selectedAcc.microsoft.refresh_token,
                                    selectedAcc.microsoft.expires_at
                                )
                            } else {
                                ConfigManager.addMojangAuthAccount(selectedAcc.uuid, selectedAcc.accessToken, selectedAcc.username, selectedAcc.displayName)
                            }
                            await ConfigManager.save()
                            validateSelectedAccount()
                        }
                    }
                    toggleOverlay(false)
                    switchView(getCurrentView(), VIEWS.login)
                })
                setDismissHandler(() => {
                    if (accLen > 1) {
                        prepareAccountSelectionList()
                        fadeOut(document.getElementById('overlayContent'), 250, () => {
                            bindOverlayKeys(true, 'accountSelectContent', true)
                            fadeIn(document.getElementById('accountSelectContent'), 250)
                        })
                    } else {
                        const accountsObj = ConfigManager.getAuthAccounts()
                        const accounts = Array.from(Object.keys(accountsObj), v => accountsObj[v])
                        // This function validates the account switch.
                        setSelectedAccount(accounts[0].uuid)
                        toggleOverlay(false)
                    }
                })
                toggleOverlay(true, accLen > 0)
            } else {
                return true
            }
        } else {
            return true
        }
    } catch (error) {
        console.error('[UIBinder] Failed to validate selected account:', error)
        // If it's a network error or transient issue, don't remove the account
        // This prevents an infinite loop back to login on temporary connection issues.
        return true 
    }
}

/**
 * Temporary function to update the selected account along
 * with the relevent UI elements.
 *
 * @param {string} uuid The UUID of the account.
 */
async function setSelectedAccount(uuid) {
    const authAcc = ConfigManager.setSelectedAccount(uuid)
    await ConfigManager.save()
    updateSelectedAccount(authAcc)
    validateSelectedAccount()
}

// Synchronous Listener
document.addEventListener('readystatechange', async () => {

    if (document.readyState === 'interactive' || document.readyState === 'complete') {
        if (rscShouldLoad) {
            rscShouldLoad = false
            if (!fatalStartupError) {
                const data = await DistroManager.getDistribution()
                await showMainUI(data)
            } else {
                showFatalStartupError()
            }
        }
    }

}, false)

// Actions that must be performed after the distribution index is downloaded.
ipcRenderer.on('distributionIndexDone', async (event, res) => {
    console.log('[UIBinder] Received distributionIndexDone signal:', res)
    try {
        if (res) {
            if (window.setLoadingStatus) {
                window.setLoadingStatus('js.uibinder.loading.distributionSync')
            }
            console.log('[UIBinder] Fetching distribution data...')
            const data = await DistroManager.getDistribution()

            if (!data) {
                throw new Error('Distribution data is null or undefined.')
            }

            console.log('[UIBinder] Distribution data loaded. Syncing configs...')
            try {
                await syncModConfigurations(data)
                await ensureJavaSettings(data)
            } catch (err) {
                console.warn('[UIBinder] Error during mod/java sync, continuing...', err)
            }
            
            console.log('[UIBinder] Initialization complete. Transitioning to Main UI.')
            if (document.readyState === 'interactive' || document.readyState === 'complete') {
                await showMainUI(data)
            } else {
                rscShouldLoad = true
            }
        } else {
            throw new Error('distributionIndexDone received FALSE result.')
        }
    } catch (err) {
        console.error('[UIBinder] FATAL startup error in distributionIndexDone handler:', err)
        // If we have an error, we should still try to show UI but in a failed state
        fatalStartupError = true
        if (document.readyState === 'interactive' || document.readyState === 'complete') {
            showFatalStartupError()
        } else {
            rscShouldLoad = true
        }
    } finally {
        // ALWAYS ensure launch area is reset if we reached here
        if (typeof window.toggleLaunchArea === 'function') {
            console.log('[UIBinder] Final UI visibility sync: Showing controls.')
            window.toggleLaunchArea(false)
        }
    }
})

// Track game exit for analytics
ipcRenderer.on('launcher:exit', (event, code) => {
    console.log(`[UIBinder] Game process exited with code ${code}`)
    if (typeof Analytics !== 'undefined') {
        Analytics.capture('Game Exited', {
            exit_code: code
        })
    }
})

/**
 * Handle system power resume
 */
ipcRenderer.on('power-resume', async () => {
    if (!fatalStartupError) {
        const data = await DistroManager.getDistribution()
        if (data) {
            await onDistroRefresh(data)
        }
    }
})

// IPC Listener for cross-process UI calls
ipcRenderer.on('ui:call', (event, { fn, args }) => {
    console.log(`[UIBinder] Received cross-process UI call: ${fn}`, args)

    // Resolve string-based handlers for actions (IPC cannot send functions)
    const processedArgs = args.map(arg => {
        if (typeof arg === 'string' && arg.startsWith('ui:')) {
            const action = arg.substring(3)
            console.log(`[UIBinder] Resolving UI action: ${action}`)

            if (action === 'crash-fix-action') {
                return async () => {
                    console.log('[UIBinder] Executing crash-fix-action')
                    if (typeof window.toggleOverlay === 'function') {
                        window.toggleOverlay(false)
                    } else {
                        console.warn('[UIBinder] window.toggleOverlay is not a function!')
                    }
                    ipcRenderer.send('ui:action', 'crash-fix')
                }
            }
            if (action === 'crash-support-action') {
                return () => {
                    console.log('[UIBinder] Executing crash-support-action')
                    ipcRenderer.send('ui:action', 'crash-support')
                }
            }
            if (action === 'close-overlay') {
                return () => {
                    console.log('[UIBinder] Executing close-overlay action')
                    if (typeof window.toggleOverlay === 'function') {
                        window.toggleOverlay(false)
                    } else {
                        console.warn('[UIBinder] window.toggleOverlay is not a function!')
                    }
                }
            }
        }
        return arg
    })

    if (typeof window[fn] === 'function') {
        window[fn](...processedArgs)
    } else if (typeof exports[fn] === 'function') {
        exports[fn](...processedArgs)
    } else {
        console.warn(`[UIBinder] Received ui:call for unknown function: ${fn}`)
    }
})

// IPC Listener for clicking elements
ipcRenderer.on('ui:clickElement', (event, id) => {
    const el = document.getElementById(id)
    if (el) {
        console.log(`[UIBinder] Simulating click on element: ${id}`)
        el.click()
    } else {
        console.warn(`[UIBinder] Cannot click element: ${id} (not found)`)
    }
})

async function devModeToggle() {
    await DistroManager.toggleDevMode(true)
    const data = await DistroManager.getDistribution()
    await ensureJavaSettings(data)
    await updateSelectedServer(data.servers[0])
    await syncModConfigurations(data)
}




/**
 * Prepare the settings UI.

/**
 * Prepare the settings UI.
 * @param {boolean} first Whether this is the first load.
 */
// prepareSettings logic has been moved to settings.js to avoid conflicts and centralization.
// Expose functions to global scope for other modules
window.validateSelectedAccount = validateSelectedAccount
window.setSelectedAccount = setSelectedAccount
window.updateSelectedAccount = updateSelectedAccount

/**
 * Initialize and bind the background video.
 */
function initBackgroundVideo() {
    const vid = document.getElementById('background-video')
    const btn = document.getElementById('background-video-toggle')
    const pauseIcon = document.getElementById('vid-pause-icon')
    const playIcon = document.getElementById('vid-play-icon')

    if (!vid || !btn) return

    // Setup video properties
    vid.src = 'assets/images/backgrounds/background.webm'
    vid.playbackRate = 0.5

    // Performance check for initial state (RAM < 8GB OR CPU Cores < 4)
    if (!ConfigManager.getBackgroundVideoInitialized()) {
        const os = require('os')
        const totalRamGb = os.totalmem() / (1024 * 1024 * 1024)
        const cpuCount = os.cpus().length
        
        if (totalRamGb < 8 || cpuCount < 4) {
            ConfigManager.setBackgroundVideoPaused(true)
        }
        ConfigManager.setBackgroundVideoInitialized(true)
        ConfigManager.save()
    }

    let isPaused = ConfigManager.getBackgroundVideoPaused()

    let isStartupDelay = true;
    setTimeout(() => {
        isStartupDelay = false;
        if (!ConfigManager.getBackgroundVideoPaused() && document.hasFocus()) {
            vid.play().catch(() => {});
        }
    }, 3500); // 3.5 seconds delay to allow launcher to initialize smoothly

    const updateUI = (paused, overrideDelay = false) => {
        if (overrideDelay) isStartupDelay = false;
        
        if (paused) {
            vid.pause()
            pauseIcon.style.display = 'none'
            playIcon.style.display = 'block'
        } else {
            pauseIcon.style.display = 'block'
            playIcon.style.display = 'none'
            // Only play if window is focused and not during startup delay
            if (document.hasFocus() && !isStartupDelay) {
                vid.play().catch(err => {
                    console.warn('[UIBinder] Video play interrupted or failed:', err)
                })
            }
        }
    }

    // Initial state
    updateUI(isPaused)

    btn.onclick = () => {
        const nowPaused = !ConfigManager.getBackgroundVideoPaused()
        ConfigManager.setBackgroundVideoPaused(nowPaused)
        ConfigManager.save()
        updateUI(nowPaused, true) // override delay on user interaction
    }

    // Auto-pause when window is hidden to save resources
    window.addEventListener('blur', () => {
        vid.pause()
        // Removed display: none to prevent black screen on blur
    })

    window.addEventListener('focus', () => {
        if (!ConfigManager.getBackgroundVideoPaused() && !isStartupDelay) {
            vid.play().catch(() => {})
        }
    })

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            vid.pause()
        } else if (!ConfigManager.getBackgroundVideoPaused() && !isStartupDelay) {
            vid.play().catch(() => {})
        }
    })

    // Battery optimization for laptops
    if (navigator.getBattery) {
        navigator.getBattery().then(battery => {
            const checkBattery = () => {
                const os = require('os')
                // If on battery and below 15%, or just on battery and system is considered weak
                const isWeak = (os.totalmem() / (1024**3)) < 8 || os.cpus().length < 4
                if (!battery.charging && (battery.level < 0.15 || (isWeak && battery.level < 0.5)) && !ConfigManager.getBackgroundVideoPaused()) {
                    console.log('[UIBinder] Resource saving mode: pausing background video.')
                    ConfigManager.setBackgroundVideoPaused(true)
                    updateUI(true)
                }
            }
            battery.addEventListener('levelchange', checkBattery)
            battery.addEventListener('chargingchange', checkBattery)
            checkBattery()
        })
    }
}
