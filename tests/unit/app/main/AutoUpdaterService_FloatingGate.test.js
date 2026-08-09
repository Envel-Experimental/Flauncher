// Mock electron (AutoUpdaterService requires ipcMain/app from 'electron')
jest.mock('electron', () => ({
    ipcMain: {
        on: jest.fn()
    },
    app: {
        getVersion: jest.fn().mockReturnValue('3.1.0'),
        getAppPath: jest.fn().mockReturnValue('/app'),
        isPackaged: true
    }
}))

// Mock fs so getLocalBuildHash returns a deterministic local commit hash
jest.mock('fs', () => ({
    existsSync: jest.fn((p) => String(p).includes('version.json')),
    readFileSync: jest.fn(() => JSON.stringify({ version: '3.1.0', buildHash: 'localabc123' }))
}))

// Mock SignatureUtils
jest.mock('../../../../app/assets/js/core/util/SignatureUtils', () => ({
    verifyDistribution: jest.fn().mockResolvedValue(true)
}))

// Mock ConfigManager: fetchWithTimeout returns a GitHub releases payload
const mockFetch = jest.fn()
jest.mock('../../../../app/assets/js/core/configmanager', () => ({
    fetchWithTimeout: (...args) => mockFetch(...args),
    getDataDirectory: jest.fn().mockReturnValue('/data')
}))

// Mock electron-updater (instance methods so isUpdateAvailable can be patched)
const mockCheckForUpdates = jest.fn()
const mockAutoUpdater = {
    checkForUpdates: mockCheckForUpdates,
    setFeedURL: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    allowPrerelease: false,
    quitAndInstall: jest.fn(),
    isUpdateAvailable: jest.fn().mockResolvedValue(false)
}
jest.mock('electron-updater', () => ({
    autoUpdater: mockAutoUpdater
}))

const AutoUpdaterService = require('../../../../app/main/AutoUpdaterService')
const { autoUpdater } = require('electron-updater')

describe('AutoUpdaterService: Floating Release hash gate', () => {
    let mockSender

    const releasesPayload = (overrides = {}) => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve([
            {
                draft: false,
                prerelease: true,
                name: 'Floating Release', // STALE: no STABLE/CANARY keyword
                tag_name: 'beta-feature-1',
                target_commitish: 'aaabbb111'
            },
            {
                draft: false,
                prerelease: true,
                name: '3.1.0 STABLE',
                tag_name: 'prerelease-200',
                target_commitish: overrides.remoteCommit || 'newcomm654321'
            }
        ])
    })

    beforeEach(() => {
        jest.clearAllMocks()
        mockSender = {
            send: jest.fn(),
            isDestroyed: jest.fn().mockReturnValue(false)
        }
        // Reset the singleton's cached gate state so tests are isolated.
        AutoUpdaterService._originalIsUpdateAvailable = null
        AutoUpdaterService._floatingOverride = null
        AutoUpdaterService._floatingGatePatched = false
        // Default: remote commit differs from local (localabc123)
        mockFetch.mockResolvedValue(releasesPayload())
        mockAutoUpdater.isUpdateAvailable = jest.fn().mockResolvedValue(false)
        mockCheckForUpdates.mockResolvedValue({
            updateInfo: { version: '3.1.0', releaseName: '3.1.0 STABLE', prerelease: true }
        })
    })

    test('does not patch the gate when floating mode is disabled', async () => {
        await AutoUpdaterService.handleAction({ sender: mockSender }, 'checkForUpdate', false)
        expect(mockAutoUpdater.isUpdateAvailable).toBe(mockAutoUpdater.isUpdateAvailable)
        expect(autoUpdater.isUpdateAvailable.mock).toBeDefined()
    })

    test('forces equal-version update when floating release commit differs from local', async () => {
        await AutoUpdaterService.handleAction({ sender: mockSender }, 'checkForUpdate', true)

        // The override must treat an equal semver version as an available update.
        const local = mockAutoUpdater.isUpdateAvailable
        expect(local).not.toBeUndefined()
        const result = await local({ version: '3.1.0' })
        expect(result).toBe(true)
        expect(mockCheckForUpdates).toHaveBeenCalled()
    })

    test('does not force update when floating release matches local build', async () => {
        // Remote commit equals the local build hash
        mockFetch.mockResolvedValue(releasesPayload({ remoteCommit: 'localabc123' }))

        const original = mockAutoUpdater.isUpdateAvailable
        await AutoUpdaterService.handleAction({ sender: mockSender }, 'checkForUpdate', true)

        // Original (unpatched) behaviour is preserved
        expect(mockAutoUpdater.isUpdateAvailable).toBe(original)
    })

    test('restores the original gate after floating mode is disabled', async () => {
        // 1. Force a patch in floating mode
        await AutoUpdaterService.handleAction({ sender: mockSender }, 'checkForUpdate', true)
        const patched = mockAutoUpdater.isUpdateAvailable
        expect((await patched({ version: '3.1.0' }))).toBe(true)

        // 2. Disable floating mode -> the override must be removed from the instance
        await AutoUpdaterService.handleAction({ sender: mockSender }, 'checkForUpdate', false)
        expect(mockAutoUpdater.isUpdateAvailable).not.toBe(patched)
    })

    test('does not crash when GitHub API fetch fails', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 403 })
        mockAutoUpdater.isUpdateAvailable = jest.fn().mockResolvedValue(false)
        await AutoUpdaterService.handleAction({ sender: mockSender }, 'checkForUpdate', true)
        // Falls back to original behaviour, no forced update
        expect(mockCheckForUpdates).toHaveBeenCalled()
    })
})
