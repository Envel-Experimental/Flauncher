const { HeliosDistribution, HeliosServer, HeliosModule, Type, Platform, JdkDistribution } = require('@app/assets/js/core/common/DistributionClasses')
const { MavenUtil } = require('@app/assets/js/core/common/MavenUtil')

describe('DistributionClasses', () => {
    const commonDir = 'common'
    const instanceDir = 'instances'

    describe('HeliosDistribution', () => {
        it('should resolve the main server correctly', () => {
            const rawDist = {
                servers: [
                    { id: 'server1', address: 'localhost', minecraftVersion: '1.12.2', mainServer: false, modules: [] },
                    { id: 'server2', address: 'localhost', minecraftVersion: '1.12.2', mainServer: true, modules: [] }
                ]
            }
            const dist = new HeliosDistribution(rawDist, commonDir, instanceDir)
            expect(dist.mainServerIndex).toBe(1)
            expect(dist.getMainServer().rawServer.id).toBe('server2')
        })

        it('should default to first server if no main server is specified', () => {
            const rawDist = {
                servers: [
                    { id: 'server1', address: 'localhost', minecraftVersion: '1.12.2', modules: [] },
                    { id: 'server2', address: 'localhost', minecraftVersion: '1.12.2', modules: [] }
                ]
            }
            const dist = new HeliosDistribution(rawDist, commonDir, instanceDir)
            expect(dist.mainServerIndex).toBe(0)
            expect(dist.getMainServer().rawServer.id).toBe('server1')
        })

        it('should get server by id', () => {
            const rawDist = {
                servers: [{ id: 'server1', address: 'localhost', minecraftVersion: '1.12.2', modules: [] }]
            }
            const dist = new HeliosDistribution(rawDist, commonDir, instanceDir)
            expect(dist.getServerById('server1').rawServer.id).toBe('server1')
            expect(dist.getServerById('nonexistent')).toBeNull()
        })
    })

    describe('HeliosServer', () => {
        const rawServer = {
            id: 'server1',
            address: 'localhost:25565',
            minecraftVersion: '1.12.2',
            modules: []
        }

        it('should parse address correctly', () => {
            const server = new HeliosServer(rawServer, commonDir, instanceDir)
            expect(server.hostname).toBe('localhost')
            expect(server.port).toBe(25565)
        })

        it('should use default port if not provided', () => {
            const server = new HeliosServer({ ...rawServer, address: 'localhost' }, commonDir, instanceDir)
            expect(server.port).toBe(25565)
        })

        it('should throw error for malformed port', () => {
            expect(() => new HeliosServer({ ...rawServer, address: 'localhost:abc' }, commonDir, instanceDir))
                .toThrow('Port must be an integer!')
        })

        it('should resolve default java version for < 1.16', () => {
            const server = new HeliosServer({ ...rawServer, minecraftVersion: '1.12.2' }, commonDir, instanceDir)
            expect(server.effectiveJavaOptions.suggestedMajor).toBe(8)
        })

        it('should resolve default java version for 1.17 to 1.20.4', () => {
            const server = new HeliosServer({ ...rawServer, minecraftVersion: '1.17.1' }, commonDir, instanceDir)
            expect(server.effectiveJavaOptions.suggestedMajor).toBe(17)
        })

        it('should resolve default java version for >= 1.20.5', () => {
            const server = new HeliosServer({ ...rawServer, minecraftVersion: '1.21' }, commonDir, instanceDir)
            expect(server.effectiveJavaOptions.suggestedMajor).toBe(21)
        })
    })

    describe('HeliosModule', () => {
        const rawModule = {
            name: 'Test Module',
            id: 'com.example:test:1.0.0',
            type: Type.Library,
            artifact: {
                size: 100,
                SHA1: 'hash'
            }
        }

        it('should resolve maven components', () => {
            const module = new HeliosModule(rawModule, 'server1', commonDir, instanceDir)
            expect(module.getMavenComponents().group).toBe('com.example')
            expect(module.getPath()).toContain('com/example/test/1.0.0/test-1.0.0.jar')
        })

        it('should respect required field', () => {
            const module = new HeliosModule({ ...rawModule, required: { value: false, def: false } }, 'server1', commonDir, instanceDir)
            expect(module.getRequired().value).toBe(false)
        })

        it('should resolve local path for different types', () => {
            const mod1 = new HeliosModule({ ...rawModule, type: Type.ForgeMod }, 'server1', commonDir, instanceDir)
            expect(mod1.getPath()).toContain('modstore')

            const mod2 = new HeliosModule({ ...rawModule, type: Type.FabricMod }, 'server1', commonDir, instanceDir)
            expect(mod2.getPath()).toContain('mods/fabric')
        })

        it('should handle submodules', () => {
            const module = new HeliosModule({
                ...rawModule,
                subModules: [rawModule]
            }, 'server1', commonDir, instanceDir)
            expect(module.hasSubModules()).toBe(true)
            expect(module.subModules).toHaveLength(1)
        })

        it('should throw error for non-maven id if required', () => {
            expect(() => new HeliosModule({ ...rawModule, id: 'invalid' }, 'server1', commonDir, instanceDir))
                .toThrow('must have a valid maven identifier!')
        })
    })
})
