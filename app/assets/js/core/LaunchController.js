// @ts-check

const { ipcMain } = require('electron');
const { FullRepair } = require('./dl/FullRepair');
const ConfigManager = require('./configmanager');
const P2PEngine = require('../../../../network/P2PEngine');
const { LoggerUtil } = require('./util/LoggerUtil');
const path = require('path');

/**
 * @typedef {import('electron').BrowserWindow} BrowserWindow
 */

const log = LoggerUtil.getLogger('LaunchController');

class LaunchController {
    constructor() {
        /**
         * @type {BrowserWindow | null}
         */
        this.mainWindow = null;
        /**
         * @type {FullRepair | null}
         */
        this.repair = null;
    }

    /**
     * @param {BrowserWindow} window
     */
    setWindow(window) {
        this.mainWindow = window;
    }

    init() {
        // Register IPC Handlers
        ipcMain.handle('dl:start', async (event, options) => {
            return await this.startDownload(options);
        });

        ipcMain.handle('sys:scanJava', async (event, options) => {
            const JavaGuard = require('./java/JavaGuard');
            const ConfigManager = require('./configmanager');
            const res = await JavaGuard.discoverBestJvmInstallation(
                ConfigManager.getDataDirectory(),
                options?.version || null,
                options?.suggestedMajor || null
            );
            if (res && res.semver) delete res.semver;
            return res;
        });

        ipcMain.handle('sys:getAllJavas', async (event, options) => {
            const JavaGuard = require('./java/JavaGuard');
            const ConfigManager = require('./configmanager');
            const res = await JavaGuard.discoverAllJvmInstallations(
                ConfigManager.getDataDirectory(),
                options?.version || null,
                options?.suggestedMajor || null
            );
            return res.map(j => {
                const copy = { ...j };
                delete copy.semver;
                return copy;
            });
        });

        ipcMain.handle('sys:validateJava', async (event, path, version) => {
            const JavaGuard = require('./java/JavaGuard');
            const ConfigManager = require('./configmanager');
            let res;
            if (!path || path.trim() === '' || path === 'null') {
                res = await JavaGuard.discoverBestJvmInstallation(ConfigManager.getDataDirectory(), version);
            } else {
                res = await JavaGuard.validateSelectedJvm(path, version);
            }
            if (res && res.semver) delete res.semver;
            return res;
        });

        ipcMain.handle('dl:downloadJava', async (event, options) => {
            return await this.downloadJava(options);
        });

        // Ensure P2P Engine is started in Main
        P2PEngine.start();

        // Run background stale .tmp file cleanup once on startup
        const { cleanupStaleTempFiles: startCleanup } = require('./dl/DownloadEngine');
        startCleanup().catch(e => log.error('Initial Cleanup Error:', e));
    }

    /**
     * @param {{ version: string, serverId: string }} options
     * @returns {Promise<{ success: boolean }>}
     */
    async startDownload(options) {
        const { version, serverId } = options;
        log.info(`Starting download for Server: ${serverId}, Version: ${version}`);

        const commonDir = await ConfigManager.getCommonDirectory();
        const instanceDir = await ConfigManager.getInstanceDirectory();
        const launcherDir = await ConfigManager.getLauncherDirectory();

        const { DISTRO_PUB_KEYS } = require('../../../../network/config');

        // Initialize FullRepair
        this.repair = new FullRepair(
            commonDir,
            instanceDir,
            launcherDir,
            serverId,
            false, // isDev
            DISTRO_PUB_KEYS
        );

        try {
            // Step 1: Verify
            if (this.mainWindow) this.mainWindow.webContents.send('dl:progress', { type: 'verify', progress: 0 });

            const count = await this.repair.verifyFiles((percent) => {
                if (this.mainWindow) this.mainWindow.webContents.send('dl:progress', { type: 'verify', progress: percent });
            });

            log.info(`Verification complete. Found ${count} assets to process.`);

            // Step 2: Download
            if (this.mainWindow) this.mainWindow.webContents.send('dl:progress', { type: 'download', progress: 0 });

            await this.repair.download((percent) => {
                if (this.mainWindow) this.mainWindow.webContents.send('dl:progress', { type: 'download', progress: percent }); // Normalized 0-100
            });

            log.info('Download complete.');
            return { success: true };

        } catch (err) {
            log.error('Download failed:', err);
            // Must return specific error info if possible
            throw err;
        }
    }

    /**
     * @param {Object} options
     * @returns {Promise<string | null>}
     */
    async downloadJava(options) {
        const { major, distribution } = options;
        const JavaGuard = require('./java/JavaGuard');
        const { downloadFile } = require('./dl/DownloadEngine');

        // 1. Resolve Asset
        // Default to 8 if not provided (safe fallback)
        const javaVersion = major || 8;
        
        // Check for path stability (Cyrillic, spaces, etc.)
        const { isPathValid } = require('./pathutil');
        const isDirtyPath = !isPathValid(ConfigManager.getDataDirectory());
        
        // If path is dirty, we prefer an installer (Adoptium MSI) to ensure Java is registered globally
        const effectiveDistro = (isDirtyPath && process.platform === 'win32') ? 'installer' : (distribution || null);

        if (isDirtyPath) {
            log.warn('Dirty path detected! Switching to installer-based Java deployment to ensure stability.');
        }

        const asset = await JavaGuard.latestOpenJDK(
            javaVersion,
            ConfigManager.getDataDirectory(),
            effectiveDistro
        );

        if (asset == null) {
            throw new Error(`Failed to resolve Java ${javaVersion} from any source.`);
        }

        log.info(`Java asset resolved: ${asset.url} (isInstaller: ${asset.isInstaller})`);
        log.info(`Downloading Java to: ${asset.path}`);

        // 2. Download
        // Send progress to renderer
        const onProgress = (transferred) => {
            if (this.mainWindow) {
                const percent = (transferred / asset.size) * 100;
                this.mainWindow.webContents.send('dl:progress', {
                    type: 'download', 
                    progress: percent,
                    total: asset.size,
                    transferred
                });
            }
        };

        await downloadFile(asset, onProgress);

        // 3. Extract/Install
        if (asset.isInstaller) {
            if (this.mainWindow) {
                this.mainWindow.webContents.send('dl:progress', { type: 'install', progress: 0 });
            }
            log.info(`Running Java MSI installer: ${asset.path}`);
            if (this.mainWindow) {
                this.mainWindow.webContents.send('dl:progress', { type: 'install', progress: 50 });
            }
            await JavaGuard.runInstaller(asset.path);
            return null;
        }

        if (this.mainWindow) {
            this.mainWindow.webContents.send('dl:progress', { type: 'extract', progress: 0 });
        }
        const javaPath = await JavaGuard.extractJdk(asset.path);

        // 4. Return
        return javaPath;
    }
}

module.exports = new LaunchController();
