'use strict'

/**
 * Regression & correctness tests for MirrorManager.
 *
 * Bugs covered:
 *   1. Fox Loyalty Bonus was 500ms — allowed a 600ms-latency mirror to beat
 *      a 150ms mirror. Should be 50ms.
 *   2. Status sorting — down mirrors must always rank last.
 *   3. _findMirrorByUrl prefix matching.
 */
describe('MirrorManager', () => {
    let MirrorManager

    beforeEach(() => {
        jest.resetModules()
        global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 })
        jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
        jest.spyOn(console, 'log').mockImplementation(() => {})
        MirrorManager = require('../../../network/MirrorManager')
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    // ─── Initialization ───────────────────────────────────────────────────────

    it('initializes mirrors and marks initialized=true', async () => {
        await MirrorManager.init([
            { name: 'A', distribution: 'https://a.com/dist' }
        ])
        expect(MirrorManager.initialized).toBe(true)
        expect(MirrorManager.mirrors.length).toBe(1)
    })

    it('handles null/empty mirror configs gracefully', async () => {
        await MirrorManager.init(null)
        expect(MirrorManager.initialized).toBe(true)
        expect(MirrorManager.mirrors).toEqual([])
    })

    it('uses HEAD request without query timestamp for fast latency check', async () => {
        await MirrorManager.init([
            { name: 'FastCDN', version_manifest: 'https://cdn.example.com/manifest.json' }
        ])
        expect(global.fetch).toHaveBeenCalled()
        const [calledUrl, options] = global.fetch.mock.calls[0]
        expect(calledUrl).toBe('https://cdn.example.com/manifest.json')
        expect(options.method).toBe('HEAD')
    })

    it('falls back to GET if HEAD returns 405 Method Not Allowed', async () => {
        global.fetch
            .mockResolvedValueOnce({ ok: false, status: 405 })
            .mockResolvedValueOnce({ ok: true, status: 200 })
            .mockResolvedValueOnce({ ok: true, status: 200 })

        await MirrorManager.init([
            { name: 'LegacyServer', distribution: 'https://legacy.example.com/dist' }
        ])
        expect(MirrorManager.mirrors[0].status).toBe('active')
        expect(global.fetch.mock.calls[1][1].method).toBe('GET')
    })

    it('marks failed latency checks as down', async () => {
        global.fetch.mockRejectedValue(new Error('network error'))
        await MirrorManager.init([{ name: 'Dead', distribution: 'https://dead.com' }])
        expect(MirrorManager.mirrors[0].status).toBe('down')
        expect(MirrorManager.mirrors[0].latency).toBe(9999)
    })

    // ─── Loyalty bonus regression ──────────────────────────────────────────────

    it('REGRESSION: Fox loyalty bonus is at most 50ms, not 500ms', () => {
        // Before fix: bonus was 500ms. A 600ms fox mirror would beat a 150ms external mirror.
        // After fix: bonus is 50ms. A 600ms fox mirror gets adjusted to 550ms > 150ms → loses.
        MirrorManager.mirrors = [
            {
                config: { name: 'Fox Mirror', distribution: 'https://f-launcher.ru/dist' },
                latency: 600,
                status: 'active'
            },
            {
                config: { name: 'External Fast Mirror', distribution: 'https://mirror.nikita.best/dist' },
                latency: 150,
                status: 'active'
            }
        ]

        MirrorManager._sortMirrors()
        const sorted = MirrorManager.getSortedMirrors()

        // External fast mirror (150ms) should win over lagging fox (600ms - 50ms = 550ms)
        expect(sorted[0].name).toBe('External Fast Mirror')
        expect(sorted[1].name).toBe('Fox Mirror')
    })

    it('Fox mirror wins when both latencies are close (50ms margin)', () => {
        // Fox at 200ms vs external at 240ms → fox adjusted to 150ms → fox wins
        MirrorManager.mirrors = [
            {
                config: { name: 'Fox', distribution: 'https://f-launcher.ru/dist' },
                latency: 200,
                status: 'active'
            },
            {
                config: { name: 'External', distribution: 'https://other.com/dist' },
                latency: 240,
                status: 'active'
            }
        ]
        MirrorManager._sortMirrors()
        expect(MirrorManager.getSortedMirrors()[0].name).toBe('Fox')
    })

    it('Fox mirror loses when external is significantly faster (>50ms gap)', () => {
        // Fox at 300ms vs external at 200ms → fox adjusted to 250ms → external wins (200 < 250)
        MirrorManager.mirrors = [
            {
                config: { name: 'Fox', distribution: 'https://f-launcher.ru/dist' },
                latency: 300,
                status: 'active'
            },
            {
                config: { name: 'External Fast', distribution: 'https://cdn.fast.com/dist' },
                latency: 200,
                status: 'active'
            }
        ]
        MirrorManager._sortMirrors()
        expect(MirrorManager.getSortedMirrors()[0].name).toBe('External Fast')
    })

    it('Fox mirror matches by name field too (not just distribution URL)', () => {
        // Name 'fox' should also get the loyalty bonus
        MirrorManager.mirrors = [
            {
                config: { name: 'fox-primary', distribution: 'https://cdn.someother.ru/dist' },
                latency: 200,
                status: 'active'
            },
            {
                config: { name: 'ExternalCDN', distribution: 'https://cdn.fast.com/dist' },
                latency: 240,
                status: 'active'
            }
        ]
        MirrorManager._sortMirrors()
        // fox adjusted: 200 - 50 = 150 < 240
        expect(MirrorManager.getSortedMirrors()[0].name).toBe('fox-primary')
    })

    // ─── Status sorting ───────────────────────────────────────────────────────

    it('always ranks down/invalid mirrors last regardless of latency', () => {
        MirrorManager.mirrors = [
            { config: { name: 'Down-Fast' }, latency: 10, status: 'down' },
            { config: { name: 'Active-Slow' }, latency: 9000, status: 'active' },
            { config: { name: 'Active-Fast' }, latency: 50, status: 'active' }
        ]
        MirrorManager._sortMirrors()
        const names = MirrorManager.getSortedMirrors().map(m => m.name)
        expect(names[0]).toBe('Active-Fast')
        expect(names[names.length - 1]).toBe('Down-Fast')
    })

    it('sorts active < slow < down < invalid', () => {
        MirrorManager.mirrors = [
            { config: { name: 'invalid' }, latency: 1, status: 'invalid' },
            { config: { name: 'down' }, latency: 1, status: 'down' },
            { config: { name: 'slow' }, latency: 1, status: 'slow' },
            { config: { name: 'active' }, latency: 1, status: 'active' }
        ]
        MirrorManager._sortMirrors()
        const names = MirrorManager.getSortedMirrors().map(m => m.name)
        expect(names).toEqual(['active', 'slow', 'down', 'invalid'])
    })

    // ─── Reporting ────────────────────────────────────────────────────────────

    it('reportSuccess marks mirror active and increments successes', () => {
        MirrorManager.mirrors = [
            { config: { distribution: 'https://cdn.test.com' }, status: 'slow', successes: 0, failures: 2 }
        ]
        MirrorManager.reportSuccess('https://cdn.test.com/file.jar', 100, 1024)
        expect(MirrorManager.mirrors[0].status).toBe('active')
        expect(MirrorManager.mirrors[0].successes).toBe(1)
        expect(MirrorManager.mirrors[0].failures).toBe(0)
    })

    it('reportFailure marks mirror down after threshold', () => {
        MirrorManager.mirrors = [
            { config: { distribution: 'https://cdn.test.com' }, status: 'active', failures: 14 }
        ]
        MirrorManager.reportFailure('https://cdn.test.com/file.jar', 500)
        expect(MirrorManager.mirrors[0].status).toBe('down')
        expect(MirrorManager.mirrors[0].latency).toBe(9999)
    })

    it('reportFailure ignores 404 responses (file-not-found is not a mirror failure)', () => {
        MirrorManager.mirrors = [
            { config: { distribution: 'https://cdn.test.com' }, status: 'active', failures: 0 }
        ]
        MirrorManager.reportFailure('https://cdn.test.com/missing.jar', 404)
        expect(MirrorManager.mirrors[0].failures).toBe(0)
        expect(MirrorManager.mirrors[0].status).toBe('active')
    })

    // ─── URL matching ─────────────────────────────────────────────────────────

    it('isMirrorUrl returns true for known mirror prefixes', () => {
        MirrorManager.mirrors = [
            { config: { distribution: 'https://cdn.test.com/files' }, latency: 100, status: 'active' }
        ]
        expect(MirrorManager.isMirrorUrl('https://cdn.test.com/files/some/asset.jar')).toBe(true)
        expect(MirrorManager.isMirrorUrl('https://other.com/files/asset.jar')).toBe(false)
    })

    // ─── getMirrorStatus ──────────────────────────────────────────────────────

    it('getMirrorStatus returns -1 latency for down mirrors', () => {
        MirrorManager.mirrors = [
            { config: { name: 'Dead' }, latency: 9999, status: 'down' }
        ]
        const status = MirrorManager.getMirrorStatus()
        expect(status[0].latency).toBe(-1)
        expect(status[0].status).toBe('down')
    })
})
