const path = require('path')

describe('LaunchArgumentBuilder Detailed Tests', () => {
    let LaunchArgumentBuilder
    let ConfigManager
    let MojangUtils
    let FileUtils
    let fs

    beforeEach(() => {
        jest.resetModules()

        // Mock Dependencies
        jest.doMock('fs/promises', () => ({
            mkdir: jest.fn().mockResolvedValue(),
            rm: jest.fn().mockResolvedValue()
        }))

        jest.doMock('@common/FileUtils', () => ({
            extractZip: jest.fn().mockResolvedValue()
        }))

        jest.doMock('@common/MojangUtils', () => ({
            getMojangOS: jest.fn().mockReturnValue('windows'),
            isLibraryCompatible: jest.fn().mockReturnValue(true),
            mcVersionAtLeast: jest.fn()
        }))

        jest.doMock('@core/configmanager', () => ({
            getMaxRAM: jest.fn().mockReturnValue('4G'),
            getMinRAM: jest.fn().mockReturnValue('1G'),
            getJVMOptions: jest.fn().mockReturnValue(['-XX:+UseG1GC']),
            getGameWidth: jest.fn().mockReturnValue(854),
            getGameHeight: jest.fn().mockReturnValue(480),
            getFullscreen: jest.fn().mockReturnValue(false),
            getMacOSCompatibility: jest.fn().mockReturnValue(false)
        }))

        jest.doMock('@core/util/LoggerUtil', () => ({
            LoggerUtil: {
                getLogger: jest.fn(() => ({
                    info: jest.fn(),
                    warn: jest.fn(),
                    error: jest.fn(),
                    debug: jest.fn()
                }))
            }
        }))

        jest.doMock('p-limit', () => ({
            default: jest.fn((limit) => (fn) => fn())
        }))

        LaunchArgumentBuilder = require('@core/game/LaunchArgumentBuilder')
        ConfigManager = require('@core/configmanager')
        MojangUtils = require('@common/MojangUtils')
        FileUtils = require('@common/FileUtils')
        fs = require('fs/promises')
    })

    const mockServer = {
        rawServer: { id: 'test-server', minecraftVersion: '1.20.1' },
        hostname: 'play.server.com',
        port: 25565,
        modules: []
    }

    const mockVanilla = {
        id: '1.20.1',
        type: 'release',
        assets: '1.20',
        arguments: {
            jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
            game: ['--username', '${auth_player_name}']
        },
        libraries: []
    }

    const mockMod = {
        id: 'forge-1.20.1',
        mainClass: 'net.minecraft.launchwrapper.Launch',
        arguments: { jvm: [], game: [] }
    }

    const mockUser = {
        displayName: 'Player',
        uuid: '0000',
        accessToken: 'token',
        type: 'mojang'
    }

    test('getClasspathSeparator should return correct separator for OS', () => {
        const originalPlatform = process.platform
        
        Object.defineProperty(process, 'platform', { value: 'win32' })
        expect(LaunchArgumentBuilder.getClasspathSeparator()).toBe(';')

        Object.defineProperty(process, 'platform', { value: 'linux' })
        expect(LaunchArgumentBuilder.getClasspathSeparator()).toBe(':')

        Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    test('_constructJVMArguments113 should replace placeholders', async () => {
        MojangUtils.mcVersionAtLeast.mockReturnValue(true)
        const builder = new LaunchArgumentBuilder(mockServer, mockVanilla, mockMod, mockUser, '1.0.0', '/game', '/common')
        
        // Mock classpathArg to avoid library resolution
        jest.spyOn(builder, 'classpathArg').mockResolvedValue(['cp1.jar', 'cp2.jar'])

        const args = await builder._constructJVMArguments113([], '/natives', false)

        expect(args).toContain('Player')
        expect(args).toContain('-Djava.library.path=/natives')
        const sep = process.platform === 'win32' ? ';' : ':'
        expect(args).toContain(`cp1.jar${sep}cp2.jar`)
    })

    test('_resolveSanitizedJMArgs should remove forbidden flags and add G1GC', () => {
        const builder = new LaunchArgumentBuilder(mockServer, mockVanilla, mockMod, mockUser, '1.0.0', '/game', '/common')
        ConfigManager.getJVMOptions.mockReturnValue(['-XX:+UseConcMarkSweepGC', '-Xmx2G'])

        const sanitized = builder._resolveSanitizedJMArgs([])
        
        expect(sanitized).not.toContain('-XX:+UseConcMarkSweepGC')
        expect(sanitized).toContain('-XX:+UseG1GC')
        expect(sanitized).toContain('-Xmx2G')
    })

})

