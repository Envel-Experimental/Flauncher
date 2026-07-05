const { Readable } = require('stream')
const HashVerifierStream = require('./HashVerifierStream')
const Config = require('./config')
const NodeAdapter = require('./NodeAdapter')
const ConfigManager = require('../app/assets/js/core/configmanager')
const TrafficState = require('./TrafficState')
const path = require('path')
const isDev = require('../app/assets/js/core/isdev')

class RaceManager {

    constructor() {
        this.p2pConsecutiveWins = 0
        this.failureBuffer = []
        this.failureFlushTimer = null
        this.failureHistory = new Set()
        this.successBuffer = []
        this.successFlushTimer = null
        this.discoveryPromise = null
    }

    logSuccess(hash) {
        if (!isDev || !hash) return
        this.successBuffer.push(hash.substring(0, 8))
        if (this.successFlushTimer) return

        this.successFlushTimer = setTimeout(() => {
            if (this.successBuffer.length > 1) {
                console.log(`%c[RaceManager] P2P WON for ${this.successBuffer.length} files: [${this.successBuffer.join(', ')}]`, 'color: #00ff00')
            } else if (this.successBuffer.length === 1) {
                console.log(`%c[RaceManager] P2P WON for ${this.successBuffer[0]}`, 'color: #00ff00')
            }
            this.successBuffer = []
            this.successFlushTimer = null
        }, 1000)
    }

    logFailure(hash, relPath, context) {
        // Deduplicate: If hash already in buffer or recently logged, ignore
        if (hash && this.failureHistory.has(hash)) return
        if (hash && this.failureBuffer.find(x => x.hash === hash)) return

        const name = relPath ? path.basename(relPath) : (hash ? hash.substring(0, 8) : 'unknown')
        this.failureBuffer.push({ hash, name, context })

        if (this.failureFlushTimer) clearTimeout(this.failureFlushTimer)

        this.failureFlushTimer = setTimeout(() => {
            if (this.failureBuffer.length === 0) return

            const count = this.failureBuffer.length

            // Add to history to avoid repeat logs for 30s
            for (const item of this.failureBuffer) {
                this.failureHistory.add(item.hash)
                setTimeout(() => this.failureHistory.delete(item.hash), 30000)
            }

            // Applying the provided snippet directly:
            if (count === 1) {
                // If it's a timeout or not found, keep it quiet unless it's a lot of files
                const item = this.failureBuffer[0]
                if (!item.context.includes('Timeout') && !item.context.includes('Not Found')) {
                    console.warn(`[RaceManager] P2P Download failed for ${item.name}. (${item.context})`)
                }
            } else {
                console.warn(`[RaceManager] P2P Download failed for ${count} files. Last context: ${this.failureBuffer[count - 1].context}`)
                // Readable List
                const names = this.failureBuffer.map(i => i.name).join(', ')
                console.warn('[RaceManager] Failed Files:', names)
            }
            this.failureBuffer = []
            this.failureFlushTimer = null
        }, 2000)
    }

    isBusy() {
        return TrafficState.isBusy()
    }

    /**
     * Intercepts and handles the request using a Racing strategy.
     * @param {Request} request
     */
    async handle(request) {
        const url_orig = request.url || ''
        // if (isDev) console.debug(`[RaceManager] handle() called: ${url_orig.substring(0, 100)}`)
        let url = url_orig

        let expectedSize = 0
        try {
            const sizeHeader = request.headers.get('X-Expected-Size')
            if (sizeHeader) expectedSize = parseInt(sizeHeader, 10)
        } catch (e) { /* Missing or invalid expected size header */ }

        // Convert mc-asset protocol back to https for the HTTP fetch leg
        if (url.startsWith('mc-asset://')) {
            url = 'https://' + url.substring('mc-asset://'.length)
        }

        // Retrieve X-File-Path header passed by DownloadEngine
        let relPath = null;
        let fileId = null;
        let hash = null;
        try {
            const pathHeader = request.headers.get('X-File-Path');
            if (pathHeader) {
                try {
                    relPath = decodeURIComponent(pathHeader);
                } catch (e) {
                    relPath = pathHeader;
                }
            }

            const idHeader = request.headers.get('X-File-Id');
            if (idHeader) fileId = idHeader;

            const hashHeader = request.headers.get('X-File-Hash');
            if (hashHeader) hash = hashHeader;
        } catch (e) { /* Missing or invalid custom headers */ }

        // Attempt to extract hash from URL if not provided in header (legacy/standard pattern)
        if (!hash) {
            const hashMatch = url.match(/\/([a-f0-9]{40}|[a-f0-9]{64})(\/|$)/i)
            if (hashMatch) {
                hash = hashMatch[1]
            }
        }

        // If no hash found and no identification, fallback to direct HTTP
        if (!hash && !fileId && !relPath) {
            return fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Flauncher/1.0'
                }
            })
        }

        const algo = hash ? (hash.length === 64 ? 'sha256' : 'sha1') : 'none'
        const abortController = new AbortController()

        // Check for Skip P2P Header or Size Limit (Security)
        let skipP2P = false
        const MAX_P2P_FILE_SIZE = 200 * 1024 * 1024 // 200 MB
        try {
            if (request.headers.get('X-Skip-P2P')) {
                skipP2P = true
            } else if (expectedSize > MAX_P2P_FILE_SIZE) {
                if (isDev) console.log(`[RaceManager] File too large for P2P (${(expectedSize / 1024 / 1024).toFixed(2)} MB > 200 MB). Forcing HTTP.`)
                skipP2P = true
            }
        } catch (e) { /* Invalid P2P skip header */ }

        // 1. HTTP Task
        const httpTask = new Promise((resolve, reject) => {
            if (ConfigManager.getP2POnlyMode() || ConfigManager.getNoServers()) {
                reject(new Error('HTTP Blocked: P2P Only Mode is Enabled (Strict)'))
                return
            }

            const httpTimeout = setTimeout(() => {
                abortController.abort();
                reject(new Error('HTTP Timeout'));
            }, 10000); // 10s timeout for HTTP

            fetch(url, {
                signal: abortController.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Flauncher/1.0',
                    'Referer': 'https://minecraft.net/',
                    'Origin': 'https://minecraft.net'
                }
            })
                .then(res => {
                    clearTimeout(httpTimeout);
                    if (!res.ok) {
                        const err = new Error(`HTTP ${res.status} (${res.statusText}) for ${url}`);
                        err.status = res.status;
                        throw err;
                    }
                    if (!res.body) throw new Error('HTTP No Body');
                    resolve({ type: 'http', result: res });
                })
                .catch(err => {
                    clearTimeout(httpTimeout);
                    if (isDev) {
                        console.error(`[RaceManager] HTTP Leg Failed for ${url}:`, err.message);
                    }
                    reject(err);
                })
        })

        // 2. Global P2P Task (Hyperswarm)
        let globalP2PStream = null
        const globalP2PTask = new Promise((resolve, reject) => {
            (async () => {
                if (skipP2P) {
                    reject(new Error('P2P Skipped'))
                    return
                }

                const P2PEngine = require('./P2PEngine')

                // Ambition Control: If P2P is overloaded, don't even try, let HTTP handle it.
                const loadStatus = P2PEngine.getLoadStatus()
                if (loadStatus === 'overloaded') {
                    reject(new Error('P2P Overloaded'))
                    return
                }

                if (P2PEngine.peers.length === 0 && !ConfigManager.getP2POnlyMode()) {
                    if (!this.discoveryPromise) {
                        if (isDev) console.log('[RaceManager] No peers found. Starting shared discovery grace period (5s)...')
                        this.discoveryPromise = new Promise((resolve) => {
                            const timeout = setTimeout(() => {
                                P2PEngine.off('peer_added', onPeerFound)
                                this.discoveryPromise = null
                                resolve(false)
                            }, 5000)
                            const onPeerFound = () => {
                                clearTimeout(timeout)
                                this.discoveryPromise = null
                                resolve(true)
                            }
                            P2PEngine.once('peer_added', onPeerFound)
                        })
                    }

                    const found = await this.discoveryPromise
                    if (!found) {
                        if (globalP2PStream) globalP2PStream.destroy()
                        reject(new Error('P2P No Peers (Discovery Timeout)'))
                        return
                    }
                }

                globalP2PStream = P2PEngine.requestFile(hash, expectedSize, relPath, fileId)

                // Timeout P2P strictly to avoid waiting too long if HTTP is also slow/failing
                const timeout = setTimeout(() => {
                    cleanup()
                    if (isDev && P2PEngine.peers.length > 0 && hash) {
                        console.log(`[RaceManager] Global P2P Task Timed Out (Soft) for ${hash.substring(0, 8)}`)
                    }
                    reject(new Error('Global P2P Timeout'))
                }, 60000) // 60s Soft Timeout for First Byte

                const onReadable = () => {
                    clearTimeout(timeout)
                    cleanup()
                    resolve({ type: 'global_p2p', result: globalP2PStream })
                }
                const onError = (err) => {
                    clearTimeout(timeout)
                    cleanup()
                    /* if (isDev && P2PEngine.peers.length > 0 && !err.message.includes('Not Found')) {
                        console.warn(`[RaceManager] P2P Leg Failed for ${hash.substring(0, 8)}: ${err.message}`)
                    } */
                    reject(err)
                }
                const cleanup = () => {
                    globalP2PStream.off('readable', onReadable);
                    globalP2PStream.off('error', onError)
                    // CRITICAL: Add no-op error listener to prevent crash if 
                    // the stream fails later (after we stop caring)
                    globalP2PStream.on('error', () => { /* Ignored: post-finalization failure */ })
                }
                globalP2PStream.on('readable', onReadable)
                globalP2PStream.on('error', onError)
            })().catch(reject)
        })

        // 3. Local P2P Task (Legacy UDP/HTTP - DISABLED in favor of HyperDHT Local)
        // Local P2P logic removed as P2PManager is deprecated.

        try {
            // Race: HTTP vs Global (now Universal) P2P
            const winner = await Promise.any([httpTask, globalP2PTask])

            if (winner.type === 'global_p2p') {
                abortController.abort() // Cancel HTTP
                this.logSuccess(hash)
                this.p2pConsecutiveWins++
                if (this.p2pConsecutiveWins >= 10) { NodeAdapter.boostWeight(); this.p2pConsecutiveWins = 0 }
                return this._createVerifiedStream(winner.result, algo, hash, expectedSize)
            } else {
                // HTTP Won
                if (globalP2PStream) {
                    // CRITICAL FIX: Mark the stream as intentionally cancelled so _raceRequests
                    // in P2PEngine won't penalize a seeder that was actually working fine —
                    // it just lost the race to an HTTP mirror that happened to respond first.
                    globalP2PStream.isGracefulCancel = true
                    globalP2PStream.destroy()
                }

                // Only log HTTP wins if we actually have peers, otherwise it's expected
                const P2PEngine = require('./P2PEngine')
                if (isDev && P2PEngine.peers.length > 0) {
                    // console.debug(`[RaceManager] HTTP WON for ${hash.substring(0, 8)}`)
                }
                this.p2pConsecutiveWins = 0
                // Standard HTTP: Return the native Response object directly.
                // This avoids double-stream conversion overhead and compatibility issues.
                // Validation is handled by DownloadEngine at the end.
                return winner.result
            }
        } catch (err) {
            // All failed? Should not happen if HTTP is valid.
            if (globalP2PStream) {
                globalP2PStream.isGracefulCancel = true
                globalP2PStream.destroy()
            }
            abortController.abort()

            if (err.name === 'AggregateError') {
                if (isDev) {
                    console.error(`[RaceManager] Both legs failed for ${url}:`, err.errors.map(e => e.message).join(' | '));
                }
            }

            if (ConfigManager.getP2POnlyMode()) {
                this.logFailure(hash, fileId || relPath, 'P2P Only Mode Active')
            } else {
                this.logFailure(hash, fileId || relPath, 'Retrying...')
            }

            throw err
        }
    }



    /**
     * Helper to create a verified response stream.
     */
    _createVerifiedStream(sourceStream, algo, hash, expectedSize) {
        // Verify Integrity
        const verifier = new HashVerifierStream(algo, hash, expectedSize)

        // Ensure errors from the source stream are handled and propagated
        sourceStream.on('error', (err) => {
            cleanupDownload()
            if (typeof verifier.destroy === 'function') {
                verifier.destroy(err)
            }
        })

        sourceStream.pipe(verifier)

        // Return Response
        // Electron expects a Response object.
        // We convert the Node stream back to a Web Stream
        // Return Response-like object with Node Stream
        // We pass the Node stream directly to avoid inconsistent Readable.toWeb / Response behavior
        // which was causing "[object ReadableStream]" to be written to disk.
        TrafficState.incrementDownloads()

        let cleanupDone = false;
        const cleanupDownload = () => {
            if (cleanupDone) return;
            cleanupDone = true;
            TrafficState.decrementDownloads()

            if (!TrafficState.isBusy()) {
                const P2PEngine = require('./P2PEngine')
                const stats = P2PEngine.getNetworkInfo()
                const downMB = (stats.downloaded / 1024 / 1024).toFixed(2)
                const upMB = (stats.uploaded / 1024 / 1024).toFixed(2)

                if (stats.downloaded > 0 || stats.uploaded > 0) {
                    console.log(`[P2P Stats] Session Finished. Total Downloaded: ${downMB} MB, Total Uploaded: ${upMB} MB`)
                }
            }
        }

        verifier.on('close', cleanupDownload)
        verifier.on('error', cleanupDownload)
        verifier.on('finish', cleanupDownload)

        return {
            ok: true,
            status: 200,
            p2pStream: verifier // Node Readable Stream
        }
    }
}

module.exports = new RaceManager()
