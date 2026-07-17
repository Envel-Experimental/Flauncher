/**
 * Script for landing.ejs
 */
// Requirements
const { URL } = require('url')
const { MojangRestAPI } = require('@core/mojang/MojangRestAPI')
const { getServerStatus } = require('@core/mojang/ServerStatusAPI')
const {
    RestResponseStatus,
    isDisplayableError
} = require('@core/common/RestResponse')
const { validateLocalFile } = require('@core/common/FileUtils')
const { FullRepair } = require('@core/dl/FullRepair')
const { DistributionIndexProcessor } = require('@core/dl/DistributionIndexProcessor')
const { MojangIndexProcessor } = require('@core/dl/MojangIndexProcessor')
const { downloadFile } = require('@core/dl/DownloadEngine')
var {
    ensureJavaDirIsRoot
} = require('@core/java/JavaUtils')


// Internal Requirements
require('@core/util/SentryWrapper.js')

/* Launch Progress Wrapper Functions */

/**
 * Show/hide the loading area.
 *
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
export function toggleLaunchArea(loading) {
    const lDetails = document.getElementById('launch_details')
    const lLeft = document.querySelector('#lower > #left #content')
    const lCenter = document.querySelector('#lower > #center #content')
    const lRight = document.querySelector('#lower > #right #launch_content')
    const lower = document.getElementById('lower')

    if (loading) {
        if (lDetails) lDetails.style.display = 'flex'
        if (lLeft) lLeft.style.display = 'none'
        if (lCenter) lCenter.style.display = 'none'
        if (lRight) lRight.style.display = 'none'
    } else {
        if (window.onReactLaunchComplete) window.onReactLaunchComplete();

        if (lower) {
            lower.style.display = 'flex'
            lower.style.visibility = 'visible'
            lower.style.opacity = '1'
        }
        if (lDetails) lDetails.style.display = 'none'

        const showElement = (el) => {
            if (el) {
                el.style.display = '' // Revert to CSS default
                el.style.visibility = 'visible'
                el.style.opacity = '1'
            }
        }

        showElement(lLeft)
        showElement(lCenter)
        showElement(lRight)
    }

    // Final visibility check for buttons
    const buttons = [
        document.getElementById('settingsMediaButton'),
        document.getElementById('newsButton'),
        document.getElementById('launch_button'),
        document.getElementById('server_selection_button')
    ]

    buttons.forEach(btn => {
        if (btn) {
            btn.style.visibility = 'visible'
            btn.style.opacity = '1'
        }
    })
}
window.toggleLaunchArea = toggleLaunchArea

/**
 * Set the details text of the loading area.
 *
 * @param {string} details The new text for the loading details.
 */
export function setLaunchDetails(details) {
    const lDetailsText = document.getElementById('launch_details_text')
    if (lDetailsText) lDetailsText.innerHTML = details
    if (window.onReactLaunchDetails) window.onReactLaunchDetails(details)
}
window.setLaunchDetails = setLaunchDetails

/**
 * Set the value of the loading progress bar and display that value.
 *
 * @param {number} percent Percentage (0-100)
 */
export function setLaunchPercentage(percent) {
    const lProgress = document.getElementById('launch_progress')
    const lProgressLabel = document.getElementById('launch_progress_label')
    if (lProgress) {
        lProgress.setAttribute('max', 100)
        lProgress.setAttribute('value', percent)
    }
    if (lProgressLabel) {
        lProgressLabel.innerHTML = Math.round(percent instanceof Number ? percent : parseFloat(percent)) + '%'
    }
    if (window.onReactLaunchPercentage) window.onReactLaunchPercentage(percent)
}
window.setLaunchPercentage = setLaunchPercentage

/**
 * Set the value of the OS progress bar and display that on the UI.
 *
 * @param {number} percent Percentage (0-100)
 */
export function setDownloadPercentage(percent) {
    currentWindow.setProgressBar(percent / 100)
    setLaunchPercentage(percent)
}

// Launch Button Logic Removed (moved to uibinder.js)

// Bind P2P Status
// Bind P2P Status



const { LoggerUtil } = require('@core/util/LoggerUtil')

const loggerLanding = LoggerUtil.getLogger('Landing')

// Poll P2P Status every 5 seconds
setInterval(async () => {
    try {
        /** @type {any} */
        const stats = await ipcRenderer.invoke('p2p:getInfo')
        const count = stats.connections
        const p2pStatus = document.getElementById('p2p_status')
        const p2pStatusText = document.getElementById('p2p_status_text')
        if (count > 0) {
            if (p2pStatus) p2pStatus.style.display = 'flex'
            if (p2pStatusText) p2pStatusText.innerHTML = `P2P (${count})`
        } else {
            if (p2pStatus) p2pStatus.style.display = 'none'
        }
    } catch (e) { /* P2P Status update failed, engine might be stopping */ }
}, 5000)

// Bind launch button
const launchButton = document.getElementById('launch_button')
if (launchButton) {
    launchButton.addEventListener('click', async e => {
        loggerLanding.info('Launching game..')
        const vid = document.getElementById('background-video')
        if (vid) vid.pause()

        try {
            const distro = await DistroAPI.getDistribution()
            if (distro == null) {
                showLaunchFailure(
                    Lang.queryJS('landing.launch.failureTitle') || 'Ошибка при запуске', 
                    Lang.queryJS('landing.launch.noDistributionIndex') || 'Не удалось получить список файлов игры. Проверьте подключение к интернету.'
                )
                if (vid && !window.ConfigManager.getBackgroundVideoPaused()) vid.play().catch(() => {})
                return
            }
            const serverIdToLaunch = window.CURRENT_SELECTED_SERVER_ID || window.ConfigManager.getSelectedServer();
            const server = distro.getServerById(serverIdToLaunch)
            if (server == null) {
                console.error(`[Landing] Failed to find server for ID: ${serverIdToLaunch}`);
                console.error(`[Landing] Available servers: ${distro.servers.map(s => s.rawServer.id).join(', ')}`);
                showLaunchFailure(
                    Lang.queryJS('landing.launch.failureTitle') || 'Ошибка при запуске', 
                    Lang.queryJS('landing.launch.noServerSelected') || 'Сервер не выбран. Пожалуйста, выберите сервер перед запуском игры.'
                )
                if (vid && !window.ConfigManager.getBackgroundVideoPaused()) vid.play().catch(() => {})
                return
            }
            const jExe = window.ConfigManager.getJavaExecutable(serverIdToLaunch)
            if (jExe == null) {
                await asyncSystemScan(server.effectiveJavaOptions)
            } else {

                setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
                toggleLaunchArea(true)
                setLaunchPercentage(0, 100)

                /** @type {any} */
                const details = await ipcRenderer.invoke('sys:validateJava', ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
                if (details != null) {
                    loggerLanding.info('Jvm Details', details)
                    await dlAsync()

                } else {
                    await asyncSystemScan(server.effectiveJavaOptions)
                }
            }
            if (typeof Analytics !== 'undefined') {
                Analytics.capture('Game Launch Started', {
                    serverId: ConfigManager.getSelectedServer(),
                    server_name: typeof server.rawServer.name === 'string' ? server.rawServer.name : (server.rawServer.name?.value || 'Unknown'),
                    mc_version: server.rawServer.minecraftVersion,
                    module_count: server.modules.length
                })
            }
        } catch (err) {
            loggerLanding.error('Unhandled error in during launch process.', err)
            console.error('Launch error details:', err);
            if (typeof Analytics !== 'undefined') {
                Analytics.capture('Game Launch Failed', {
                    serverId: serverIdToLaunch,
                    error: err.message || err.toString()
                })
                Analytics.captureException(err)
            }
            showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.launch.failureText'))
            if (vid && !window.ConfigManager.getBackgroundVideoPaused()) vid.play().catch(() => {})
        }
    })
}

// Bind settings button
if (typeof safeSetOnClick === 'function') {
    safeSetOnClick('settingsMediaButton', async e => {
        if (typeof prepareSettings === 'function') await prepareSettings()
        switchView(getCurrentView(), VIEWS.settings)
    })
}

// Bind avatar overlay button.
if (typeof safeSetOnClick === 'function') {
    safeSetOnClick('avatarOverlay', async e => {
        if (typeof prepareSettings === 'function') await prepareSettings()
        switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
            const settingsNavAccount = document.getElementById('settingsNavAccount')
            if (settingsNavAccount && typeof settingsNavItemListener === 'function') {
                settingsNavItemListener(settingsNavAccount, false)
            }
        })
    })
}

// Bind selected account
document.addEventListener('DOMContentLoaded', () => {
    if (typeof updateSelectedAccount === 'function') {
        updateSelectedAccount(ConfigManager.getSelectedAccount())
    }

    // Bind selected server
    // Real text is set in uibinder.js on distributionIndexDone.
    const serverSelectionBtn = document.getElementById('server_selection_button')
    if (serverSelectionBtn) {
        serverSelectionBtn.innerHTML = Lang.queryJS('landing.selectedServer.loading')
        serverSelectionBtn.onclick = async e => {
            e.target.blur()
            await toggleServerSelection(true)
        }
    }
})

// Update Mojang Status Color
const refreshMojangStatuses = async function () {
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    let tooltipEssentialHTML = ''
    let tooltipNonEssentialHTML = ''

    const response = await MojangRestAPI.status()
    let statuses
    if (response.responseStatus === RestResponseStatus.SUCCESS) {
        statuses = response.data
    } else {
        loggerLanding.warn('Unable to refresh Mojang service status.')
        statuses = MojangRestAPI.getDefaultStatuses()
    }

    greenCount = 0
    greyCount = 0

    for (let i = 0; i < statuses.length; i++) {
        const service = statuses[i]
        const safeName = service.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;")

        const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(service.status)};">&#8226;</span>
            <span class="mojangStatusName">${safeName}</span>
        </div>`
        if (service.essential) {
            tooltipEssentialHTML += tooltipHTML
        } else {
            tooltipNonEssentialHTML += tooltipHTML
        }

        if (service.status === 'yellow' && status !== 'red') {
            status = 'yellow'
        } else if (service.status === 'red') {
            status = 'red'
        } else {
            if (service.status === 'grey') {
                ++greyCount
            }
            ++greenCount
        }

    }

    if (greenCount === statuses.length) {
        if (greyCount === statuses.length) {
            status = 'grey'
        } else {
            status = 'green'
        }
    }

    document.getElementById('mojangStatusEssentialContainer').innerHTML = tooltipEssentialHTML
    document.getElementById('mojangStatusNonEssentialContainer').innerHTML = tooltipNonEssentialHTML
    const statusIcon = document.getElementById('mojang_status_icon')
    if (statusIcon) statusIcon.style.color = MojangRestAPI.statusToHex(status)
}

export const refreshServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Server Status')
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())

    let pLabel = Lang.queryJS('landing.serverStatus.server')
    let pVal = Lang.queryJS('landing.serverStatus.offline')

    try {

        const servStat = await getServerStatus(47, serv.hostname, serv.port)
        console.log(servStat)
        pLabel = Lang.queryJS('landing.serverStatus.players')
        pVal = servStat.players.online + '/' + servStat.players.max

    } catch (err) {
        loggerLanding.warn('Unable to refresh server status, assuming offline.')
        loggerLanding.debug(err)
    }
    if (fade) {
        fadeOut(document.getElementById('server_status_wrapper'), 250, () => {
            document.getElementById('landingPlayerLabel').innerHTML = pLabel
            document.getElementById('player_count').innerHTML = pVal
            fadeIn(document.getElementById('server_status_wrapper'), 500)
        })
    } else {
        document.getElementById('landingPlayerLabel').innerHTML = pLabel
        document.getElementById('player_count').innerHTML = pVal
    }

}

/**
 * Shows an error overlay, toggles off the launch area.
 *
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
export function showLaunchFailure(title, desc) {
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay') || 'ОК'
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}

/**
 * Shows the offline warning overlay.
 */
async function showOfflineWarning() {
    return new Promise((resolve) => {
        setOverlayContent(
            Lang.queryJS('landing.launch.serverUnavailableTitle'),
            Lang.queryJS('landing.launch.serverUnavailableDesc'),
            Lang.queryJS('landing.launch.serverUnavailableOkay')
        )
        setOverlayHandler(() => {
            toggleOverlay(false)
            resolve()
        })
        toggleOverlay(true)
    })
}

/* System (Java) Scan */

// Keep reference to Minecraft Process
let proc
// Joined server regex
// Change this if your server uses something different.
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+|.+ \/.+\]: .+|.+LWJGL.+)$/
const MIN_LINGER = 5000

/* System (Java) Scan */

/**
 * Asynchronously scan the system for valid Java installations.
 *
 * @param {boolean} launchAfter Whether we should begin to launch after scanning.
 */
async function asyncSystemScan(effectiveJavaOptions, launchAfter = true) {

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    // IPC Call to Main Process
    /** @type {any} */
    const jvmDetails = await ipcRenderer.invoke('sys:scanJava', {
        version: effectiveJavaOptions.supported,
        suggestedMajor: effectiveJavaOptions.suggestedMajor
    })

    if (jvmDetails == null) {
        if (!window.hasAttemptedJavaDownload) {
            window.hasAttemptedJavaDownload = true
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            try {
                downloadJava(effectiveJavaOptions, launchAfter)
            } catch (err) {
                loggerLanding.error('Unhandled error in auto Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'))
            }
            return
        }

        // If the result is null, no valid Java installation was found.
        // Show this information to the user.
        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(() => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            toggleOverlay(false)

            try {
                downloadJava(effectiveJavaOptions, launchAfter)
            } catch (err) {
                loggerLanding.error('Unhandled error in Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'))
            }
        })
        setDismissHandler(() => {
            fadeOut(document.getElementById('overlayContent'), 250, () => {

                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)

                    asyncSystemScan(effectiveJavaOptions, launchAfter)
                })
                fadeIn(document.getElementById('overlayContent'), 250)
            })
        })
        toggleOverlay(true, true)
    } else {
        // Java installation found, use this to launch the game.
        // We assume Main process returns the full path including executable
        let javaExec = jvmDetails.path
        if (jvmDetails.executable) javaExec = jvmDetails.executable // If object returned

        // Ensure we get the executable path if the scanner returns the home dir
        if (!javaExec.endsWith('java') && !javaExec.endsWith('java.exe') && !javaExec.endsWith('javaw.exe')) {
            // We can't resolve this easily in Renderer without path/fs access if we are strict.
            // But we still have nodeIntegration for now.
            const { javaExecFromRoot } = require('@core/java/JavaUtils')
            javaExec = javaExecFromRoot(javaExec)
        }

        ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), javaExec)
        await ConfigManager.save()

        // We need to make sure that the updated value is on the settings UI.
        // Just incase the settings UI is already open.
        settingsJavaExecVal.value = javaExec
        await populateJavaExecDetails(settingsJavaExecVal.value)

        if (launchAfter) {
            await dlAsync()
        }
    }

}

async function downloadJava(effectiveJavaOptions, launchAfter = true) {
    if (!effectiveJavaOptions) effectiveJavaOptions = {}

    // Temporary: Use a hardcoded object if effectiveJavaOptions is empty or mismatched,
    // assuming standard key names from the distro logic.
    // effectiveJavaOptions usually has: { platform, architecture, majorVersion (or suggestedMajor) }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch')) // Generic "Preparing..."
    toggleLaunchArea(true)
    setLaunchPercentage(0)

    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    // Listen for progress
    const progressListener = (event, status) => {
        if (status.type === 'download') {
            setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles')) // Reuse "Downloading Files"
            setDownloadPercentage(status.progress)
        } else if (status.type === 'extract') {
            setLaunchDetails('Extracting Java...')
            setLaunchPercentage(100)
        } else if (status.type === 'install') {
            setLaunchDetails('Installing Java...') // Accurate feedback for MSI
            setLaunchPercentage(status.progress || 100)
        }
    }
    ipcRenderer.on('dl:progress', progressListener)

    try {
        // Invoke Main
        /** @type {string | null} */
        const javaPath = await ipcRenderer.invoke('dl:downloadJava', {
            major: effectiveJavaOptions.majorVersion || effectiveJavaOptions.suggestedMajor || 8,
            distribution: effectiveJavaOptions.distribution || null
        })

        ipcRenderer.removeListener('dl:progress', progressListener)

        if (javaPath != null) {
            // Success (ZIP/direct path)
            ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), javaPath)
            await ConfigManager.save()

            if (document.getElementById('settingsJavaExecVal')) {
                document.getElementById('settingsJavaExecVal').value = javaPath
                await populateJavaExecDetails(javaPath)
            }

            if (launchAfter) {
                await dlAsync()
            }
        } else {
            // MSI installer finished. We don't have a path yet.
            // Trigger a re-scan to find where it was installed.
            await asyncSystemScan(effectiveJavaOptions, launchAfter)
        }

    } catch (err) {
        ipcRenderer.removeListener('dl:progress', progressListener)
        loggerLaunchSuite.error('Error downloading Java via Main Process.', err)
        showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), `${Lang.queryJS('landing.systemScan.javaDownloadFailureText')}\n\n(${err.message})`)
    }
}


async function dlAsync(login = true) {

    // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
    // launching the game.

    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    let isOfflineLaunch = false

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'))

    let distro

    try {
        distro = await DistroAPI.refreshDistributionOrFallback()
        onDistroRefresh(distro)
    } catch (err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex'))
        return
    }

    const serv = distro.getServerById(ConfigManager.getSelectedServer())

    if (login) {
        // Fallback: If getSelectedAccount() is null, try to get the first account from the auth database
        let account = window.ConfigManager.getSelectedAccount();
        if (account == null) {
            const allAccounts = window.ConfigManager.getAuthAccounts();
            if (allAccounts && Object.keys(allAccounts).length > 0) {
                const firstId = Object.keys(allAccounts)[0];
                account = allAccounts[firstId];
                console.log(`[Landing] Auth fallback: using first available account ${firstId}`);
            }
        }

        if (account == null) {
            loggerLanding.error('You must be logged into an account.')
            showLaunchFailure(
                Lang.queryJS('landing.launch.failureTitle') || 'Ошибка при запуске',
                'Ты не авторизован. Войди в аккаунт перед запуском игры.'
            )
            toggleLaunchArea(false) // FIX: Reset UI
            return
        }
    }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    // Listen for progress from Main
    const progressListener = (event, status) => {
        if (status.type === 'verify') {
            setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
            setLaunchPercentage(status.progress * 0.40) // 0-40% for verification
        } else if (status.type === 'download') {
            setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
            setDownloadPercentage(40 + (status.progress * 0.50)) // 40-90% for downloading
        }
    }
    ipcRenderer.on('dl:progress', progressListener)

    try {
        // Invoke Main Process Download
        await ipcRenderer.invoke('dl:start', {
            serverId: ConfigManager.getSelectedServer(),
            version: serv.rawServer.minecraftVersion
        })

        // Success
        setDownloadPercentage(90)
        ipcRenderer.removeListener('dl:progress', progressListener)

    } catch (err) {
        ipcRenderer.removeListener('dl:progress', progressListener)
        loggerLaunchSuite.warn('Error during file download via Main Process.', err)

        const isDiskFull = err.message && (err.message.includes('ENOSPC') || err.message.includes('no space left'))
        const errorText = isDiskFull 
            ? 'На диске недостаточно места для загрузки файлов игры. Пожалуйста, освободите пространство.' 
            : err.message

        // Provide an option to skip download failures and try to launch anyway
        const action = await new Promise((resolve) => {
            setOverlayContent(
                Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'),
                errorText + '<br><br>' + Lang.queryJS('landing.dlAsync.skipQuestion'),
                Lang.queryJS('landing.dlAsync.retryButton') || 'Повторить',
                Lang.queryJS('landing.dlAsync.skipButton') || 'Пропустить',
                Lang.queryJS('landing.launch.cancelButton') || 'Отмена'
            )
            setOverlayHandler(() => {
                toggleOverlay(false)
                resolve('retry')
            })
            setMiddleButtonHandler(() => {
                toggleOverlay(false)
                resolve('skip')
            })
            setDismissHandler(() => {
                toggleOverlay(false)
                toggleLaunchArea(false)
                resolve('cancel')
            })
            toggleOverlay(true, true)
        })

        if (action === 'cancel') return
        if (action === 'retry') {
            return dlAsync(login)
        }
    }

    if (isOfflineLaunch) {
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingOffline'))
    } else {
        setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))
    }
    setLaunchPercentage(100)

    if (login) {
        let authUser = window.ConfigManager.getSelectedAccount();
        if (authUser == null) {
            const allAccounts = window.ConfigManager.getAuthAccounts();
            if (allAccounts && Object.keys(allAccounts).length > 0) {
                authUser = allAccounts[Object.keys(allAccounts)[0]];
            }
        }
        loggerLanding.info('Game launch sequence started..')
        
        const javaPathToUse = window.ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
        console.log(`[Landing] Launch initialization. Selected Java: ${javaPathToUse}`)
        
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))

        // Attach listeners for logs from Main
        let launchHandled = false
        const tempListener = (data) => {
            if (launchHandled || typeof data !== 'string') return
            const lines = data.split(/\r?\n/)
            for (const line of lines) {
                if (GAME_LAUNCH_REGEX.test(line.trim())) {
                    launchHandled = true
                    const diff = Date.now() - start
                    if (diff < MIN_LINGER) {
                        setTimeout(() => toggleLaunchArea(false), MIN_LINGER - diff)
                    } else {
                        toggleLaunchArea(false)
                    }
                    break
                }
            }
        }

        const gameErrorListener = (data) => {
            if (data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1) {
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'))
            }
        }

        window.HeliosAPI.launcher.onLog(tempListener)
        window.HeliosAPI.launcher.onLogError(gameErrorListener)
        let hasExited = false
        window.HeliosAPI.launcher.onExit((code) => {
            hasExited = true
            loggerLaunchSuite.warn(`Game exited with code ${code}. Resetting UI.`)
            toggleLaunchArea(false)
        })

        // Do not print game logs to renderer console. 
        // Doing so causes a massive IPC loop (Main->Renderer->Main) that freezes the UI.
        // window.HeliosAPI.launcher.onLog((data) => {
        //     console.log('[Minecraft] ' + data)
        // })

        // For E2E tests
        window.activeMinecraftProcess = {
            kill: () => window.HeliosAPI.launcher.terminate()
        }

        const start = Date.now()
        try {
            // Invoke Main Process Launch
            await window.HeliosAPI.launcher.launch({
                serverId: serv.rawServer.id,
                authUser: authUser
            })
            
            if (!hasExited) {
                setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'))
            }

        } catch (err) {
            loggerLaunchSuite.error('Error during launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))
        }
    }

}

// Bind news button.
if (typeof safeSetOnClick === 'function') {
    safeSetOnClick('newsButton', async () => {
        const path = require('path')
        const { shell } = require('electron')
        try {
            const distro = await DistroAPI.getDistribution()
            const serv = distro.getServerById(ConfigManager.getSelectedServer())
            if (serv) {
                const serverId = serv.rawServer.id
                const instancePath = path.join(await ConfigManager.getInstanceDirectory(), serverId)
                await ipcRenderer.invoke('shell:openPath', instancePath)
            }
        } catch (err) {
            if (window.loggerLanding) {
                window.loggerLanding.error('Error opening instance directory.', err)
            }
        }
    })
}
