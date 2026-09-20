const path = require('path')
const os = require('os')

// We need to mock process.platform and process.arch, which is tricky in Jest.
// We'll use Object.defineProperty on process.

describe('LaunchArgumentBuilder Cross-Platform', () => {
    let LaunchArgumentBuilder
    let ConfigManager
    let MojangUtils
    
    const originalPlatform = process.platform
    const originalArch = process.arch

    beforeEach(() => {
        jest.resetModules()
        
        // Mock Dependencies
        jest.mock('../../../../app/assets/js/core/configmanager', () => ({
            getMaxRAM: jest.fn().mockReturnValue('2G'),
            getMinRAM: jest.fn().mockReturnValue('1G'),
            getJVMOptions: jest.fn().mockReturnValue([]),
            getGameWidth: jest.fn().mockReturnValue(800),
            getGameHeight: jest.fn().mockReturnValue(600),
            getFullscreen: jest.fn().mockReturnValue(false),
            getLaunchDetached: jest.fn().mockReturnValue(false)
        }))

        jest.mock('../../../../app/assets/js/core/util/LoggerUtil', () => ({
            LoggerUtil: {
                getLogger: jest.fn(() => ({
                    info: jest.fn(),
                    warn: jest.fn(),
                    error: jest.fn(),
                    debug: jest.fn()
                }))
            }
        }))

        LaunchArgumentBuilder = require('../../../../app/assets/js/core/game/LaunchArgumentBuilder')
        ConfigManager = require('../../../../app/assets/js/core/configmanager')
        MojangUtils = require('../../../../app/assets/js/core/common/MojangUtils')
    })

    afterAll(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
        Object.defineProperty(process, 'arch', { value: originalArch })
    })

    const mockServer = {
        rawServer: { id: 'test', minecraftVersion: '1.20.1' },
        hostname: 'localhost', port: 25565, modules: []
    }
    const mockVanilla = {
        id: '1.20.1', assets: '1.20', type: 'release',
        arguments: {
            jvm: [
                { rules: [{ action: 'allow', os: { name: 'osx' } }], value: '-XstartOnFirstThread' },
                '-Djava.library.path=${natives_directory}',
                '-cp', '${classpath}'
            ],
            game: ['--username', '${auth_player_name}']
        },
        libraries: []
    }
    const mockUser = { displayName: 'Player', uuid: '000', accessToken: 'abc', type: 'mojang' }

    test('MacOS ARM64 (M4) should include -XstartOnFirstThread and correct arch rules', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' })
        Object.defineProperty(process, 'arch', { value: 'arm64' })

        const builder = new LaunchArgumentBuilder(mockServer, mockVanilla, { arguments: { jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '], game: [] } }, mockUser, '1.0.0', '/game', '/common')
        builder.classpathArg = jest.fn().mockResolvedValue(['cp.jar'])

        const args = await builder.constructJVMArguments([], '/natives', false, false, null)
        
        expect(args).toContain('-XstartOnFirstThread')
        expect(args).toContain('-Djava.library.path=/natives')
        expect(args).toContain('-Djava.awt.headless=true')
        expect(args).toContain('-DFabricMcEmu=net.minecraft.client.main.Main')
    })

    test('Windows X64 should NOT include -XstartOnFirstThread', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' })
        Object.defineProperty(process, 'arch', { value: 'x64' })

        const builder = new LaunchArgumentBuilder(mockServer, mockVanilla, { arguments: { jvm: [], game: [] } }, mockUser, '1.0.0', '/game', '/common')
        builder.classpathArg = jest.fn().mockResolvedValue(['cp.jar'])

        const args = await builder.constructJVMArguments([], '/natives', false, false, null)
        
        expect(args).not.toContain('-XstartOnFirstThread')
        expect(args).toContain('-Djava.library.path=/natives')
    })

    test('Mojang Rule matching for aarch64 on arm64 macOS', () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' })
        Object.defineProperty(process, 'arch', { value: 'arm64' })

        const rules = [{ action: 'allow', os: { name: 'osx', arch: 'aarch64' } }]
        expect(MojangUtils.validateLibraryRules(rules)).toBe(true)
    })
})
