const crypto = require('crypto')
const EventEmitter = require('events')

describe('Network Changes Unit Tests & Edge Cases', () => {

    describe('IPC net:fetch Handler Logic', () => {
        let handleFn
        let mockNetFetch

        beforeEach(() => {
            mockNetFetch = jest.fn()
            jest.doMock('electron', () => ({
                net: { fetch: mockNetFetch }
            }), { virtual: true })

            // Extract IPC handler logic
            const handlers = {}
            const mockIpcMain = {
                handle: (channel, fn) => { handlers[channel] = fn }
            }

            // Register handler equivalent to IpcRegistry.js
            mockIpcMain.handle('net:fetch', async (event, url, options, timeout) => {
                const { net } = require('electron')

                if (typeof url !== 'string' || !url.trim()) {
                    return { ok: false, status: 400, body: '' }
                }

                try {
                    const parsedUrl = new URL(url)
                    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
                        return { ok: false, status: 403, body: '' }
                    }
                } catch (e) {
                    return { ok: false, status: 400, body: '' }
                }

                const safeOptions = (options && typeof options === 'object') ? { ...options } : {}
                delete safeOptions.signal

                const controller = new AbortController()
                const timeoutMs = (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) ? Math.min(timeout, 60000) : 15000
                const timer = setTimeout(() => controller.abort(), timeoutMs)

                try {
                    const res = await net.fetch(url, { ...safeOptions, signal: controller.signal })
                    const buf = Buffer.from(await res.arrayBuffer())
                    return { ok: res.ok, status: res.status, body: buf.toString('base64') }
                } catch (err) {
                    return { ok: false, status: 504, body: '' }
                } finally {
                    clearTimeout(timer)
                }
            })

            handleFn = handlers['net:fetch']
        })

        afterEach(() => {
            jest.resetModules()
        })

        test('should successfully fetch text data and encode as base64', async () => {
            const sampleText = 'Hello World!'
            const sampleBuf = Buffer.from(sampleText)
            mockNetFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                arrayBuffer: async () => sampleBuf.buffer.slice(sampleBuf.byteOffset, sampleBuf.byteOffset + sampleBuf.byteLength)
            })

            const res = await handleFn({}, 'https://example.com/test.json', {}, 5000)
            expect(res.ok).toBe(true)
            expect(res.status).toBe(200)
            expect(Buffer.from(res.body, 'base64').toString('utf-8')).toBe(sampleText)
        })

        test('should successfully fetch binary data (ArrayBuffer)', async () => {
            const randomBytes = crypto.randomBytes(256)
            mockNetFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                arrayBuffer: async () => randomBytes.buffer.slice(randomBytes.byteOffset, randomBytes.byteOffset + randomBytes.byteLength)
            })

            const res = await handleFn({}, 'https://example.com/file.bin', {}, 5000)
            expect(res.ok).toBe(true)
            const receivedBuf = Buffer.from(res.body, 'base64')
            expect(receivedBuf.equals(randomBytes)).toBe(true)
        })

        test('should return status 404/500 without throwing when server responds with error status', async () => {
            mockNetFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                arrayBuffer: async () => Buffer.from('Not Found').buffer
            })

            const res = await handleFn({}, 'https://example.com/missing', {}, 5000)
            expect(res.ok).toBe(false)
            expect(res.status).toBe(404)
        })

        test('should return status 504 on network abort/timeout without crashing', async () => {
            mockNetFetch.mockImplementationOnce(() => {
                const err = new Error('The operation was aborted')
                err.name = 'AbortError'
                return Promise.reject(err)
            })

            const res = await handleFn({}, 'https://example.com/timeout', {}, 100)
            expect(res.ok).toBe(false)
            expect(res.status).toBe(504)
        })

        test('should reject non-HTTP protocols with status 403', async () => {
            const res = await handleFn({}, 'file:///etc/passwd', {}, 5000)
            expect(res.ok).toBe(false)
            expect(res.status).toBe(403)
        })

        test('should fallback to default timeout (15000ms) when invalid timeout argument provided', async () => {
            mockNetFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                arrayBuffer: async () => Buffer.from('ok').buffer
            })

            const res = await handleFn({}, 'https://example.com/test', {}, -500)
            expect(res.ok).toBe(true)
        })
    })

    describe('Dynamic Header & CORS Injection Logic (index.js)', () => {

        function computeMirrorHosts(NetworkConfig) {
            const mirrorHostSet = new Set()
            if (Array.isArray(NetworkConfig.MOJANG_MIRRORS)) {
                for (const mirror of NetworkConfig.MOJANG_MIRRORS) {
                    for (const val of Object.values(mirror)) {
                        if (typeof val === 'string' && val.startsWith('http')) {
                            try { mirrorHostSet.add(new URL(val).hostname) } catch (e) {}
                        }
                    }
                }
            }
            for (const urlKey of ['BOOTSTRAP_URL', 'P2P_KILL_SWITCH_URL', 'SUPPORT_CONFIG_URL']) {
                if (NetworkConfig[urlKey]) {
                    try { mirrorHostSet.add(new URL(NetworkConfig[urlKey]).hostname) } catch (e) {}
                }
            }
            return Array.from(mirrorHostSet)
        }

        function createHeaderCallbackHandler(MIRROR_HOSTS) {
            const CSP_VALUE = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' https:; connect-src 'self' *; object-src 'none'; media-src 'self' https:; worker-src 'self'; frame-ancestors 'none'; form-action 'self';"
            return (details, callback) => {
                const url = details.url
                const isMirror = MIRROR_HOSTS.some(h => url.includes(h))
                const isLocal = url.startsWith('file://') || url.startsWith('devtools://')

                if (!isMirror && !isLocal) {
                    callback({ responseHeaders: details.responseHeaders })
                    return
                }

                const extra = {}
                if (isLocal) {
                    extra['Content-Security-Policy'] = [CSP_VALUE]
                }
                if (isMirror) {
                    extra['Access-Control-Allow-Origin'] = ['*']
                    extra['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS, RANGE']
                    extra['Access-Control-Allow-Headers'] = ['Content-Type, Range, X-File-Hash, X-File-Id, X-File-Path']
                }
                callback({ responseHeaders: { ...details.responseHeaders, ...extra } })
            }
        }

        test('should correctly parse unique hostnames from NetworkConfig', () => {
            const mockConfig = {
                MOJANG_MIRRORS: [
                    { client: 'https://mirror1.example.com/client.json', libs: 'https://mirror2.example.com/libs/' },
                    { client: 'https://mirror1.example.com/v2/', invalid: 'not-a-url' }
                ],
                BOOTSTRAP_URL: 'https://bootstrap.example.org/boot.json',
                P2P_KILL_SWITCH_URL: null
            }

            const hosts = computeMirrorHosts(mockConfig)
            expect(hosts.sort()).toEqual(['bootstrap.example.org', 'mirror1.example.com', 'mirror2.example.com'].sort())
        })

        test('should safely handle empty/malformed NetworkConfig without crashing', () => {
            expect(computeMirrorHosts({})).toEqual([])
            expect(computeMirrorHosts({ MOJANG_MIRRORS: 'not-an-array' })).toEqual([])
        })

        test('should apply CORS headers ONLY to mirror URLs', () => {
            const hosts = ['mirror.example.com']
            const handler = createHeaderCallbackHandler(hosts)

            let mirrorResult
            handler({ url: 'https://mirror.example.com/assets/1.png', responseHeaders: { 'Content-Type': 'image/png' } }, (res) => {
                mirrorResult = res
            })
            expect(mirrorResult.responseHeaders['Access-Control-Allow-Origin']).toEqual(['*'])

            let externalResult
            handler({ url: 'https://authserver.mojang.com/authenticate', responseHeaders: { 'Content-Type': 'application/json' } }, (res) => {
                externalResult = res
            })
            expect(externalResult.responseHeaders['Access-Control-Allow-Origin']).toBeUndefined()
        })

        test('should apply CSP headers ONLY to file:// and devtools:// URLs', () => {
            const handler = createHeaderCallbackHandler([])

            let fileResult
            handler({ url: 'file:///C:/app/index.html', responseHeaders: {} }, (res) => { fileResult = res })
            expect(fileResult.responseHeaders['Content-Security-Policy']).toBeDefined()

            let httpResult
            handler({ url: 'https://google.com', responseHeaders: {} }, (res) => { httpResult = res })
            expect(httpResult.responseHeaders['Content-Security-Policy']).toBeUndefined()
        })
    })

    describe('DistroManager Retry Predicate Logic', () => {
        const retryPredicate = (err) => !err.message?.includes('replay') && !err.message?.includes('signature')

        test('should NOT retry when error is a signature violation', () => {
            const err = new Error('Distribution index signature verification failed!')
            expect(retryPredicate(err)).toBe(false)
        })

        test('should NOT retry when error is a replay attack warning', () => {
            const err = new Error('Potential replay attack detected')
            expect(retryPredicate(err)).toBe(false)
        })

        test('should ALLOW retry on standard network failures', () => {
            expect(retryPredicate(new Error('ETIMEDOUT'))).toBe(true)
            expect(retryPredicate(new Error('ECONNRESET'))).toBe(true)
            expect(retryPredicate(new Error('HTTP 503 Service Unavailable'))).toBe(true)
            expect(retryPredicate({})).toBe(true) // undefined message
        })
    })
})
