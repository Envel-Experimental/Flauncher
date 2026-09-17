const path = require('path')

describe('LaunchArgumentBuilder', () => {
    let LaunchArgumentBuilder
    let ConfigManager
    const Type = {
        Library: 'Library',
        Forge: 'Forge',
        ForgeHosted: 'ForgeHosted',
        Fabric: 'Fabric',
        LiteLoader: 'LiteLoader'
    }
    
    const mockAuthUser = {
        displayName: 'TestPlayer',
        uuid: 'uuid-123',
        accessToken: 'token-abc',
        type: 'mojang'
    }

    const mockServer = {
        rawServer: {
            id: 'testServer',
            minecraftVersion: '1.20.1'
        },
        hostname: 'localhost',
        port: 25565,
        modules: []
    }

    const vanillaManifest113 = {
        id: '1.20.1',
        assets: '1.20',
        type: 'release',
        libraries: [],
        arguments: {
            jvm: [
                '-Djava.library.path=${natives_directory}',
                {
                    rules: [{ action: 'allow', os: { name: 'windows' } }],
                    value: '-Dtest.os.flag=true'
                }
            ],
            game: [
                '--username', '${auth_player_name}',
                '--version', '${version_name}',
                '--gameDir', '${game_directory}',
                '--assetsDir', '${assets_root}'
            ]
        }
    }

    const modManifest113 = {
        id: 'forge-1.20.1',
        mainClass: 'net.minecraft.boot.Main',
        arguments: {
            jvm: ['-Dforge.logging.level=debug'],
            game: ['--forge-arg']
        }
    }

    beforeEach(() => {
        jest.resetModules()
        
        jest.mock('../../../../../../../app/assets/js/core/configmanager', () => ({
            getMaxRAM: jest.fn().mockReturnValue('2G'),
            getMinRAM: jest.fn().mockReturnValue('1G'),
            getJVMOptions: jest.fn().mockReturnValue([]),
            getGameWidth: jest.fn().mockReturnValue(800),
            getGameHeight: jest.fn().mockReturnValue(600),
            getFullscreen: jest.fn().mockReturnValue(false),
            getLaunchDetached: jest.fn().mockReturnValue(false),
            getMacOSCompatibility: jest.fn().mockReturnValue(false)
        }))
        
        jest.mock('../../../../../../../app/assets/js/core/common/FileUtils', () => ({
            extractZip: jest.fn().mockResolvedValue()
        }))

        jest.mock('../../../../../../../app/assets/js/core/common/MojangUtils', () => ({
            getMojangOS: jest.fn().mockReturnValue('windows'),
            isLibraryCompatible: jest.fn().mockReturnValue(true),
            mcVersionAtLeast: jest.fn((ver, current) => {
                const v1 = ver.split('.').map(Number)
                const v2 = (current || '0.0.0').split('.').map(Number)
                for(let i=0; i<Math.max(v1.length, v2.length); i++) {
                    const n1 = v1[i] || 0
                    const n2 = v2[i] || 0
                    if (n2 > n1) return true
                    if (n2 < n1) return false
                }
                return true
            })
        }))
        
        jest.mock('fs/promises', () => ({
            mkdir: jest.fn().mockResolvedValue(),
            rm: jest.fn().mockResolvedValue(),
            readdir: jest.fn().mockResolvedValue([])
        }))

        jest.mock('../../../../../../../app/assets/js/core/util/LoggerUtil', () => ({
            LoggerUtil: {
                getLogger: jest.fn(() => ({
                    debug: jest.fn(),
                    info: jest.fn(),
                    warn: jest.fn(),
                    error: jest.fn()
                }))
            }
        }))

        LaunchArgumentBuilder = require('../../../../../../../app/assets/js/core/game/LaunchArgumentBuilder')
        ConfigManager = require('../../../../../../../app/assets/js/core/configmanager')
    })

    describe('constructJVMArguments (1.13+)', () => {
        it('should build modern arguments and replace placeholders', async () => {
            const builder = new LaunchArgumentBuilder(
                mockServer, 
                vanillaManifest113, 
                modManifest113, 
                mockAuthUser, 
                '1.0.0', 
                'gameDir', 
                'commonDir'
            )
            builder.classpathArg = jest.fn().mockResolvedValue(['lib.jar'])

            const args = await builder.constructJVMArguments([], 'nativesDir', false, false, null)

            expect(args).toContain('-Djava.library.path=nativesDir')
            expect(args).toContain('-Dtest.os.flag=true')
            expect(args).toContain('--username')
            expect(args).toContain('TestPlayer')
        })

        it('should handle OS rules in JVM arguments', async () => {
            const MojangUtils = require('../../../../../../../app/assets/js/core/common/MojangUtils')
            MojangUtils.getMojangOS.mockReturnValue('linux')

            const builder = new LaunchArgumentBuilder(
                mockServer, 
                vanillaManifest113, 
                modManifest113, 
                mockAuthUser, 
                '1.0.0', 
                'gameDir', 
                'commonDir'
            )
            builder.classpathArg = jest.fn().mockResolvedValue(['lib.jar'])

            const args = await builder.constructJVMArguments([], 'nativesDir', false, false, null)

            expect(args).not.toContain('-Dtest.os.flag=true')
        })
    })

    describe('Server Library Resolution', () => {
        it('should resolve libraries from server modules and submodules', () => {
            const mockModule = {
                rawModule: { type: Type.Library },
                getVersionlessMavenIdentifier: jest.fn().mockReturnValue('lib1'),
                getPath: jest.fn().mockReturnValue('path/to/lib1.jar'),
                subModules: [
                    {
                        rawModule: { type: Type.Library },
                        getVersionlessMavenIdentifier: jest.fn().mockReturnValue('lib1-sub'),
                        getPath: jest.fn().mockReturnValue('path/to/lib1-sub.jar'),
                        subModules: []
                    }
                ]
            }
            const builder = new LaunchArgumentBuilder(
                { modules: [mockModule], rawServer: { id: 'test' } },
                {}, {}, mockAuthUser, '1.0.0', 'game', 'common'
            )

            const libs = builder._resolveServerLibraries([])
            expect(libs['lib1']).toBe('path/to/lib1.jar')
            expect(libs['lib1-sub']).toBe('path/to/lib1-sub.jar')
        })
    })

    describe('_resolveMojangLibraries', () => {
        it('should correctly process library extraction loop', async () => {
            const vanillaManifest = {
                libraries: [
                    {
                        name: 'com.mojang:authlib:4.0.43',
                        downloads: { artifact: { path: 'com/mojang/authlib/4.0.43/authlib-4.0.43.jar' } }
                    },
                    {
                        name: 'org.lwjgl:lwjgl:3.3.1:natives-windows',
                        rules: [{ action: 'allow', os: { name: 'windows' } }],
                        natives: { windows: 'natives-windows' },
                        downloads: { classifiers: { 'natives-windows': { path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar' } } }
                    }
                ]
            }
            const builder = new LaunchArgumentBuilder(mockServer, vanillaManifest, {}, mockAuthUser, '1.0.0', 'game', 'common')
            
            // Mock native extraction to avoid real FS zip operations but keep the loop logic
            builder._extractNative = jest.fn().mockResolvedValue(['META-INF/'])
            
            const libs = await builder._resolveMojangLibraries('tempNatives')
            
            expect(libs['com.mojang:authlib']).toBeDefined()
            expect(builder._extractNative).toHaveBeenCalled()
        })
    })
})
