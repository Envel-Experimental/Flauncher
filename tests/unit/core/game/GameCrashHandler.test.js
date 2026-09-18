// Mock modules at the very top
jest.mock('@sentry/electron/main')
jest.mock('electron', () => ({
    shell: {
        openExternal: jest.fn(),
        openPath: jest.fn()
    },
    ipcMain: {
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn()
    },
    BrowserWindow: jest.fn()
}))

jest.mock('fs', () => ({
    existsSync: jest.fn(),
    rmSync: jest.fn(),
    unlinkSync: jest.fn(),
    renameSync: jest.fn(),
    promises: {
        stat: jest.fn(),
        readdir: jest.fn()
    }
}))

jest.mock('os', () => ({
    hostname: jest.fn().mockReturnValue('test-host'),
    totalmem: jest.fn().mockReturnValue(8 * 1024 * 1024 * 1024),
    freemem: jest.fn().mockReturnValue(4 * 1024 * 1024 * 1024),
    platform: jest.fn().mockReturnValue('win32')
}))

const fs = require('fs')
const os = require('os')
const path = require('path')

// Mock CrashHandler
jest.mock('../../../../app/assets/js/core/crash-handler', () => ({
    analyzeFile: jest.fn(),
    analyzeLog: jest.fn()
}))

// Mock ConfigManager
jest.mock('../../../../app/assets/js/core/configmanager', () => ({
    getSupportUrl: jest.fn().mockReturnValue('http://support'),
    getDataDirectory: jest.fn().mockReturnValue('/data'),
    getJavaExecutable: jest.fn().mockReturnValue('/data/runtime/x64/java/bin/javaw.exe'),
    getModConfiguration: jest.fn().mockReturnValue({ mods: {} }),
    setModConfiguration: jest.fn(),
    setJavaExecutable: jest.fn(),
    save: jest.fn()
}))

// Mock Lang
jest.mock('../../../../app/assets/js/core/langloader', () => ({
    queryJS: jest.fn((key) => key)
}))

// Mock LoggerUtil
jest.mock('../../../../app/assets/js/core/util/LoggerUtil', () => ({
    LoggerUtil: {
        getLogger: jest.fn().mockReturnValue({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        })
    }
}))

const GameCrashHandler = require('../../../../app/assets/js/core/game/GameCrashHandler')

describe('GameCrashHandler', () => {
    let handler
    const gameDir = '/game'
    const commonDir = '/common'
    const server = { rawServer: { id: 'test', minecraftVersion: '1.16.5' }, modules: [] }
    const logBuffer = ['line 1', 'line 2']

    beforeEach(() => {
        jest.useFakeTimers()
        jest.clearAllMocks()
        process.type = 'renderer'
        handler = new GameCrashHandler(gameDir, commonDir, server, logBuffer)
    })

    afterEach(() => {
        jest.useRealTimers()
    })

    describe('handleExit', () => {
        it('should ignore non-crash exit codes', async () => {
            const spy = jest.spyOn(handler, 'analyzeCrash')
            await handler.handleExit(0)
            expect(spy).not.toHaveBeenCalled()
        })

        it('should handle crash exit codes', async () => {
            jest.spyOn(handler, 'analyzeCrash').mockResolvedValue({ type: 'unknown' })
            jest.spyOn(handler, 'showSpecificCrashOverlay').mockResolvedValue()
            
            await handler.handleExit(1)
            expect(handler.analyzeCrash).toHaveBeenCalled()
        })
    })

    describe('analyzeCrash', () => {
        it('should analyze log file if it exists', async () => {
            const CrashHandler = require('../../../../app/assets/js/core/crash-handler')
            CrashHandler.analyzeFile.mockResolvedValue({ type: 'oom' })
            
            const promise = handler.analyzeCrash()
            jest.advanceTimersByTime(2000)
            const result = await promise
            
            expect(result).toEqual({ type: 'oom' })
        })

        it('should fallback to memory buffer if disk analysis fails', async () => {
            const CrashHandler = require('../../../../app/assets/js/core/crash-handler')
            CrashHandler.analyzeFile.mockRejectedValue(new Error('no file'))
            CrashHandler.analyzeLog.mockReturnValue({ type: 'stacktrace' })
            fs.promises.stat.mockRejectedValue(new Error('no dir'))

            const promise = handler.analyzeCrash()
            jest.advanceTimersByTime(2000)
            const result = await promise
            
            expect(result).toEqual({ type: 'stacktrace' })
        })
    })

    describe('enrichOOMAnalysis', () => {
        it('should add advice for low memory', () => {
            os.totalmem.mockReturnValue(4 * 1024 * 1024 * 1024)
            const analysis = { type: 'java-oom' }
            handler.enrichOOMAnalysis(analysis)
            expect(analysis.description).toContain('Мало оперативной памяти')
        })

        it('should add advice for enough memory but crash', () => {
            os.totalmem.mockReturnValue(16 * 1024 * 1024 * 1024)
            os.freemem.mockReturnValue(8 * 1024 * 1024 * 1024)
            const analysis = { type: 'java-oom' }
            handler.enrichOOMAnalysis(analysis)
            // Fixed casing: "Попробуй" in code
            expect(analysis.description).toContain('Попробуй выделить больше памяти')
        })
    })

    describe('handleCrashFix', () => {
        it('should handle missing-version-file fix', async () => {
            fs.existsSync.mockReturnValue(true)
            await handler.handleCrashFix({ type: 'missing-version-file', file: '1.16.5.json' })
            expect(fs.rmSync).toHaveBeenCalled()
        })

        it('should handle gpu-driver-outdated fix by disabling graphics mods', async () => {
            const ConfigManager = require('../../../../app/assets/js/core/configmanager')
            const mockModule = {
                rawModule: { name: 'Sodium', id: 'sodium' },
                getVersionlessMavenIdentifier: () => 'me.jellysquid.mods:sodium'
            }
            handler.server.modules = [mockModule]
            jest.spyOn(handler, 'restartGame').mockImplementation(() => {})

            await handler.handleCrashFix({ type: 'gpu-driver-outdated' })

            expect(ConfigManager.setModConfiguration).toHaveBeenCalledWith(
                'test',
                expect.objectContaining({
                    mods: {
                        'me.jellysquid.mods:sodium': { value: false }
                    }
                })
            )
            expect(ConfigManager.save).toHaveBeenCalled()
            expect(handler.restartGame).toHaveBeenCalled()
        })
    })

    describe('handleJavaRepair', () => {
        it('should remove managed java directory', () => {
            const ConfigManager = require('../../../../app/assets/js/core/configmanager')
            ConfigManager.getDataDirectory.mockReturnValue('/data')
            ConfigManager.getJavaExecutable.mockReturnValue('/data/runtime/x64/java-17/bin/java.exe')
            fs.existsSync.mockReturnValue(true)

            handler.handleJavaRepair()
            expect(fs.rmSync).toHaveBeenCalled()
        })
    })
})
