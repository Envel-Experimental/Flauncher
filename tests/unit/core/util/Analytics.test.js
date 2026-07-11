// 1. Mocks must be at the very top (before any requires)
jest.mock('../../../../app/assets/js/core/configmanager')
jest.mock('../../../../app/assets/js/core/util/HWID', () => ({
    getHWID: jest.fn().mockReturnValue('fallback_test_hwid')
}))
process.type = 'renderer'

const Analytics = require('../../../../app/assets/js/core/util/Analytics')
const ConfigManager = require('../../../../app/assets/js/core/configmanager')
const { ipcRenderer } = require('electron')

// Mock sendSync if not already mocked by jest.setup.js
if (!ipcRenderer.sendSync) {
    ipcRenderer.sendSync = jest.fn()
} else if (!ipcRenderer.sendSync.mockImplementation) {
    ipcRenderer.sendSync = jest.fn()
}

// Mock global fetch
global.fetch = jest.fn(() =>
    Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
    })
)

describe('Analytics', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        Analytics.enabled = true
        Analytics.distinctId = 'test-id'
        
        // Mock global window
        global.window = {
            screen: { width: 1920, height: 1080 },
            devicePixelRatio: 1,
            isDev: false
        }

        // Setup default mock returns
        ConfigManager.getClientToken.mockReturnValue('test-id')
        ConfigManager.getJavaConfig.mockReturnValue({ minRAM: '1G', maxRAM: '3G' })
        ConfigManager.getP2PUploadEnabled.mockReturnValue(false)
        ConfigManager.getP2PUploadLimit.mockReturnValue(5)
        ConfigManager.getLastLauncherVersion.mockReturnValue('1.0.0')
    })

    test('captureException should format $exception correctly for Error Tracking', async () => {
        const testError = new Error('Disk full')
        testError.name = 'ENOSPC'
        testError.stack = 'ENOSPC: Disk full\n    at exports.save (app/assets/js/core/configmanager.js:326:15)'
        
        await Analytics.captureException(testError)
        await Analytics.flush()

        const callArgs = JSON.parse(fetch.mock.calls[0][1].body)
        const event = callArgs.batch[0]

        expect(event.event).toBe('$exception')
        expect(event.properties.$exception_list).toBeDefined()
        expect(event.properties.$exception_list[0].type).toBe('ENOSPC')
        expect(event.properties.$exception_list[0].value).toBe('Disk full')
        expect(event.properties.$exception_list[0].stacktrace.type).toBe('raw')
        expect(event.properties.$exception_list[0].stacktrace.frames.length).toBeGreaterThan(0)
        expect(event.properties.$exception_list[0].stacktrace.frames[0].function).toBe('exports.save')
    })

    test('init should capture "Launcher Loaded" with system info', async () => {
        ConfigManager.getClientToken.mockReturnValue('existing-token')
        
        ipcRenderer.sendSync.mockImplementation((channel) => {
            if (channel === 'system:getSystemInfoSync') {
                return {
                    platform: 'win32',
                    arch: 'x64',
                    cpus: [{ model: 'Test CPU' }],
                    totalmem: 16 * 1024 * 1024 * 1024,
                    freemem: 8 * 1024 * 1024 * 1024
                }
            }
            if (channel === 'app:getVersionSync') return '1.1.0'
            return null
        })

        await Analytics.init()
        await Analytics.flush()

        expect(Analytics.distinctId).toBe('existing-token')
        
        // Find the "Launcher Loaded" call
        const call = global.fetch.mock.calls.find(call => call[1].body.includes('Launcher Loaded'))
        expect(call).toBeDefined()
        
        const body = JSON.parse(call[1].body)
        const event = body.batch.find(e => e.event === 'Launcher Loaded')
        expect(event).toBeDefined()
        expect(event.properties.$set).toBeDefined()
        expect(event.properties.$set.os_platform).toBe('win32')
        expect(event.properties.$set.launcher_version).toBe('1.1.0')
    })

    test('capture should include library info and os', async () => {
        await Analytics.capture('Test Event', { prop: 'val' })
        await Analytics.flush()

        const body = JSON.parse(global.fetch.mock.calls[0][1].body)
        const event = body.batch[0]

        expect(event.event).toBe('Test Event')
        expect(event.properties.distinct_id).toBe('test-id')
        expect(event.properties.$lib).toBe('FlauncherAnalytics')
        expect(event.properties.$os).toBeDefined()
    })

    test('captureException should handle string stack trace and extract message & frames', async () => {
        const stringStack = 'TypeError: Cannot read property foo of undefined\n    at RenderView.render (app/assets/js/ui/views/landing.js:45:12)\n    at init (app/assets/js/renderer-entry.js:140:10)'
        
        await Analytics.captureException(stringStack)
        await Analytics.flush()

        const callArgs = JSON.parse(fetch.mock.calls[0][1].body)
        const event = callArgs.batch[0]

        expect(event.event).toBe('$exception')
        expect(event.properties.$exception_list[0].type).toBe('TypeError')
        expect(event.properties.$exception_list[0].value).toBe('Cannot read property foo of undefined')
        expect(event.properties.$exception_list[0].stacktrace.frames.length).toBe(2)
        expect(event.properties.$exception_list[0].stacktrace.frames[0].function).toBe('init')
        expect(event.properties.$exception_list[0].stacktrace.frames[1].function).toBe('RenderView.render')
    })
})
