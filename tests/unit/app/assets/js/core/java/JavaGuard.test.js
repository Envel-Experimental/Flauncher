const { latestOpenJDK } = require('@app/assets/js/core/java/JavaGuard')

// Mock Dependencies
jest.mock('@app/assets/js/core/java/JavaUtils', () => ({
    Platform: { WIN32: 'win32', DARWIN: 'darwin', LINUX: 'linux' },
    javaExecFromRoot: jest.fn(p => p),
    ensureJavaDirIsRoot: jest.fn(p => p),
    resolveNativeArch: jest.fn(() => 'x64')
}))

jest.mock('@network/config', () => ({
    MOJANG_MIRRORS: [],
    DISTRO_PUB_KEYS: ['test-public-key']
}))

jest.mock('@app/assets/js/core/util/LoggerUtil', () => ({
    LoggerUtil: {
        getLogger: jest.fn(() => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn()
        }))
    }
}))

jest.mock('@app/assets/js/core/dl/Asset', () => ({
    HashAlgo: { SHA1: 'sha1', SHA256: 'sha256' }
}))

jest.mock('@app/assets/js/core/common/DistributionClasses', () => ({
    JdkDistribution: { TEMURIN: 'temurin', CORRETTO: 'corretto' }
}))

jest.mock('@app/assets/js/core/util/SignatureUtils', () => ({
    verifyDistribution: jest.fn()
}))

describe('JavaGuard', () => {
    const originalPlatform = process.platform

    beforeEach(() => {
        jest.resetModules()
        jest.clearAllMocks()
        global.fetch = jest.fn()
        Object.defineProperty(process, 'platform', { value: 'win32' })
        Object.defineProperty(process, 'arch', { value: 'x64' })
    })

    afterAll(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    it('should prioritize signed mirrors over official sources', async () => {
        const mirrorUrl = 'https://mirror.test/java/manifest.json'
        const sigUrl = mirrorUrl + '.sig'
        require('@network/config').MOJANG_MIRRORS = [{
            name: 'Test Mirror',
            java_manifest: mirrorUrl
        }]
        
        const { verifyDistribution } = require('@app/assets/js/core/util/SignatureUtils')
        verifyDistribution.mockReturnValue(true) // Valid signature

        global.fetch = jest.fn((url) => {
            if (url === mirrorUrl) {
                const data = { windows: { x64: { "21": { url: 'https://test.mirror/j21.zip', size: 100, name: 'j21.zip', sha1: 'h' } } } }
                return Promise.resolve({
                    ok: true,
                    arrayBuffer: async () => Buffer.from(JSON.stringify(data)),
                    json: async () => data
                })
            }
            if (url === sigUrl) {
                return Promise.resolve({ ok: true, text: async () => 'valid-sig-hex' })
            }
            return Promise.resolve({ ok: false })
        })

        const { latestOpenJDK } = require('@app/assets/js/core/java/JavaGuard')
        const result = await latestOpenJDK(21, 'dataDir', null)

        expect(result.url).toBe('https://test.mirror/j21.zip')
        expect(verifyDistribution).toHaveBeenCalled()
    })

    it('should REJECT mirrors with invalid signatures', async () => {
        const mirrorUrl = 'https://mirror.test/java/manifest.json'
        const sigUrl = mirrorUrl + '.sig'
        require('@network/config').MOJANG_MIRRORS = [{
            name: 'Malicious Mirror',
            java_manifest: mirrorUrl
        }]
        
        const { verifyDistribution } = require('@app/assets/js/core/util/SignatureUtils')
        verifyDistribution.mockReturnValue(false) // INVALID signature

        global.fetch = jest.fn((url) => {
            if (url === mirrorUrl) {
                const data = { windows: { x64: { "21": { url: 'https://malicious.mirror/j21.zip', size: 100, name: 'j21.zip', sha1: 'h' } } } }
                return Promise.resolve({
                    ok: true,
                    arrayBuffer: async () => Buffer.from(JSON.stringify(data)),
                    json: async () => data
                })
            }
            if (url === sigUrl) {
                return Promise.resolve({ ok: true, text: async () => 'fake-sig-hex' })
            }
            // Mock Adoptium fallback to return null so we can verify the mirror was rejected
            if (url.includes('adoptium.net')) {
                 return Promise.resolve({ ok: true, json: async () => [] })
            }
            return Promise.resolve({ ok: false })
        })

        const { latestOpenJDK } = require('@app/assets/js/core/java/JavaGuard')
        const result = await latestOpenJDK(21, 'dataDir', null)

        expect(result).toBeNull() // Rejected due to signature failure
        expect(verifyDistribution).toHaveBeenCalled()
    })

    it('should fallback to official sources if mirror fails', async () => {
        const mirrorUrl = 'https://mirror.test/java/manifest.json'
        require('@network/config').MOJANG_MIRRORS = [{
            name: 'Test Mirror',
            java_manifest: mirrorUrl
        }]

        global.fetch = jest.fn((url) => {
            if (url === mirrorUrl) return Promise.resolve({ ok: false })
            if (url.includes('api.adoptium.net')) {
                const data = [{ version: { major: 21 }, binary: { os: 'windows', image_type: 'jdk', architecture: 'x64', package: { link: 'https://adoptium.net/jdk21.zip', size: 200, name: 'jdk21.zip', checksum: 'hash256' } } }]
                return Promise.resolve({ ok: true, json: async () => data })
            }
            return Promise.resolve({ ok: false })
        })

        const { latestOpenJDK } = require('@app/assets/js/core/java/JavaGuard')
        const result = await latestOpenJDK(21, 'dataDir', null)

        expect(result.url).toBe('https://adoptium.net/jdk21.zip')
    })

    it('should use relUrl when provided to support dual distribution and relative paths', async () => {
        const mirrorUrl = 'https://s3.custom.mirror/java/manifest.json'
        const sigUrl = mirrorUrl + '.sig'
        require('@network/config').MOJANG_MIRRORS = [{
            name: 'Dual Support Mirror',
            java_manifest: mirrorUrl
        }]
        
        const { verifyDistribution } = require('@app/assets/js/core/util/SignatureUtils')
        verifyDistribution.mockReturnValue(true) // Valid signature

        global.fetch = jest.fn((url) => {
            if (url === mirrorUrl) {
                const data = { windows: { x64: { "21": { url: 'https://ignored.url/j21.zip', relUrl: 'archives/jdk-21.zip', size: 100, name: 'j21.zip', sha1: 'h' } } } }
                return Promise.resolve({
                    ok: true,
                    arrayBuffer: async () => Buffer.from(JSON.stringify(data)),
                    json: async () => data
                })
            }
            if (url === sigUrl) {
                return Promise.resolve({ ok: true, text: async () => 'valid-sig-hex' })
            }
            return Promise.resolve({ ok: false })
        })

        const { latestOpenJDK } = require('@app/assets/js/core/java/JavaGuard')
        const result = await latestOpenJDK(21, 'dataDir', null)

        expect(result.url).toBe('https://s3.custom.mirror/java/archives/jdk-21.zip')
    })

    it('should correctly handle slashes when joining mirror base and relUrl', async () => {
        const mirrorUrl = 'https://s3.custom.mirror/java-path/manifest.json'
        const sigUrl = mirrorUrl + '.sig'
        require('@network/config').MOJANG_MIRRORS = [{
            name: 'Dual Support Mirror 2',
            java_manifest: mirrorUrl
        }]
        
        const { verifyDistribution } = require('@app/assets/js/core/util/SignatureUtils')
        verifyDistribution.mockReturnValue(true)

        global.fetch = jest.fn((url) => {
            if (url === mirrorUrl) {
                // relUrl has a leading slash
                const data = { windows: { x64: { "21": { url: 'old', relUrl: '/archives/jdk-21.zip', size: 100, name: 'j', sha1: 'h' } } } }
                return Promise.resolve({
                    ok: true,
                    arrayBuffer: async () => Buffer.from(JSON.stringify(data)),
                    json: async () => data
                })
            }
            if (url === sigUrl) {
                return Promise.resolve({ ok: true, text: async () => 'valid-sig-hex' })
            }
            return Promise.resolve({ ok: false })
        })

        const { latestOpenJDK } = require('@app/assets/js/core/java/JavaGuard')
        const result = await latestOpenJDK(21, 'dataDir', null)

        // base is https://s3.custom.mirror/java-path (no trailing slash)
        // relUrl is /archives/jdk-21.zip (leading slash)
        // Result must have exactly one slash between them
        expect(result.url).toBe('https://s3.custom.mirror/java-path/archives/jdk-21.zip')
    })
})
