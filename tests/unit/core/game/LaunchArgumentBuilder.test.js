// Mock dependencies at the very top
jest.mock('../../../../app/assets/js/core/common/MojangUtils', () => ({
    getMojangOS: jest.fn().mockReturnValue('windows'),
    isLibraryCompatible: jest.fn().mockReturnValue(true),
    mcVersionAtLeast: jest.fn().mockReturnValue(true)
}))

jest.mock('../../../../app/assets/js/core/configmanager', () => ({
    getMaxRAM: jest.fn().mockReturnValue('4G'),
    getMinRAM: jest.fn().mockReturnValue('1G'),
    getJVMOptions: jest.fn().mockReturnValue([]),
    getGameWidth: jest.fn().mockReturnValue(800),
    getGameHeight: jest.fn().mockReturnValue(600),
    getFullscreen: jest.fn().mockReturnValue(false)
}))

jest.mock('../../../../app/assets/js/core/util/LoggerUtil', () => ({
    LoggerUtil: {
        getLogger: jest.fn().mockReturnValue({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        })
    }
}))

const LaunchArgumentBuilder = require('../../../../app/assets/js/core/game/LaunchArgumentBuilder')
const MojangUtils = require('../../../../app/assets/js/core/common/MojangUtils')
const path = require('path')

describe('LaunchArgumentBuilder', () => {
    const server = {
        rawServer: { id: 'test', minecraftVersion: '1.16.5' },
        hostname: 'play.test.com',
        port: 25565,
        modules: []
    }
    const vanillaManifest = {
        id: '1.16.5',
        assets: '1.16',
        type: 'release',
        arguments: {
            jvm: ['-Djava.library.path=${natives_directory}'],
            game: ['--username', '${auth_player_name}']
        },
        libraries: []
    }
    const modManifest = {
        id: 'forge-test',
        mainClass: 'net.minecraft.launchwrapper.Launch',
        arguments: { jvm: [], game: [] }
    }
    const authUser = {
        displayName: 'Player',
        uuid: 'uuid-123',
        accessToken: 'token-abc',
        type: 'microsoft'
    }

    let builder
    const gameDir = '/game'
    const commonDir = '/common'

    beforeEach(() => {
        jest.clearAllMocks()
        builder = new LaunchArgumentBuilder(server, vanillaManifest, modManifest, authUser, '1.0.0', gameDir, commonDir)
        // Bypass p-limit ESM import
        builder._resolveMojangLibraries = jest.fn().mockResolvedValue({})
    })

    describe('getClasspathSeparator', () => {
        it('should return ; on windows', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' })
            expect(LaunchArgumentBuilder.getClasspathSeparator()).toBe(';')
        })

        it('should return : on linux', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' })
            expect(LaunchArgumentBuilder.getClasspathSeparator()).toBe(':')
        })
    })

    describe('constructJVMArguments', () => {
        it('should handle 1.13+ arguments', async () => {
            MojangUtils.mcVersionAtLeast.mockReturnValue(true)
            const args = await builder.constructJVMArguments([], '/natives', false, false, null)
            expect(args).toContain('-Djava.library.path=/natives')
            expect(args).toContain('Player')
        })
    })



    describe('classpathArg', () => {
        it('should include version jar for older versions', async () => {
            MojangUtils.mcVersionAtLeast.mockReturnValue(false)
            const cp = await builder.classpathArg([], '/natives', false, null, false)
            expect(cp[0]).toContain('1.16.5.jar')
        })

        it('should ensure all paths use system separators on Windows', async () => {
            const originalPlatform = process.platform
            Object.defineProperty(process, 'platform', { value: 'win32' })
            
            builder._resolveServerLibraries = jest.fn().mockReturnValue({
                'some-library': 'C:/Users/Тестовый Юзер/AppData/Roaming/.foxford/library.jar'
            })
            
            const cp = await builder.classpathArg([], '/natives', false, null, false)
            
            // Check that all paths have no forward slashes (meaning they were normalized to backslashes)
            const hasForwardSlashes = cp.some(p => p.includes('/'))
            expect(hasForwardSlashes).toBe(false)
            
            // Ensure Cyrillic characters and spaces are preserved
            const targetPath = cp.find(p => p.includes('Тестовый Юзер'))
            expect(targetPath).toBeDefined()
            expect(targetPath).toBe('C:\\Users\\Тестовый Юзер\\AppData\\Roaming\\.foxford\\library.jar')
            
            Object.defineProperty(process, 'platform', { value: originalPlatform })
        })
    })
})
