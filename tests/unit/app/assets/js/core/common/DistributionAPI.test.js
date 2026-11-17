const path = require('path')

describe('DistributionAPI', () => {
    let DistributionAPI
    let distroApi
    let fsPromises
    let configmanager
    let SignatureUtils
    const launcherDir = '/launcher'
    const commonDir = '/common'
    const instanceDir = '/instance'
    const remoteUrls = ['http://mirror1.com/distro']

    beforeEach(() => {
        jest.resetModules()

        jest.doMock('fs/promises', () => ({
            mkdir: jest.fn().mockResolvedValue(undefined),
            writeFile: jest.fn().mockResolvedValue(undefined),
            readFile: jest.fn().mockResolvedValue('{}'),
            access: jest.fn().mockResolvedValue(undefined)
        }))

        jest.doMock('../../../../../../../app/assets/js/core/configmanager', () => ({
            fetchWithTimeout: jest.fn()
        }))

        jest.doMock('../../../../../../../app/assets/js/core/util/SignatureUtils', () => ({
            verifyDistribution: jest.fn().mockImplementation((params) => {
                if (process.type === 'renderer') {
                    return global.window.HeliosAPI.ipc.invoke('crypto:verifyDistribution', params)
                }
                return true
            })
        }))

        jest.doMock('../../../../../../../app/assets/js/core/common/DistributionClasses', () => ({
            HeliosDistribution: jest.fn().mockImplementation((data) => data)
        }))

        // Silence console
        jest.spyOn(console, 'log').mockImplementation(() => { })
        jest.spyOn(console, 'error').mockImplementation(() => { })
        jest.spyOn(console, 'warn').mockImplementation(() => { })

        DistributionAPI = require('../../../../../../../app/assets/js/core/common/DistributionAPI').DistributionAPI
        fsPromises = require('fs/promises')
        configmanager = require('../../../../../../../app/assets/js/core/configmanager')
        SignatureUtils = require('../../../../../../../app/assets/js/core/util/SignatureUtils')

        distroApi = new DistributionAPI(launcherDir, commonDir, instanceDir, remoteUrls, false)

        global.window = {
            HeliosAPI: {
                ipc: {
                    invoke: jest.fn()
                }
            },
            ipcRenderer: { // Keep for backward compatibility if needed by other parts
                invoke: jest.fn()
            }
        }
    })

    afterEach(() => {
        delete global.window
        jest.restoreAllMocks()
    })

    describe('Constructor and Basic Getters', () => {
        it('should initialize paths correctly', () => {
            expect(distroApi.distroPath).toBe(path.resolve(launcherDir, 'distribution.json'))
        })

        it('should handle single remote URL', () => {
            const api = new DistributionAPI(launcherDir, commonDir, instanceDir, 'http://single.com', false)
            expect(api.remoteUrls).toEqual(['http://single.com'])
        })
    })

    describe('getDistribution', () => {
        it('should cache distribution after first load', async () => {
            const mockData = { version: '1.0.0', servers: [] }
            jest.spyOn(distroApi, 'loadDistribution').mockResolvedValue(mockData)

            const d1 = await distroApi.getDistribution()
            const d2 = await distroApi.getDistribution()

            expect(distroApi.loadDistribution).toHaveBeenCalledTimes(1)
            expect(d1).toBe(d2)
        })

        it('should throw fatal error if local load fails in getDistributionLocalLoadOnly', async () => {
            jest.spyOn(distroApi, 'pullLocal').mockResolvedValue(null)
            await expect(distroApi.getDistributionLocalLoadOnly()).rejects.toThrow('FATAL: Unable to load distribution from local disk.')
        })

        it('should cache results in getDistributionLocalLoadOnly', async () => {
            jest.spyOn(distroApi, 'pullLocal').mockResolvedValue({ version: '1.0.0' })
            await distroApi.getDistributionLocalLoadOnly()
            await distroApi.getDistributionLocalLoadOnly()
            expect(distroApi.pullLocal).toHaveBeenCalledTimes(1)
        })

        it('should toggle dev mode', () => {
            distroApi.toggleDevMode(true)
            expect(distroApi.isDevMode()).toBe(true)
            distroApi.toggleDevMode(false)
            expect(distroApi.isDevMode()).toBe(false)
        })
    })

    describe('_loadDistributionNullable (Logic Branches)', () => {
        it('should handle production flow: remote newer', async () => {
            const local = { version: '1.0.0', timestamp: new Date(2020, 1, 1).toISOString() }
            const remote = { version: '1.1.0', timestamp: new Date(2021, 1, 1).toISOString() }

            jest.spyOn(distroApi, 'pullLocal').mockResolvedValue(local)
            jest.spyOn(distroApi, 'pullRemote').mockResolvedValue({ data: remote, responseStatus: 'SUCCESS' })
            jest.spyOn(distroApi, 'writeDistributionToDisk').mockResolvedValue()

            const distro = await distroApi._loadDistributionNullable()
            expect(distro.version).toBe('1.1.0')
        })

        it('should handle write error gracefully', async () => {
            jest.spyOn(distroApi, 'pullLocal').mockResolvedValue(null)
            jest.spyOn(distroApi, 'pullRemote').mockResolvedValue({ data: { version: '1.0.0' }, responseStatus: 'SUCCESS' })
            jest.spyOn(distroApi, 'writeDistributionToDisk').mockRejectedValue(new Error('disk full'))
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation()

            const res = await distroApi._loadDistributionNullable()
            expect(res.version).toEqual('1.0.0')
            expect(consoleSpy).toHaveBeenCalled()
            consoleSpy.mockRestore()
        })

        it('should handle production flow: remote fails, fallback to local', async () => {
            const local = { version: '1.0.0' }
            jest.spyOn(distroApi, 'pullLocal').mockResolvedValue(local)
            jest.spyOn(distroApi, 'pullRemote').mockResolvedValue({ data: null })

            const distro = await distroApi._loadDistributionNullable()
            expect(distro).toBe(local)
        })

        it('should handle devMode flow: fallback to production file', async () => {
            distroApi.devMode = true
            const prod = { version: 'prod' }

            jest.spyOn(distroApi, 'pullLocal').mockResolvedValue(null)
            jest.spyOn(distroApi, 'readDistributionFromFile').mockResolvedValue(prod)

            const distro = await distroApi._loadDistributionNullable()
            expect(distro).toBe(prod)
        })

        it('should handle devMode flow: all local files missing, fallback to remote', async () => {
            distroApi.devMode = true
            const remote = { version: 'remote-dev' }

            jest.spyOn(distroApi, 'pullLocal').mockResolvedValue(null)
            jest.spyOn(distroApi, 'readDistributionFromFile').mockResolvedValue(null)
            jest.spyOn(distroApi, 'pullRemote').mockResolvedValue({ data: remote })
            jest.spyOn(distroApi, 'writeDistributionToDisk').mockResolvedValue()

            const distro = await distroApi._loadDistributionNullable()
            expect(distro).toBe(remote)
        })
    })

    describe('refreshDistributionOrFallback', () => {
        it('should update distribution if refresh succeeds', async () => {
            const mockData = { version: '2.0.0' }
            jest.spyOn(distroApi, '_loadDistributionNullable').mockResolvedValue(mockData)
            const d = await distroApi.refreshDistributionOrFallback()
            expect(d.version).toBe('2.0.0')
        })

        it('should fallback to current distribution if refresh fails', async () => {
            distroApi.distribution = { version: 'current' }
            jest.spyOn(distroApi, '_loadDistributionNullable').mockResolvedValue(null)
            const d = await distroApi.refreshDistributionOrFallback()
            expect(d.version).toBe('current')
        })
    })

    describe('loadDistribution', () => {
        it('should throw fatal if _loadDistributionNullable returns null', async () => {
            jest.spyOn(distroApi, '_loadDistributionNullable').mockResolvedValue(null)
            await expect(distroApi.loadDistribution()).rejects.toThrow('FATAL: Unable to load distribution from remote server or local disk.')
        })
    })

    describe('pullRemote (Comprehensive)', () => {
        const mockData = { version: '1.0.0', servers: [], timestamp: '2023-01-01T00:00:00.000Z' }
        const jsonStr = JSON.stringify(mockData)
        const mockBuf = Buffer.from(jsonStr)

        beforeEach(() => {
            configmanager.fetchWithTimeout.mockImplementation(async (url) => {
                if (url.endsWith('.sig')) {
                    return { ok: true, text: async () => 'mock-sig', status: 200 }
                }
                return {
                    ok: true,
                    arrayBuffer: async () => {
                        const ab = new ArrayBuffer(mockBuf.length)
                        const view = new Uint8Array(ab)
                        for (let i = 0; i < mockBuf.length; i++) view[i] = mockBuf[i]
                        return ab
                    },
                    status: 200
                }
            })
        })

        it('should verify signature in Renderer process', async () => {
            process.type = 'renderer'
            distroApi.trustedKeys = ['key1']
            global.window.HeliosAPI.ipc.invoke.mockResolvedValue(true)

            const result = await distroApi.pullRemote()
            expect(result.signatureValid).toBe(true)
            delete process.type
        })

        it('should detect Anti-Replay attack', async () => {
            distroApi.trustedKeys = ['key1']
            const localTimestamp = new Date('2024-01-01').getTime()

            const result = await distroApi.pullRemote(localTimestamp)
            expect(result.responseStatus).toBe('ERROR')
            expect(result.error.message).toBe('Distribution replay attack detected (downgrade attempt).')
        })

        it('should fail if signature is invalid', async () => {
            process.type = 'renderer'
            distroApi.trustedKeys = ['key1']
            configmanager.fetchWithTimeout.mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(Buffer.from(JSON.stringify(mockData))) })
            configmanager.fetchWithTimeout.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('bad-sig'), status: 200 })
            
            global.window.HeliosAPI.ipc.invoke.mockResolvedValue(false)
            const result = await distroApi.pullRemote()
            expect(result.responseStatus).toBe('ERROR')
            expect(result.error.message).toBe('Distribution signature verification failed.')
            delete process.type
        })

        it('should handle missing signature file', async () => {
            process.type = 'renderer'
            distroApi.trustedKeys = ['key1']
            configmanager.fetchWithTimeout.mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(Buffer.from(JSON.stringify(mockData))) })
            configmanager.fetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 404 })
            
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
            const result = await distroApi.pullRemote()
            expect(result.responseStatus).toBe('ERROR')
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Signature file missing'))
            consoleSpy.mockRestore()
            delete process.type
        })

        it('should handle signature verification error', async () => {
            process.type = 'renderer'
            distroApi.trustedKeys = ['key1']
            configmanager.fetchWithTimeout.mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(Buffer.from(JSON.stringify(mockData))) })
            configmanager.fetchWithTimeout.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('sig'), status: 200 })
            global.window.HeliosAPI.ipc.invoke.mockRejectedValue(new Error('IPC crash'))
            
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation()
            const result = await distroApi.pullRemote()
            expect(result.responseStatus).toBe('ERROR')
            warnSpy.mockRestore()
            delete process.type
        })

        it('should choose the mirror with newest timestamp and lowest latency', async () => {
            const olderDistro = { version: '1.0.0', servers: [], timestamp: '2026-09-01T00:00:00.000Z' }
            const newerDistro = { version: '1.0.0', servers: [], timestamp: '2026-11-16T12:00:00.000Z' }

            const multiApi = new DistributionAPI('/launcher', '/common', '/instance', [
                'http://fast-stale.com/distro',
                'http://slow-fresh.com/distro'
            ], false, [])

            configmanager.fetchWithTimeout.mockImplementation(async (url) => {
                if (url.includes('fast-stale')) {
                    return {
                        ok: true,
                        arrayBuffer: async () => Buffer.from(JSON.stringify(olderDistro)),
                        status: 200
                    }
                }
                return {
                    ok: true,
                    arrayBuffer: async () => Buffer.from(JSON.stringify(newerDistro)),
                    status: 200
                }
            })

            const result = await multiApi.pullRemote()
            expect(result.responseStatus).toBe('SUCCESS')
            expect(result.url).toBe('http://slow-fresh.com/distro')
            expect(result.data.timestamp).toBe('2026-11-16T12:00:00.000Z')
        })
    })

    describe('File I/O and JSON Handling', () => {
        it('should write distribution to disk and create dir', async () => {
            const mockDistro = { version: '1.0.0' }
            await distroApi.writeDistributionToDisk(mockDistro)
            expect(fsPromises.mkdir).toHaveBeenCalledWith(launcherDir, { recursive: true })
            expect(fsPromises.writeFile).toHaveBeenCalledWith(distroApi.distroPath, expect.any(String))
        })

        it('should return null if file is malformed JSON', async () => {
            fsPromises.access.mockResolvedValue(undefined)
            fsPromises.readFile.mockResolvedValue('not json')

            const result = await distroApi.readDistributionFromFile('any.json')
            expect(result).toBeNull()
        })

        it('should return null if file does not exist', async () => {
            fsPromises.access.mockRejectedValue(new Error('ENOENT'))

            const result = await distroApi.readDistributionFromFile('any.json')
            expect(result).toBeNull()
        })
    })
})
