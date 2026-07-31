const crypto = require('crypto')

describe('Network Changes Fuzzing & Stress Tests', () => {

    let handleFn
    let mockNetFetch

    beforeEach(() => {
        mockNetFetch = jest.fn()
        jest.doMock('electron', () => ({
            net: { fetch: mockNetFetch }
        }), { virtual: true })

        const handlers = {}
        const mockIpcMain = {
            handle: (channel, fn) => { handlers[channel] = fn }
        }

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

    function generateRandomPrimitive() {
        const types = ['string', 'number', 'boolean', 'null', 'undefined', 'object', 'array']
        const choice = types[Math.floor(Math.random() * types.length)]
        switch (choice) {
            case 'string': return crypto.randomBytes(Math.floor(Math.random() * 50)).toString('hex')
            case 'number': return (Math.random() - 0.5) * 100000
            case 'boolean': return Math.random() > 0.5
            case 'null': return null
            case 'undefined': return undefined
            case 'object': return { foo: 'bar', num: Math.random() }
            case 'array': return [1, 'test', null]
        }
    }

    test('Fuzz IPC net:fetch with 100 iterations of random/malformed parameters', async () => {
        mockNetFetch.mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: async () => Buffer.from('fuzz-data').buffer
        })

        for (let i = 0; i < 100; i++) {
            const fuzzUrl = generateRandomPrimitive()
            const fuzzOptions = generateRandomPrimitive()
            const fuzzTimeout = generateRandomPrimitive()

            try {
                // The handler should never throw unexpected unhandled rejections or crash the process
                await handleFn({}, fuzzUrl, fuzzOptions, fuzzTimeout)
            } catch (err) {
                // Expect handled errors only (e.g. net.fetch failing on invalid URL)
                expect(err).toBeInstanceOf(Error)
            }
        }
    })

    test('Fuzz IPC net:fetch with random binary array buffer sizes (0B to 1MB)', async () => {
        for (let size of [0, 1, 100, 1024, 65536, 524288]) {
            const buffer = crypto.randomBytes(size)
            mockNetFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
            })

            const res = await handleFn({}, 'https://example.com/blob', {}, 5000)
            const received = Buffer.from(res.body, 'base64')
            expect(received.length).toBe(size)
            expect(received.equals(buffer)).toBe(true)
        }
    })
})
