// Mock electron
const mockHandlers = {}
const mockWebContents = {
    send: jest.fn()
}
const mockWindow = {
    webContents: mockWebContents
}

jest.mock('electron', () => ({
    ipcMain: {
        handle: jest.fn((event, cb) => { mockHandlers[event] = cb }),
        on: jest.fn()
    }
}))

jest.mock('@core/configmanager', () => ({
    getDataDirectory: jest.fn().mockReturnValue('/data'),
    getCommonDirectory: jest.fn().mockResolvedValue('/common'),
    getInstanceDirectory: jest.fn().mockResolvedValue('/instance'),
    getLauncherDirectory: jest.fn().mockResolvedValue('/launcher'),
    getLauncherDirectorySync: jest.fn().mockReturnValue('/launcher')
}))

jest.mock('@network/P2PEngine', () => ({
    start: jest.fn(),
    stop: jest.fn()
}))

// Mock FullRepair
const mockRepair = {
    verifyFiles: jest.fn().mockImplementation(async (cb) => {
        cb(100)
        return 10
    }),
    download: jest.fn().mockImplementation(async (cb) => {
        cb(100)
    })
}
jest.mock('@core/dl/FullRepair', () => ({
    FullRepair: jest.fn().mockImplementation(() => mockRepair)
}))

// Mock DownloadEngine
jest.mock('@core/dl/DownloadEngine', () => ({
    cleanupStaleTempFiles: jest.fn().mockResolvedValue(),
    downloadFile: jest.fn().mockResolvedValue()
}))

// Mock JavaGuard
jest.mock('@core/java/JavaGuard', () => ({
    discoverBestJvmInstallation: jest.fn().mockResolvedValue({ path: '/java' }),
    validateSelectedJvm: jest.fn().mockResolvedValue({ valid: true }),
    latestOpenJDK: jest.fn().mockResolvedValue({ url: 'http://java', size: 100, path: '/j.zip', isInstaller: false }),
    extractJdk: jest.fn().mockResolvedValue('/extracted/java'),
    runInstaller: jest.fn().mockResolvedValue()
}))

// Mock pathutil
jest.mock('@core/pathutil', () => ({
    isPathValid: jest.fn().mockReturnValue(true)
}))

const LaunchController = require('@core/LaunchController')
const { ipcMain } = require('electron')
const P2PEngine = require('@network/P2PEngine')

describe('LaunchController', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        const { isPathValid } = require('@core/pathutil')
        isPathValid.mockReturnValue(true)
        const JavaGuard = require('@core/java/JavaGuard')
        JavaGuard.latestOpenJDK.mockResolvedValue({ url: 'http://java', size: 100, path: '/j.zip', isInstaller: false })
        LaunchController.setWindow(mockWindow)
        LaunchController.init()
    })

    test('init registers handlers and starts P2P', () => {
        LaunchController.init()
        expect(ipcMain.handle).toHaveBeenCalledWith('dl:start', expect.any(Function))
        expect(ipcMain.handle).toHaveBeenCalledWith('sys:scanJava', expect.any(Function))
        expect(P2PEngine.start).toHaveBeenCalled()
    })

    it('should register IPC handlers on init', () => {
        expect(mockHandlers['dl:start']).toBeDefined()
        expect(mockHandlers['sys:scanJava']).toBeDefined()
        expect(mockHandlers['sys:validateJava']).toBeDefined()
        expect(mockHandlers['dl:downloadJava']).toBeDefined()
    })

    describe('IPC Handlers', () => {
        it('sys:scanJava should call JavaGuard.discoverBestJvmInstallation with null version if not provided', async () => {
            const JavaGuard = require('@core/java/JavaGuard')
            await mockHandlers['sys:scanJava']({}, {})
            expect(JavaGuard.discoverBestJvmInstallation).toHaveBeenCalledWith('/data', null, null)
        })

        it('sys:validateJava should call JavaGuard.validateSelectedJvm', async () => {
            const JavaGuard = require('@core/java/JavaGuard')
            await mockHandlers['sys:validateJava']({}, '/path', 17)
            expect(JavaGuard.validateSelectedJvm).toHaveBeenCalledWith('/path', 17)
        })

        it('dl:start should call startDownload', async () => {
            // No spy, call real
            const result = await mockHandlers['dl:start']({}, { version: '1.0', serverId: 'test' })
            expect(result.success).toBe(true)
        })

        it('dl:downloadJava should call downloadJava', async () => {
            // No spy, call real
            const result = await mockHandlers['dl:downloadJava']({}, { major: 17 })
            expect(result).toBe('/extracted/java')
        })
    })

    describe('startDownload', () => {
        it('should orchestrate verify and download and report progress', async () => {
            // Test progress callbacks
            mockRepair.verifyFiles.mockImplementation(async (cb) => {
                cb(50)
                return 10
            })
            mockRepair.download.mockImplementation(async (cb) => {
                cb(75)
            })

            const result = await LaunchController.startDownload({ version: '1.0', serverId: 'test' })
            expect(result.success).toBe(true)
            expect(mockWebContents.send).toHaveBeenCalledWith('dl:progress', { type: 'verify', progress: 50 })
            expect(mockWebContents.send).toHaveBeenCalledWith('dl:progress', { type: 'download', progress: 75 })
        })

        it('should handle download failure', async () => {
            mockRepair.verifyFiles.mockRejectedValueOnce(new Error('verify failed'))
            await expect(LaunchController.startDownload({ version: '1.0', serverId: 'test' })).rejects.toThrow('verify failed')
        })
    })

    describe('downloadJava', () => {
        it('should download and extract Java and report progress', async () => {
            const { downloadFile } = require('@core/dl/DownloadEngine')
            downloadFile.mockImplementation(async (asset, cb) => {
                cb(50) // 50 bytes of 100
            })

            const javaPath = await LaunchController.downloadJava({ major: 17 })
            expect(javaPath).toBe('/extracted/java')
            expect(mockWebContents.send).toHaveBeenCalledWith('dl:progress', { 
                type: 'download', 
                progress: 50,
                total: 100,
                transferred: 50
            })
            expect(mockWebContents.send).toHaveBeenCalledWith('dl:progress', { type: 'extract', progress: 0 })
        })

        it('should throw error if Java resolution fails', async () => {
            const JavaGuard = require('@core/java/JavaGuard')
            JavaGuard.latestOpenJDK.mockResolvedValue(null)
            
            await expect(LaunchController.downloadJava({ major: 17 })).rejects.toThrow('Failed to resolve Java 17 from any source.')
        })

        it('should use default Java version 8 if none provided', async () => {
            const JavaGuard = require('@core/java/JavaGuard')
            await LaunchController.downloadJava({})
            expect(JavaGuard.latestOpenJDK).toHaveBeenCalledWith(8, '/data', null)
        })

        it('should handle installer flow and report install progress', async () => {
            const { isPathValid } = require('@core/pathutil')
            const JavaGuard = require('@core/java/JavaGuard')
            
            isPathValid.mockReturnValue(false)
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
            JavaGuard.latestOpenJDK.mockResolvedValue({ url: 'http://java.msi', size: 100, path: '/j.msi', isInstaller: true })

            const result = await LaunchController.downloadJava({ major: 17 })
            
            expect(result).toBeNull()
            expect(mockWebContents.send).toHaveBeenCalledWith('dl:progress', { type: 'install', progress: 0 })
            expect(mockWebContents.send).toHaveBeenCalledWith('dl:progress', { type: 'install', progress: 50 })
            expect(JavaGuard.runInstaller).toHaveBeenCalledWith('/j.msi')
        })

        it('should handle installer flow without mainWindow', async () => {
            const { isPathValid } = require('@core/pathutil')
            const JavaGuard = require('@core/java/JavaGuard')
            LaunchController.setWindow(null)
            
            isPathValid.mockReturnValue(false)
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
            JavaGuard.latestOpenJDK.mockResolvedValue({ url: 'http://java.msi', size: 100, path: '/j.msi', isInstaller: true })

            await LaunchController.downloadJava({ major: 17 })
            expect(mockWebContents.send).not.toHaveBeenCalled()
            expect(JavaGuard.runInstaller).toHaveBeenCalledWith('/j.msi')
        })

        it('should handle flow without mainWindow', async () => {
            LaunchController.setWindow(null)
            
            // Should not throw and should not call send
            const result = await LaunchController.startDownload({ version: '1.0', serverId: 'test' })
            expect(result.success).toBe(true)
            expect(mockWebContents.send).not.toHaveBeenCalled()

            const javaPath = await LaunchController.downloadJava({ major: 17 })
            expect(javaPath).toBe('/extracted/java')
        })
    })
})
