const path = require('path')

jest.mock('os', () => {
    const actualOs = jest.requireActual('os')
    return {
        ...actualOs,
        hostname: jest.fn().mockReturnValue('test-host'),
        totalmem: jest.fn().mockReturnValue(16 * 1024 * 1024 * 1024), // 16GB
        userInfo: jest.fn().mockReturnValue({ username: 'mock' }),
        platform: jest.fn().mockReturnValue('win32')
    }
})

// Mock fs
const mockFs = {
    mkdirSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(true),
    accessSync: jest.fn(),
    constants: { X_OK: 1 },
    promises: {
        rm: jest.fn().mockResolvedValue(),
    }
}
jest.mock('fs', () => mockFs)

// Mock child_process
const mockChild = {
    unref: jest.fn(),
    on: jest.fn(),
    stdout: { on: jest.fn(), setEncoding: jest.fn() },
    stderr: { on: jest.fn(), setEncoding: jest.fn() },
}
const mockSpawn = jest.fn().mockReturnValue(mockChild)
jest.mock('child_process', () => ({
    spawn: mockSpawn
}))

// Mock ConfigManager
jest.mock('../../../../../../app/assets/js/core/configmanager', () => ({
    getInstanceDirectorySync: jest.fn().mockReturnValue('/mock/instances'),
    getCommonDirectorySync: jest.fn().mockReturnValue('/mock/common'),
    getModConfiguration: jest.fn().mockReturnValue({ mods: {} }),
    getJavaExecutable: jest.fn().mockReturnValue('/mock/java'),
    getLaunchDetached: jest.fn().mockReturnValue(false),
    getTempNativeFolder: jest.fn().mockReturnValue('natives'),
}))

// Mock ModConfigResolver
jest.mock('../../../../../../app/assets/js/core/game/ModConfigResolver', () => {
    return jest.fn().mockImplementation(() => ({
        resolveModConfiguration: jest.fn().mockReturnValue({ fMods: [], lMods: [] }),
        constructJSONModList: jest.fn(),
        constructModList: jest.fn().mockReturnValue([]),
        _lteMinorVersion: jest.fn().mockReturnValue(false),
    }))
})

// Mock LaunchArgumentBuilder
jest.mock('../../../../../../app/assets/js/core/game/LaunchArgumentBuilder', () => {
    return jest.fn().mockImplementation(() => ({
        constructJVMArguments: jest.fn().mockResolvedValue(['-Xmx2G', 'main.class']),
    }))
})

// Mock GameCrashHandler
jest.mock('../../../../../../app/assets/js/core/game/GameCrashHandler', () => {
    return jest.fn().mockImplementation(() => ({
        handleExit: jest.fn(),
    }))
})

// Mock Logger
jest.mock('../../../../../../app/assets/js/core/util/LoggerUtil', () => ({
    LoggerUtil: {
        getLogger: () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        }),
    },
}))

const ProcessBuilder = require('../../../../../../app/assets/js/core/processbuilder')

describe('ProcessBuilder', () => {
    const mockDistro = {
        rawServer: { id: 'test-server', minecraftVersion: '1.12.2' },
        modules: []
    }
    const mockAuth = { uuid: 'uuid', accessToken: 'token', selectedProfile: { name: 'Player' } }
    
    let builder

    beforeEach(() => {
        jest.clearAllMocks()
        builder = new ProcessBuilder(mockDistro, {}, {}, mockAuth, '1.0.0')
    })

    it('should build the launch process for 1.12.2', async () => {
        const child = await builder.build()
        
        expect(mockFs.mkdirSync).toHaveBeenCalled()
        expect(mockSpawn).toHaveBeenCalledWith(
            '/mock/java',
            expect.arrayContaining(['-Xmx2G']),
            expect.objectContaining({ cwd: expect.any(String) })
        )
        expect(child).toBe(mockChild)
    })

    it('should build the launch process for 1.19 (Modern Forge)', async () => {
        mockDistro.rawServer.minecraftVersion = '1.19.2'
        builder = new ProcessBuilder(mockDistro, {}, {}, mockAuth, '1.0.0')
        
        await builder.build()
        
        expect(mockSpawn).toHaveBeenCalled()
    })

    it('should throw error if java path is invalid', async () => {
        const ConfigManager = require('../../../../../../app/assets/js/core/configmanager')
        ConfigManager.getJavaExecutable.mockReturnValueOnce(null)
        
        await expect(builder.build()).rejects.toThrow('Не удалось найти Java')
    })

    it('should normalize javaPath to use backslashes on Windows', async () => {
        const os = require('os')
        os.platform.mockReturnValue('win32')
        
        const ConfigManager = require('../../../../../../app/assets/js/core/configmanager')
        ConfigManager.getJavaExecutable.mockReturnValueOnce('C:/Users/Тестовый Юзер/AppData/Local/Java/javaw.exe')
        
        await builder.build()
        expect(mockSpawn).toHaveBeenCalledWith(
            'C:\\Users\\Тестовый Юзер\\AppData\\Local\\Java\\javaw.exe',
            expect.any(Array),
            expect.any(Object)
        )
    })

    it('should relativize absolute paths on win32', async () => {
        const os = require('os')
        os.platform.mockReturnValue('win32')

        const ConfigManager = require('../../../../../../app/assets/js/core/configmanager')
        ConfigManager.getInstanceDirectorySync.mockReturnValue('C:\\Users\\Тестовый Юзер\\instances')
        ConfigManager.getCommonDirectorySync.mockReturnValue('C:\\Users\\Тестовый Юзер\\common')

        builder = new ProcessBuilder(mockDistro, {}, {}, mockAuth, '1.0.0')

        // Mock constructJVMArguments to return absolute paths
        const mockArgs = [
            '-Djava.library.path=C:\\Users\\Тестовый Юзер\\instances\\test-server\\natives',
            '-cp',
            'C:\\Users\\Тестовый Юзер\\common\\libraries\\foo.jar;C:\\Users\\Тестовый Юзер\\instances\\test-server\\bar.jar',
            '@C:\\Users\\Тестовый Юзер\\instances\\test-server\\argfile',
            '--gameDir',
            'C:\\Users\\Тестовый Юзер\\instances\\test-server',
            '-Dfabric.addMods=C:\\Users\\Тестовый Юзер\\common\\mods\\sodium.jar'
        ]
        builder.argBuilder.constructJVMArguments = jest.fn().mockResolvedValueOnce(mockArgs)

        await builder.build()

        // Verify the arguments passed to spawn are relative
        const spawnCallArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1]
        
        expect(spawnCallArgs[0]).toBe('-Djava.library.path=natives')
        expect(spawnCallArgs[2]).toBe('..\\..\\common\\libraries\\foo.jar;bar.jar')
        expect(spawnCallArgs[3]).toBe('@argfile')
        expect(spawnCallArgs[4]).toBe('--gameDir')
        expect(spawnCallArgs[5]).toBe('.')
        expect(spawnCallArgs[6]).toBe('-Dfabric.addMods=..\\..\\common\\mods\\sodium.jar')
    })

    it('should handle process exit', async () => {
        const child = await builder.build()
        const closeHandler = mockChild.on.mock.calls.find(call => call[0] === 'close')[1]
        
        await closeHandler(0)
        expect(mockFs.promises.rm).toHaveBeenCalled()
    })
})
