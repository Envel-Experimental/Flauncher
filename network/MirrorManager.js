// Using native fetch for better reliability and IPv6 support

const isDev = require('../app/assets/js/core/isdev')

function logMain(msg) {
    if (process && process.stdout && typeof process.stdout.write === 'function') {
        process.stdout.write(`>>> [MirrorManager] ${msg}\n`)
    } else {
        console.log(`[MirrorManager] ${msg}`)
    }
}

class MirrorManager {
    constructor() {
        this.mirrors = []
        this.initialized = false
    }

    async init(mirrorConfigs) {
        if (this.initialized) return
        if (!mirrorConfigs || !Array.isArray(mirrorConfigs) || mirrorConfigs.length === 0) {
            logMain('No mirrors configured.')
            this.initialized = true
            return
        }

        logMain(`Initializing with ${mirrorConfigs.length} mirrors.`)

        this.mirrors = mirrorConfigs.map(m => ({
            config: m,
            latency: 9999,
            failures: 0,
            successes: 0,
            lastChecked: 0,
            status: 'unknown'
        }))

        await this.measureAllLatencies()
        this.initialized = true
        logMain('Initialization complete.')
    }

    async measureAllLatencies() {
        logMain('Measuring all latencies...')
        const promises = this.mirrors.map(m => this._measureLatency(m))
        await Promise.allSettled(promises)
        this._sortMirrors()
        this._logStatus()
    }

    async _measureLatency(mirrorEntry) {
        const rawUrl = mirrorEntry.config.version_manifest ||
            mirrorEntry.config.assets ||
            mirrorEntry.config.java_manifest ||
            mirrorEntry.config.distribution

        if (!rawUrl) {
            mirrorEntry.latency = 9999
            mirrorEntry.status = 'invalid'
            return
        }

        try {
            new URL(rawUrl)
        } catch (e) {
            logMain(`INVALID URL: ${mirrorEntry.config.name} (${rawUrl})`)
            mirrorEntry.latency = 9999
            mirrorEntry.status = 'invalid'
            return
        }

        const probeOnce = async (method = 'HEAD') => {
            const start = Date.now()
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 4000)

            try {
                const response = await fetch(rawUrl, {
                    method,
                    signal: controller.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Flauncher/1.0',
                        'Referer': 'https://minecraft.net/',
                        'Origin': 'https://minecraft.net'
                    }
                })

                clearTimeout(timeoutId)
                const latency = Date.now() - start
                return { ok: response.ok, status: response.status, latency }
            } catch (err) {
                clearTimeout(timeoutId)
                return { ok: false, error: err }
            }
        }

        // 1. Initial probe (warms up DNS and TLS session)
        let probe = await probeOnce('HEAD')
        if (!probe.ok && probe.status === 405) {
            // Fallback to GET for servers disallowing HEAD
            probe = await probeOnce('GET')
        }

        if (!probe.ok) {
            mirrorEntry.lastChecked = Date.now()
            mirrorEntry.latency = 9999
            mirrorEntry.status = 'down'
            mirrorEntry.failures++

            if (probe.error && probe.error.name === 'AbortError') {
                logMain(`TIMEOUT: ${mirrorEntry.config.name || 'Unknown Mirror'}`)
            } else if (probe.error) {
                logMain(`ERROR: ${mirrorEntry.config.name} (${probe.error.message})`)
            } else {
                logMain(`FAILED: ${mirrorEntry.config.name} (Status: ${probe.status})`)
            }
            return
        }

        // 2. Second probe over warm Keep-Alive connection for accurate RTT
        const warmProbe = await probeOnce('HEAD')
        const finalLatency = warmProbe.ok ? Math.min(probe.latency, warmProbe.latency) : probe.latency

        mirrorEntry.lastChecked = Date.now()
        mirrorEntry.latency = finalLatency
        mirrorEntry.status = finalLatency < 400 ? 'active' : 'slow'
        mirrorEntry.failures = 0
        logMain(`SUCCESS: ${mirrorEntry.config.name} (${finalLatency}ms)`)
    }

    _sortMirrors() {
        this.mirrors.sort((a, b) => {
            // 1. Sort by status first (down/invalid always at bottom)
            if (a.status !== b.status) {
                const statusScore = { 'active': 0, 'slow': 1, 'down': 2, 'invalid': 3, 'unknown': 2 }
                return statusScore[a.status] - statusScore[b.status]
            }

            // 2. Latency comparison with "Fox Loyalty Bonus"
            // 50 ms is enough to prefer our own mirror when conditions are roughly equal,
            // but won't override a 400+ ms real latency gap in favour of a lagging server.
            const FOX_LOYALTY_BONUS_MS = 50
            const getAdjustedLatency = (entry) => {
                const name = (entry.config.name || '').toLowerCase()
                const dist = (entry.config.distribution || '').toLowerCase()
                const manifest = (entry.config.version_manifest || '').toLowerCase()

                let lat = entry.latency
                if (name.includes('fox') || dist.includes('f-launcher.ru') || manifest.includes('f-launcher.ru') || dist.includes('selcdn.net') || manifest.includes('selcdn.net')) {
                    lat -= FOX_LOYALTY_BONUS_MS
                }
                return lat
            }

            return getAdjustedLatency(a) - getAdjustedLatency(b)
        })
    }

    _logStatus() {
        const status = this.mirrors.map(m => `${m.config.name}: ${m.latency}ms (${m.status})`)
        logMain(`Rankings: ${status.join(', ')}`)
    }

    getSortedMirrors() {
        if (!this.initialized && this.mirrors.length === 0) {
            return require('./config').MOJANG_MIRRORS || []
        }
        return this.mirrors.map(m => m.config)
    }

    isMirrorUrl(urlStr) {
        return !!this._findMirrorByUrl(urlStr)
    }

    reportSuccess(mirrorUrl, durationMs, bytes) {
        const entry = this._findMirrorByUrl(mirrorUrl)
        if (entry) {
            entry.successes++
            entry.failures = 0
            if (entry.status !== 'active') {
                entry.status = 'active'
                this._sortMirrors()
            }
        }
    }

    _findMirrorByUrl(urlStr) {
        if (!urlStr) return null
        return this.mirrors.find(m => {
            const configs = [
                m.config.version_manifest,
                m.config.assets,
                m.config.libraries,
                m.config.client,
                m.config.java_manifest,
                m.config.distribution
            ].filter(Boolean)

            return configs.some(c => urlStr.startsWith(c))
        })
    }

    reportFailure(mirrorUrl, statusCode = 0) {
        const entry = this._findMirrorByUrl(mirrorUrl)
        if (entry) {
            if (statusCode === 404) return
            entry.failures++
            if (entry.failures >= 15) {
                entry.status = 'down'
                entry.latency = 9999
                this._sortMirrors()
            }
        }
    }

    getMirrorStatus() {
        return this.mirrors.map((m, index) => ({
            name: m.config.name || `Mirror #${index + 1}`,
            latency: m.latency === 9999 ? -1 : m.latency,
            status: m.status
        }))
    }
}

module.exports = new MirrorManager()
