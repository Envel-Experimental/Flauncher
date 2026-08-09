// const { autoUpdater } = require('electron-updater')
const { ipcMain, app } = require('electron')

/**
 * Lazy-load autoUpdater to prevent early initialization crashes.
 */
function getAutoUpdater() {
    return require('electron-updater').autoUpdater
}

const path = require('path')
const isDev = require('../assets/js/core/isdev')
const semver = require('semver')

const { DISTRO_PUB_KEYS } = require('../../network/config')
const { verifyDistribution } = require('../assets/js/core/util/SignatureUtils')
const ConfigManager = require('../assets/js/core/configmanager')

const CUSTOM_UPDATE_URL = 'https://f-launcher.ru/fox/new/updates'
// Used to resolve the commit hash of the latest "floating" pre-release.
// electron-updater only offers an update when the remote semver version is
// strictly greater than the installed one, so a Floating Release (same version,
// newer commit) is otherwise reported as "update-not-available".
const GITHUB_API_RELEASES_URL = 'https://api.github.com/repos/Envel-Experimental/Flauncher/releases?per_page=100'

class AutoUpdaterService {
    constructor() {
        this.event = null
        this._floatingGatePatched = false
        this._originalIsUpdateAvailable = null
        this._floatingOverride = null
    }

    init() {
        ipcMain.on('autoUpdateAction', (event, arg, data) => {
            if (event.sender.isDestroyed()) return
            this.handleAction(event, arg, data)
        })
    }

    async handleAction(event, arg, data) {
        switch (arg) {
            case 'initAutoUpdater':
                this.setupListeners(event, data)
                if (event.sender && !event.sender.isDestroyed()) {
                    event.sender.send('autoUpdateNotification', 'ready')
                }
                break
            case 'checkForUpdate':
                console.log('[AutoUpdater] Received checkForUpdate request (Floating Release Mode: ' + !!data + ')')
                try {
                    const autoUpdater = getAutoUpdater()
                    const isFloating = !!data

                    // If we are in "Floating Release" mode, we allow pre-releases.
                    autoUpdater.allowPrerelease = isFloating

                    // In Floating Release mode electron-updater refuses to offer an update when
                    // the remote semver version equals the installed one (every floating build
                    // carries the same version with only the commit hash changing). Detect the
                    // latest qualifying pre-release and, if its commit differs from the locally
                    // installed build, force electron-updater to treat it as an update.
                    await this.patchFloatingVersionGate(isFloating)

                    autoUpdater.checkForUpdates().then((result) => {
                        if (result && result.updateInfo) {
                            const title = (result.updateInfo.releaseName || result.updateInfo.version || '').toUpperCase()
                            const isPre = !!result.updateInfo.prerelease

                            // If it's a pre-release, it MUST have "STABLE" or "CANARY" in the title to be accepted as a "Floating Release"
                            if (isPre && !title.includes('STABLE') && !title.includes('CANARY')) {
                                console.log(`[AutoUpdater] Skipping pre-release ${result.updateInfo.version} because it lacks "STABLE" or "CANARY" in title.`)
                                if (event.sender && !event.sender.isDestroyed()) {
                                    event.sender.send('autoUpdateNotification', 'update-not-available')
                                }
                                return
                            }
                        }
                        console.log('[AutoUpdater] Update check completed (Primary).', result ? 'Update available: ' + !!result.updateInfo : 'No result')
                    }).catch(async (err) => {
                        console.warn('[AutoUpdater] Primary update check failed, attempting fallback to custom server...', err.message)
                        
                        try {
                            // Switch to Custom Server
                            autoUpdater.setFeedURL({
                                provider: 'generic',
                                url: CUSTOM_UPDATE_URL
                            })

                            // Verify signature of latest.yml
                            const isSigned = await this.verifyMetadataSignature(CUSTOM_UPDATE_URL)
                            if (isSigned) {
                                console.log('[AutoUpdater] Custom server manifest signature verified. Checking for updates...')
                                autoUpdater.checkForUpdates().then((res) => {
                                    console.log('[AutoUpdater] Fallback update check completed.', res ? 'Update available: ' + !!res.updateInfo : 'No result')
                                }).catch(fallbackErr => {
                                    console.error('[AutoUpdater] Fallback update check failed:', fallbackErr)
                                    this.sendError(event.sender, fallbackErr)
                                })
                            } else {
                                console.error('[AutoUpdater] Custom server manifest signature INVALID or missing. Aborting.')
                                this.sendError(event.sender, new Error('Update verification failed (Signature Invalid)'))
                            }
                        } catch (fallbackEx) {
                            console.error('[AutoUpdater] Error during fallback initialization:', fallbackEx)
                            this.sendError(event.sender, fallbackEx)
                        }
                    })
                } catch (err) {
                    console.error('[AutoUpdater] Synchronous error during checkForUpdates:', err)
                    this.sendError(event.sender, err)
                }
                break
            case 'allowPrereleaseChange':
                this.handlePrereleaseChange(data)
                break
            case 'installUpdateNow':
                getAutoUpdater().quitAndInstall(false, true)
                break
            default:
                console.log('Unknown autoUpdateAction:', arg)
        }
    }

    setupListeners(event, data) {
        if (data) {
            getAutoUpdater().allowPrerelease = true
        }

        if (isDev) {
            getAutoUpdater().autoInstallOnAppQuit = false
            getAutoUpdater().updateConfigPath = path.join(app.getAppPath(), 'dev-app-update.yml')
        }
        
        if (process.platform === 'darwin') {
            getAutoUpdater().autoDownload = false
        }

        const sender = event.sender

        getAutoUpdater().removeAllListeners()

        getAutoUpdater().on('update-available', info => {
            if (!sender.isDestroyed()) sender.send('autoUpdateNotification', 'update-available', info)
        })
        getAutoUpdater().on('update-downloaded', info => {
            if (!sender.isDestroyed()) sender.send('autoUpdateNotification', 'update-downloaded', info)
        })
        getAutoUpdater().on('update-not-available', info => {
            if (!sender.isDestroyed()) sender.send('autoUpdateNotification', 'update-not-available', info)
        })
        getAutoUpdater().on('checking-for-update', () => {
            if (!sender.isDestroyed()) sender.send('autoUpdateNotification', 'checking-for-update')
        })
        getAutoUpdater().on('error', err => {
            this.sendError(sender, err)
        })
    }

    handlePrereleaseChange(data) {
        if (!data) {
            const preRelComp = semver.prerelease(app.getVersion())
            getAutoUpdater().allowPrerelease = (preRelComp != null && preRelComp.length > 0)
        } else {
            getAutoUpdater().allowPrerelease = data
        }
    }

    /**
     * Read the build commit hash embedded into the installed bundle at build time.
     * Falls back to 'unknown' when version.json is missing/unreadable.
     */
    getLocalBuildHash() {
        const fsSync = require('fs')
        const candidates = [
            path.join(app.getAppPath(), 'assets', 'version.json'),
            path.join(app.getAppPath(), 'version.json')
        ]
        for (const versionPath of candidates) {
            try {
                if (fsSync.existsSync(versionPath)) {
                    const versionData = JSON.parse(fsSync.readFileSync(versionPath, 'utf8'))
                    if (versionData && versionData.buildHash) {
                        return String(versionData.buildHash).trim()
                    }
                }
            } catch (e) {
                console.warn(`[AutoUpdater] Failed to read local build hash from ${versionPath}:`, e.message)
            }
        }
        return 'unknown'
    }

    /**
     * Resolve the commit hash of the newest qualifying Floating Release on GitHub.
     * A Floating Release is a non-draft pre-release whose name/title contains the
     * "STABLE" or "CANARY" keyword (same business rule used in the update filter).
     * Returns an empty string when no qualifying release exists or the API failed.
     */
    async getRemoteFloatingReleaseHash() {
        try {
            const res = await ConfigManager.fetchWithTimeout(GITHUB_API_RELEASES_URL, {
                headers: { 'User-Agent': 'Flauncher-AutoUpdater', 'Accept': 'application/vnd.github+json' },
                cache: 'no-store'
            }, 10000)
            if (!res.ok) {
                console.warn('[AutoUpdater] GitHub releases API failed:', res.status)
                return ''
            }
            const releases = await res.json()
            if (!Array.isArray(releases)) return ''

            const floating = releases.find(r =>
                r && !r.draft && !!r.prerelease &&
                typeof r.name === 'string' &&
                (r.name.toUpperCase().includes('STABLE') || r.name.toUpperCase().includes('CANARY'))
            )
            if (!floating || typeof floating.target_commitish !== 'string') return ''

            // GitHub reports the full 40-char SHA; reduce to the same short form
            // used by the build (git rev-parse --short HEAD, up to 7 chars).
            return floating.target_commitish.slice(0, 7).toLowerCase()
        } catch (e) {
            console.warn('[AutoUpdater] Failed to resolve floating release commit:', e.message)
            return ''
        }
    }

    /**
     * In Floating Release mode every build keeps the same semver version and only the
     * commit hash changes. electron-updater's isUpdateAvailable() returns false as soon as
     * the remote version equals the installed one, so it never offers such a build.
     *
     * When the remote floating build differs from the locally installed one we override
     * isUpdateAvailable() on the autoUpdater instance so an equal-version but newer-commit
     * build is treated as a valid update. Never forces when hashes are unknown/equal.
     */
    async patchFloatingVersionGate(isFloating) {
        const autoUpdater = getAutoUpdater()

        // Track the genuine (library) implementation so we always restore it even
        // after temporarily overriding it. If the instance still holds our own
        // previous override, re-use the original we captured before applying it,
        // otherwise (re)capture it fresh.
        if (autoUpdater.isUpdateAvailable !== this._floatingOverride) {
            this._originalIsUpdateAvailable = autoUpdater.isUpdateAvailable
        }

        const restore = () => {
            if (this._floatingGatePatched && this._originalIsUpdateAvailable) {
                autoUpdater.isUpdateAvailable = this._originalIsUpdateAvailable
                this._floatingGatePatched = false
            }
        }

        // Floating mode disabled => make sure any previous override is removed.
        if (!isFloating) {
            restore()
            return
        }

        const localHash = this.getLocalBuildHash()
        const remoteHash = await this.getRemoteFloatingReleaseHash()

        if (localHash === 'unknown' || !remoteHash) {
            console.log('[AutoUpdater] Floating mode: skipping hash gate patch (local or remote hash missing).')
            restore()
            return
        }
        if (remoteHash === localHash.toLowerCase() || localHash.toLowerCase().startsWith(remoteHash) || remoteHash.startsWith(localHash.toLowerCase())) {
            console.log(`[AutoUpdater] Floating mode: local build (${localHash}) matches latest floating release. No forced update.`)
            restore()
            return
        }

        // Remove any previously-applied override before applying a fresh one.
        restore()
        console.log(`[AutoUpdater] Floating mode: forcing equal-version update ${localHash} -> ${remoteHash}`)
        const original = this._originalIsUpdateAvailable
        const override = async (updateInfo) => {
            try {
                if (typeof original === 'function') {
                    const result = await Promise.resolve(original(updateInfo))
                    if (result === true) return true
                }
                // Equal semver version + differing commit hash => treat as update.
                if (updateInfo && typeof updateInfo.version === 'string') {
                    const latest = semver.parse(updateInfo.version)
                    const current = semver.parse(app.getVersion())
                    if (latest && current && semver.eq(latest, current)) {
                        return true
                    }
                }
                return false
            } catch (e) {
                console.warn('[AutoUpdater] Floating gate override error:', e.message)
                return typeof original === 'function' ? Promise.resolve(original(updateInfo)) : false
            }
        }
        autoUpdater.isUpdateAvailable = override
        this._floatingOverride = override
        this._floatingGatePatched = true
    }

    async verifyMetadataSignature(url) {
        const yamlName = process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
        const yamlUrl = `${url}/${yamlName}`
        const sigUrl = `${yamlUrl}.sig`

        try {
            console.log(`[AutoUpdater] Verifying signature for ${yamlName}...`)
            const yamlRes = await ConfigManager.fetchWithTimeout(yamlUrl, { cache: 'no-store' }, 8000)
            if (!yamlRes.ok) throw new Error(`YAML fetch failed: ${yamlRes.status}`)
            
            const yamlBuffer = Buffer.from(await yamlRes.arrayBuffer())

            const sigRes = await ConfigManager.fetchWithTimeout(sigUrl, { cache: 'no-store' }, 5000)
            if (!sigRes.ok) throw new Error(`SIG fetch failed: ${sigRes.status}`)
            
            const signatureHex = (await sigRes.text()).trim()

            return verifyDistribution({
                dataHex: yamlBuffer.toString('hex'),
                signatureHex: signatureHex,
                trustedKeys: DISTRO_PUB_KEYS
            })
        } catch (e) {
            console.error('[AutoUpdater] Signature verification error:', e.message)
            return false
        }
    }

    sendError(sender, err) {
        if (sender.isDestroyed()) return
        if (err.code === 'EPERM' || err.code === 'ENOENT') {
            sender.send('autoUpdateNotification', 'antivirus-issue')
        } else {
            sender.send('autoUpdateNotification', 'realerror', err)
        }
    }
}

module.exports = new AutoUpdaterService()
