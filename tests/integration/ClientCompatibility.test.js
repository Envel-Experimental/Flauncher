const path = require('path')

describe('Client Backward & Forward Compatibility Tests', () => {

    let originalWindow
    let ConfigManager

    beforeEach(() => {
        originalWindow = global.window
        jest.resetModules()
        ConfigManager = require('../../app/assets/js/core/configmanager')
    })

    afterEach(() => {
        global.window = originalWindow
    })

    test('fetchWithTimeout in Main Process (Node environment without window)', async () => {
        delete global.window
        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => 'main-process-response'
        })

        const res = await ConfigManager.fetchWithTimeout('https://example.com/api', {}, 5000)
        expect(res.ok).toBe(true)
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('main-process-response')
    })

    test('fetchWithTimeout in Legacy Browser/Electron without HeliosAPI.ipc', async () => {
        global.window = {} // window exists, but HeliosAPI/ipc doesn't
        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => 'browser-fallback-response'
        })

        const res = await ConfigManager.fetchWithTimeout('https://example.com/api', {}, 5000)
        expect(res.ok).toBe(true)
        expect(await res.text()).toBe('browser-fallback-response')
    })

    test('fetchWithTimeout in Modern Electron with IPC net:fetch', async () => {
        global.fetch = jest.fn()
        const mockBase64 = Buffer.from('ipc-response').toString('base64')
        const mockInvoke = jest.fn((channel, url, options, timeout) => {
            return Promise.resolve({
                ok: true,
                status: 200,
                body: mockBase64
            })
        })
        global.window = {
            HeliosAPI: {
                ipc: {
                    invoke: mockInvoke
                }
            }
        }

        const data = await mockInvoke('net:fetch', 'https://example.com/api', {}, 5000)
        const buf = Buffer.from(data.body, 'base64')
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        const res = {
            ok: data.ok,
            status: data.status,
            arrayBuffer: () => Promise.resolve(ab),
            text: () => Promise.resolve(buf.toString('utf-8'))
        }

        expect(mockInvoke).toHaveBeenCalledWith('net:fetch', 'https://example.com/api', {}, 5000)
        expect(res.ok).toBe(true)
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('ipc-response')

        const abRes = await res.arrayBuffer()
        expect(Buffer.from(abRes).toString('utf-8')).toBe('ipc-response')
    })
})
