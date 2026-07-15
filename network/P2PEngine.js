// @ts-check
'use strict'

const Hyperswarm = require('hyperswarm')
const HyperDHT = require('hyperdht')
const b4a = require('b4a')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { Readable } = require('stream')

const Config = require('./config')
const NodeAdapter = require('./NodeAdapter')
const ConfigManager = require('../app/assets/js/core/configmanager')
const PeerHandler = require('./PeerHandler')
const PeerPersistence = require('./PeerPersistence')
const StatsManager = require('./StatsManager')
const isDev = require('../app/assets/js/core/isdev')

const SecurityManager = require('./services/SecurityManager')
const BandwidthManager = require('./services/BandwidthManager')
const QueueProcessor = require('./services/QueueProcessor')
const HealthMonitor = require('./services/HealthMonitor')

const { SWARM_TOPIC_SEED, MAX_SERVER_QUEUE_SIZE, MEMORY_CLEANUP_INTERVAL_MS } = require('./constants')

// Stable DHT topic for the "Zombie" network
const SWARM_TOPIC = crypto.createHash('sha256').update(SWARM_TOPIC_SEED).digest()

class P2PEngine extends EventEmitter {
    constructor() {
        super()
        this.setMaxListeners(100)

        /** @type {PeerHandler[]} */
        this.peers = []

        /**
         * Active download requests: reqId → { stream, peer, expectedSize, timestamp,
         *                                      bytesReceived, resolve, reject, timeoutId }
         * @type {Map<number, any>}
         */
        this.requests = new Map()

        // ── Mutable counters shared with QueueProcessor ──────────────────────
        // (object reference so QueueProcessor sees live values)
        this._counters = { activeUploads: 0, adaptiveSlotCount: 5 }

        // ── Sub-services ─────────────────────────────────────────────────────
        this.security = new SecurityManager()
        this.bandwidth = new BandwidthManager({ getPeers: () => this.peers })
        this.queue = new QueueProcessor(this._counters)
        this.health = new HealthMonitor({
            getPeers: () => this.peers,
            onReconfigure: () => this.reconfigureSwarm(),
            onRestart: () => this.stop().then(() => {
                this._restartTimer = setTimeout(() => this.start(), 2000)
                if (this._restartTimer.unref) this._restartTimer.unref()
            })
        })

        // ── Engine state ─────────────────────────────────────────────────────
        this.starting = false
        this.stopping = false
        this.profile = NodeAdapter.getProfile()

        /** @type {Promise<boolean> | null} */
        this._discoveryPromise = null
        this._discoveryLogThrottled = false

        // Batching
        this.batchQueue = new WeakMap()
        this.batchFlushScheduled = false
        /** @type {ReturnType<typeof setTimeout> | null} */
        this._batchFlushTimer = null

        // Upload session tracking (needed by PeerHandler)
        /** @type {Map<string, number>} */
        this.uploadCounts = new Map()

        /** @type {ReturnType<typeof setInterval> | null} */
        this._memCleanupInterval = null
        /** @type {ReturnType<typeof setInterval> | null} */
        this._scoreUpdateInterval = null

        /** @type {ReturnType<typeof setTimeout> | null} */
        this._restartTimer = null
        /** @type {ReturnType<typeof setTimeout> | null} */
        this._dhtReadyTimer = null
        /** @type {ReturnType<typeof setTimeout> | null} */
        this._discoveryTimer = null

        // ── Periodic memory cleanup ───────────────────────────────────────────
        if (process.env.NODE_ENV !== 'test') {
            this._startMemoryCleanup()
            // Sub-services: start only in non-test env
            this.security.start(MEMORY_CLEANUP_INTERVAL_MS)
            this.bandwidth.start()
            this.health.start()
            this._startPeerScoreUpdater()
        }
    }

    // ── Convenience passthrough getters for backward-compat with PeerHandler ──

    get usageTracker() { return this.security.usageTracker }
    get blacklist() { return this.security.blacklist }
    get peerStrikes() { return this.security.strikes }
    get activeUploads() { return this._counters.activeUploads }
    set activeUploads(v) { this._counters.activeUploads = v }
    get adaptiveSlotCount() { return this._counters.adaptiveSlotCount }
    set adaptiveSlotCount(v) { this._counters.adaptiveSlotCount = v }
    get currentUploadLimitMbps() { return this.bandwidth.currentUploadLimitMbps }
    get currentDownloadSpeed() { return this.bandwidth.downloadSpeed }
    get currentUploadSpeed() { return this.bandwidth.uploadSpeed }
    get currentDownloadSpeedLocal() { return this.bandwidth.downloadSpeedLocal }
    get currentUploadSpeedLocal() { return this.bandwidth.uploadSpeedLocal }
    get totalUploaded() { return this.bandwidth.totalUploaded }
    set totalUploaded(v) { this.bandwidth.totalUploaded = v }
    get totalDownloaded() { return this.bandwidth.totalDownloaded }
    set totalDownloaded(v) { this.bandwidth.totalDownloaded = v }
    get totalUploadedLocal() { return this.bandwidth.totalUploadedLocal }
    set totalUploadedLocal(v) { this.bandwidth.totalUploadedLocal = v }
    get totalUploadedGlobal() { return this.bandwidth.totalUploadedGlobal }
    set totalUploadedGlobal(v) { this.bandwidth.totalUploadedGlobal = v }
    get totalDownloadedLocal() { return this.bandwidth.totalDownloadedLocal }
    set totalDownloadedLocal(v) { this.bandwidth.totalDownloadedLocal = v }
    get totalDownloadedGlobal() { return this.bandwidth.totalDownloadedGlobal }
    set totalDownloadedGlobal(v) { this.bandwidth.totalDownloadedGlobal = v }
    get uploadBytesLocal() { return this.bandwidth.uploadBytesLocal }
    set uploadBytesLocal(v) { this.bandwidth.uploadBytesLocal = v }
    get uploadBytesGlobal() { return this.bandwidth.uploadBytesGlobal }
    set uploadBytesGlobal(v) { this.bandwidth.uploadBytesGlobal = v }
    get downloadBytesLocal() { return this.bandwidth.downloadBytesLocal }
    set downloadBytesLocal(v) { this.bandwidth.downloadBytesLocal = v }
    get downloadBytesGlobal() { return this.bandwidth.downloadBytesGlobal }
    set downloadBytesGlobal(v) { this.bandwidth.downloadBytesGlobal = v }
    get totalUploadedLocal_acc() { return this.bandwidth.totalUploadedLocal }
    get totalUploadedGlobal_acc() { return this.bandwidth.totalUploadedGlobal }
    get healthCheckPassive() { return this.health.isPassive }
    get passiveReason() { return this.health.passiveReason }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    async start() {
        if (!ConfigManager.isLoaded()) {
            await this._waitForConfig()
        }

        if (!ConfigManager.getSettings().deliveryOptimization?.globalOptimization) {
            this.stop()
            return
        }

        if (this.swarm || this.starting) return

        this.starting = true
        this.stopping = false
        try {
            await PeerPersistence.load()
            await this._init()
        } catch (e) {
            console.error('[P2PEngine] Init failed. Degrading to HTTP-only.', e)
            this.stop()
            return
        } finally {
            this.starting = false
        }

        this._prewarmDHT()
        this.reconfigureSwarm()
    }

    async stop() {
        this.starting = false
        this.stopping = true

        // ── Clear all pending request timeouts first ──────────────────────────
        for (const req of this.requests.values()) {
            if (req.timeoutId) clearTimeout(req.timeoutId)
            req.reject(new Error('P2P Engine stopped'))
        }
        this.requests.clear()

        // ── Timers ───────────────────────────────────────────────────────────
        this._clearTimer('_memCleanupInterval', true)
        this._clearTimer('_scoreUpdateInterval', true)
        this._clearTimer('_dhtReadyTimer')
        this._clearTimer('_discoveryTimer')
        this._clearTimer('_batchFlushTimer')
        this._clearTimer('_restartTimer')
        this.batchFlushScheduled = false

        // ── Sub-services ─────────────────────────────────────────────────────
        this.security.destroy()
        this.bandwidth.destroy()
        this.queue.destroy()
        this.health.destroy()

        // ── Hyperswarm ───────────────────────────────────────────────────────
        if (this.swarm) {
            const swarm = this.swarm
            this.swarm = null
            this.peers = []
            try { await swarm.destroy() } catch (_) { /* ignore */ }
        }

        // ── HyperDHT ─────────────────────────────────────────────────────────
        if (this.dht) {
            try { await this.dht.destroy() } catch (_) { /* ignore */ }
            this.dht = null
        }

        this.stopping = false
    }

    // ─── Network info (for UI) ────────────────────────────────────────────────

    setRaceManager(rm) { this.raceManager = rm }

    getNetworkInfo() {
        const routingNodes = this._getRoutingTableSize()
        const isEffectivelyPassive = this.profile.passive || !ConfigManager.getP2PUploadEnabled() || NodeAdapter.isCritical()

        const localPeers = this.peers.filter(p => {
            const ip = p.socket.remoteAddress || p.info?.peer?.host || (p.socket.rawStream?.remoteAddress)
            return this.isLocalIP(ip)
        }).length
        const globalPeers = Math.max(0, this.peers.length - localPeers)

        return {
            peers: this.peers.length,
            localPeers,
            globalPeers,
            topic: SWARM_TOPIC.toString('hex').substring(0, 8),
            requests: this.requests.size,
            uploads: this._counters.activeUploads,
            uploaded: this.bandwidth.totalUploaded,
            uploadedLocal: this.bandwidth.totalUploadedLocal,
            uploadedGlobal: this.bandwidth.totalUploadedGlobal,
            downloaded: this.bandwidth.totalDownloaded,
            downloadedLocal: this.bandwidth.totalDownloadedLocal,
            downloadedGlobal: this.bandwidth.totalDownloadedGlobal,
            dhtNodes: routingNodes,
            bootstrapNodes: Config.BOOTSTRAP_NODES.length,
            bootstrapped: this.dht ? this.dht.bootstrapped : false,
            running: !!this.swarm,
            listening: !!this.swarm,
            mode: isEffectivelyPassive ? 'Passive (Leech)' : 'Active (Seed)',
            profile: this.profile.name,
            downloadSpeed: this.bandwidth.downloadSpeed,
            uploadSpeed: this.bandwidth.uploadSpeed,
            downloadSpeedLocal: this.bandwidth.downloadSpeedLocal,
            uploadSpeedLocal: this.bandwidth.uploadSpeedLocal
        }
    }

    getLoadStatus() {
        return this.bandwidth.getLoadStatus()
    }

    // ─── Peer management ─────────────────────────────────────────────────────

    removePeer(peer) {
        this.queue.pruneForPeer(peer)
        if (this.batchQueue.has(peer)) this.batchQueue.delete(peer)
        const idx = this.peers.indexOf(peer)
        if (idx > -1) this.peers.splice(idx, 1)
        this.emit('peer_removed', peer)
    }

    /** @param {string} ip */
    isLocalIP(ip) {
        if (!ip) return false
        if (ip.startsWith('::ffff:')) ip = ip.substring(7)

        if (ip.includes(':')) {
            return ip === '::1' || ip.startsWith('fe80:') ||
                ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')
        }

        const parts = ip.split('.')
        if (parts.length !== 4) return false
        const n = ((parseInt(parts[0], 10) << 24) |
                   (parseInt(parts[1], 10) << 16) |
                   (parseInt(parts[2], 10) << 8) |
                    parseInt(parts[3], 10)) >>> 0

        if ((n & 0xff000000) >>> 0 === 0x0a000000) return true // 10.0.0.0/8
        if ((n & 0xffff0000) >>> 0 === 0xc0a80000) return true // 192.168.0.0/16
        if ((n & 0xfff00000) >>> 0 === 0xac100000) return true // 172.16.0.0/12
        if ((n & 0xff000000) >>> 0 === 0x7f000000) return true // 127.0.0.0/8
        if ((n & 0xffff0000) >>> 0 === 0xa9fe0000) return true // 169.254.0.0/16
        if ((n & 0xffc00000) >>> 0 === 0x64400000) return true // 100.64.0.0/10
        return false
    }

    // ─── Security (delegates to SecurityManager) ─────────────────────────────

    penalizePeer(peer, isMalicious = true) {
        const id = peer.getID()
        if (id === 'unknown') { peer.socket.destroy(); return }

        const blacklisted = this.security.penalize(id, isMalicious)
        // Always disconnect on any penalty (whether blacklisted or not)
        peer.socket.destroy()

        if (blacklisted) {
            // Also kick the peer if it's still in the active list
            this.removePeer(peer)
        }
    }

    triggerCircuitBreaker() {
        this.security.triggerCircuitBreaker(
            () => this.stop(),
            () => this.start()
        )
    }

    // ─── Upload accounting (called from PeerHandler) ──────────────────────────

    getUploadCountForIP(ip) { return this.uploadCounts.get(ip) || 0 }

    incrementUploadCountForIP(ip) {
        this.uploadCounts.set(ip, (this.uploadCounts.get(ip) || 0) + 1)
    }

    decrementUploadCountForIP(ip) {
        const c = this.uploadCounts.get(ip) || 0
        if (c > 1) this.uploadCounts.set(ip, c - 1)
        else this.uploadCounts.delete(ip)
    }

    onUploadFinished() { this.queue.onUploadFinished() }

    // ─── Server-side queue (delegates to QueueProcessor) ─────────────────────

    queueRequest(peer, reqId, hash, relPath, fileId, startOffset = 0) {
        this.queue.enqueue(peer, reqId, hash, relPath, fileId, startOffset)
    }

    pruneQueue(peer) { this.queue.pruneForPeer(peer) }

    // ─── Bandwidth delegates ──────────────────────────────────────────────────

    reportUploadStats(speed, isError) {
        if (!this.uploadHistory) this.uploadHistory = []
        if (isError) {
            const weight = NodeAdapter.penaltyWeight()
            if (isDev) console.warn(`[P2PEngine] Upload penalty. Weight: ${weight}`)
            if (NodeAdapter.isCritical()) {
                console.error('[P2PEngine] CRITICAL drop! Stopping announcement.')
                this.reconfigureSwarm()
            }
            return
        }
        this.uploadHistory.push(speed)
        if (this.uploadHistory.length > 5) this.uploadHistory.shift()
        const avg = this.uploadHistory.reduce((a, b) => a + b, 0) / this.uploadHistory.length
        if (avg > 1_048_576) NodeAdapter.boostWeight()
    }

    updateDynamicLimits(force = false) {
        // Trigger the bandwidth manager's update immediately (e.g. during init)
        // The manager's own timer handles periodic updates.
        try { this.bandwidth._updateLimits(force) } catch (_) { /* ignore if not ready */ }
    }

    getOptimalConcurrency(baseLimit) {
        return this.bandwidth.getOptimalConcurrency(baseLimit)
    }

    onPeerRTTUpdate(peer, rtt) {
        this.bandwidth.onPeerRTTUpdate(peer, rtt)
    }

    // ─── Swarm reconfiguration ────────────────────────────────────────────────

    reconfigureSwarm() {
        if (!this.swarm || this.stopping || this.swarm.destroyed) return
        const isCritical = NodeAdapter.isCritical()
        const isSelfIsolated = this.health.isPassive
        const shouldAnnounce = !this.profile.passive && !isCritical && !isSelfIsolated &&
            (ConfigManager.getP2PUploadEnabled() || ConfigManager.getLocalOptimization())
        this.swarm.join(SWARM_TOPIC, { client: true, server: shouldAnnounce })
    }

    // ─── File download (client side) ─────────────────────────────────────────

    /**
     * @param {string} hash
     * @param {number} expectedSize
     * @param {string|null} relPath
     * @param {string|null} fileId
     * @param {number} startOffset
     * @returns {Readable}
     */
    requestFile(hash, expectedSize = 0, relPath = null, fileId = null, startOffset = 0) {
        const stream = new Readable({ read() {} })
        this._handleRequestAsync(stream, hash, expectedSize, relPath, fileId, startOffset)
            .catch(err => { if (!stream.destroyed) stream.emit('error', err) })
        return stream
    }

    async _handleRequestAsync(stream, hash, expectedSize, relPath, fileId, startOffset) {
        const attempted = new Set()
        const getMaxAttempts = () => Math.max(10, this.peers.length + 2)

        for (let i = 0; i < getMaxAttempts(); i++) {
            // ── Wait for peers if needed ──────────────────────────────────────
            if (this.peers.length === 0) {
                if (!this._discoveryPromise) {
                    this._discoveryPromise = new Promise(resolve => {
                        const onConn = () => {
                            this.off('peer_added', onConn)
                            clearTimeout(this._discoveryTimer)
                            this._discoveryTimer = null
                            this._discoveryPromise = null
                            resolve(true)
                        }
                        this._discoveryTimer = setTimeout(() => {
                            this.off('peer_added', onConn)
                            this._discoveryPromise = null
                            resolve(false)
                        }, 10_000)
                        this.once('peer_added', onConn)
                    })
                }
                await this._discoveryPromise
            }

            if (this.peers.length === 0) {
                if (i >= 2) {
                    // CRITICAL FIX: destroy() cleans up V8 buffers; emit('error') alone
                    // leaves the Readable open and leaks memory until GC (never guaranteed).
                    stream.destroy(new Error('No peers available after discovery wait'))
                    return
                }
                continue
            }

            // ── Select best untried peer ──────────────────────────────────────
            const available = this.peers.filter(p => !attempted.has(p))
            if (available.length === 0) {
                stream.destroy(new Error('All available peers failed'))
                return
            }

            // ── Parallel Top-3 race ───────────────────────────────────────────
            const top = this._selectTopPeers(available, 3)
            top.forEach(p => attempted.add(p))

            const raceResult = await this._raceRequests(top, stream, hash, expectedSize, relPath, fileId, startOffset)

            if (raceResult.success) return

            // All top-3 failed; check if mid-transfer failure (can't retry)
            if (raceResult.midTransfer) {
                // CRITICAL FIX: destroy() releases all internal buffers immediately.
                // emit('error') without destroy() leaves the Readable alive indefinitely.
                stream.destroy(raceResult.error)
                return
            }

            if (this.stopping || !this.swarm) return
        }

        stream.destroy(new Error('Download failed after exhausted peer list'))
    }

    /**
     * Race up to `n` peers for the same request.
     * Returns { success: true } or { success: false, midTransfer, error }.
     *
     * @param {PeerHandler[]} peers
     * @param {Readable} stream
     * @param {string} hash
     * @param {number} expectedSize
     * @param {string|null} relPath
     * @param {string|null} fileId
     * @param {number} startOffset
     * @returns {Promise<{ success: boolean, midTransfer?: boolean, error?: Error }>}
     */
    async _raceRequests(peers, stream, hash, expectedSize, relPath, fileId, startOffset) {
        if (peers.length === 1) {
            // No actual race needed for a single peer
            const peer = peers[0]
            if (peer.socket.destroyed) return { success: false }
            try {
                await this._executeSingleRequest(peer, stream, hash, expectedSize, relPath, fileId, startOffset)
                return { success: true }
            } catch (err) {
                if (err.bytesReceived > 0) {
                    const isMalicious = err.message.includes('security limit')
                    this.penalizePeer(peer, isMalicious)
                    return { success: false, midTransfer: true, error: err }
                }
                return { success: false }
            }
        }

        // True race: wrap each peer in an AbortController
        const controllers = peers.map(() => ({ aborted: false }))
        let resolved = false

        const attempt = (peer, ctrl) => new Promise((resolve, reject) => {
            if (peer.socket.destroyed) { reject(new Error('Socket destroyed')); return }
            this._executeSingleRequest(peer, stream, hash, expectedSize, relPath, fileId, startOffset, ctrl)
                .then(() => {
                    if (!resolved && !ctrl.aborted) { resolved = true; resolve({ success: true, peer }) }
                })
                .catch(err => {
                    if (resolved) return
                    reject(err)
                })
        })

        try {
            // Promise.any: resolves with first success, rejects only if ALL fail
            const result = await Promise.any(peers.map((p, i) => attempt(p, controllers[i])))

            // Abort losing peers to save bandwidth
            peers.forEach((p, i) => {
                if (p !== result.peer) {
                    controllers[i].aborted = true
                    for (const [rId, req] of Array.from(this.requests.entries())) {
                        if (req.peer === p && req.stream === stream) {
                            req.reject(new Error('Request cancelled (race finished)'))
                            try {
                                p.sendError(rId, 'Aborted')
                            } catch (_) {}
                        }
                    }
                }
            })

            return result
        } catch (aggErr) {
            // All failed — check if any was a mid-transfer failure
            const errors = aggErr.errors || []
            const midErr = errors.find(e => e && e.bytesReceived > 0)
            if (midErr) {
                // CRITICAL FIX: If the stream was cancelled by RaceManager because HTTP won
                // the race, isGracefulCancel is set. We must NOT penalize the peer in that
                // case — it was working fine but lost the race to a faster HTTP mirror.
                if (stream.isGracefulCancel) {
                    return { success: false }
                }
                const failedPeer = peers[errors.indexOf(midErr)]
                const isMalicious = midErr.message.includes('security limit')
                if (failedPeer) this.penalizePeer(failedPeer, isMalicious)
                return { success: false, midTransfer: true, error: midErr }
            }
            return { success: false }
        }
    }

    /**
     * @param {PeerHandler} peer
     * @param {Readable} stream
     * @param {string} hash
     * @param {number} expectedSize
     * @param {string|null} relPath
     * @param {string|null} fileId
     * @param {number} startOffset
     * @param {any} [ctrl]
     * @returns {Promise<void>}
     */
    _executeSingleRequest(peer, stream, hash, expectedSize, relPath, fileId, startOffset = 0, ctrl = null) {
        return new Promise((resolve, reject) => {
            if (ctrl && ctrl.aborted) {
                reject(new Error('Request cancelled (race aborted)'))
                return
            }
            if (this.requests.size >= MAX_SERVER_QUEUE_SIZE) {
                reject(new Error('P2P Engine Overloaded (Request Cap Reached)'))
                return
            }

            // ── Collision-safe request ID ──────────────────────────────────
            let reqId
            do { reqId = crypto.randomBytes(4).readUInt32BE(0) }
            while (this.requests.has(reqId) || reqId === 0)

            let isFinalized = false

            const cleanup = () => {
                peer.socket.off('error', onSocketError)
                peer.socket.off('close', onSocketError)
                stream.off('close', onStreamAbort)
                stream.off('error', onStreamAbort)
                const req = this.requests.get(reqId)
                if (req && req.timeoutId) { clearTimeout(req.timeoutId); }
            }

            const finalize = (action, value) => {
                if (isFinalized) return
                isFinalized = true
                cleanup()
                this.requests.delete(reqId)
                action(value)
            }

            const customResolve = v => finalize(resolve, v)
            const customReject = e => finalize(reject, e)

            const onSocketError = (err) => {
                const req = this.requests.get(reqId)
                const error = new Error(`Peer socket closed/errored: ${err ? err.message : 'Unknown'}`)
                if (req) Object.assign(error, { bytesReceived: req.bytesReceived })
                customReject(error)
            }

            const onStreamAbort = () => {
                const req = this.requests.get(reqId)
                const error = new Error('P2P Request aborted (stream closed)')
                if (req) Object.assign(error, { bytesReceived: req.bytesReceived })
                try {
                    peer.sendError(reqId, 'Aborted')
                } catch (_) {}
                customReject(error)
            }

            peer.socket.once('error', onSocketError)
            peer.socket.once('close', onSocketError)
            stream.once('close', onStreamAbort)
            stream.once('error', onStreamAbort)

            // ── Timeout ────────────────────────────────────────────────────
            const timeoutId = setTimeout(() => {
                const req = this.requests.get(reqId)
                const err = new Error('P2P Timeout')
                if (req) Object.assign(err, { bytesReceived: req.bytesReceived })
                customReject(err)
            }, Config.PROTOCOL.TIMEOUT)

            // CRITICAL FIX: Verify abort flag right before registering and sending request
            if (ctrl && ctrl.aborted) {
                clearTimeout(timeoutId)
                customReject(new Error('Request cancelled (race aborted before send)'))
                return
            }

            this.requests.set(reqId, {
                stream, peer, expectedSize,
                timestamp: Date.now(),
                bytesReceived: startOffset,
                resolve: customResolve,
                reject: customReject,
                timeoutId   // ← stored so memory-manager can clear it
            })

            // ── Dispatch request ───────────────────────────────────────────
            const useBatching = peer.batchSupport && expectedSize > 0 && expectedSize < 1_048_576 && !relPath
            if (useBatching) {
                let batches = this.batchQueue.get(peer)
                if (!batches) { batches = []; this.batchQueue.set(peer, batches) }
                batches.push({ reqId, hash })
                if (!this.batchFlushScheduled) {
                    this.batchFlushScheduled = true
                    this._batchFlushTimer = setTimeout(() => this.flushBatches(), 20)
                }
            } else {
                try {
                    peer.sendRequest(reqId, hash, relPath, fileId, startOffset)
                } catch (e) {
                    customReject(e)
                }
            }
        })
    }

    // ─── Incoming data handlers (called from PeerHandler) ─────────────────────

    handleIncomingData(reqId, data, senderPeer) {
        if (typeof reqId !== 'number' || !b4a.isBuffer(data)) return
        const req = this.requests.get(reqId)
        if (!req || req.peer !== senderPeer) return

        req.bytesReceived = (req.bytesReceived || 0) + data.length
        senderPeer.downloadBytesActive = (senderPeer.downloadBytesActive || 0) + data.length
        this.bandwidth.totalDownloaded += data.length

        if (req.peer.isLocal()) {
            this.bandwidth.totalDownloadedLocal += data.length
            this.bandwidth.downloadBytesLocal += data.length
        } else {
            this.bandwidth.totalDownloadedGlobal += data.length
            this.bandwidth.downloadBytesGlobal += data.length
        }

        // ── Infinite-file protection ──────────────────────────────────────────
        const TOLERANCE = 1_048_576 // 1 MB
        if (req.expectedSize > 0 && req.bytesReceived > req.expectedSize + TOLERANCE) {
            if (isDev) console.error(`[P2PEngine] Peer ${req.peer.getIP()} sent too many bytes!`)
            const err = Object.assign(new Error('File size exceeded security limit'), { bytesReceived: req.bytesReceived })
            req.reject(err)
            return
        }

        req.stream.push(data)
    }

    handleIncomingEnd(reqId, senderPeer) {
        const req = this.requests.get(reqId)
        if (!req || req.peer !== senderPeer) return

        if (req.expectedSize > 0 && req.bytesReceived !== req.expectedSize) {
            const err = Object.assign(
                new Error(`Incomplete transfer: got ${req.bytesReceived} of ${req.expectedSize}`),
                { bytesReceived: req.bytesReceived }
            )
            req.reject(err)
            return
        }

        req.stream.push(null) // EOF
        req.resolve()

        const duration = (Date.now() - req.timestamp) / 1000
        if (duration > 0 && req.bytesReceived > 102_400) {
            req.peer.lastTransferSpeed = req.bytesReceived / duration
        }
    }

    handleIncomingError(reqId, messageBuffer, senderPeer) {
        const req = this.requests.get(reqId)
        if (!req || req.peer !== senderPeer) return
        const err = Object.assign(
            new Error(`Peer error: ${messageBuffer.toString('utf-8')}`),
            { bytesReceived: req.bytesReceived }
        )
        req.reject(err)
    }

    // ─── Batch flushing ───────────────────────────────────────────────────────

    flushBatches() {
        this.batchFlushScheduled = false
        this._batchFlushTimer = null
        for (const peer of this.peers) {
            const requests = this.batchQueue.get(peer)
            if (!requests || peer.socket.destroyed) { this.batchQueue.delete(peer); continue }
            // Filter out aborted requests before sending them
            const activeRequests = requests.filter(r => this.requests.has(r.reqId))
            if (activeRequests.length === 0) { this.batchQueue.delete(peer); continue }
            let remaining = activeRequests
            while (remaining.length > 0) {
                const chunk = remaining.slice(0, 50)
                remaining = remaining.slice(50)
                try { peer.sendBatchRequest(chunk) } catch (e) { console.error('[P2PEngine] Batch send failed:', e) }
            }
            this.batchQueue.delete(peer)
        }
    }

    // ─── Private — init helpers ───────────────────────────────────────────────

    async _init() {
        try {
            StatsManager.init(ConfigManager.getLauncherDirectorySync())

            // Bootstrap node refresh
            if (Config.BOOTSTRAP_URL) {
                try {
                    const res = await fetch(Config.BOOTSTRAP_URL)
                    if (res.ok) {
                        const nodes = await res.json()
                        if (Array.isArray(nodes) && nodes.length > 0) Config.BOOTSTRAP_NODES = nodes
                    }
                } catch (_) { /* use cached nodes */ }
            }

            this.dht = new HyperDHT({
                ephemeral: true,
                bootstrap: Config.BOOTSTRAP_NODES.map(n => ({
                    host: n.host, port: n.port,
                    publicKey: n.publicKey ? b4a.from(n.publicKey, 'hex') : undefined
                }))
            })
            this.dht.on('error', () => { /* suppressed */ })

            this.dht.on('ready', () => {
                if (isDev) {
                    const size = this._getRoutingTableSize()
                    console.debug(`[P2PEngine] DHT Ready. Bootstrapped: ${this.dht.bootstrapped}. Nodes: ${size}`)
                }
                this._dhtReadyTimer = setTimeout(() => {
                    this._dhtReadyTimer = null
                    if (!this.dht) return
                    if (this._getRoutingTableSize() === 0 && !this.dht.bootstrapped) {
                        console.warn('[P2PEngine] No DHT connections established after 5 s.')
                    }
                }, 5000)
                if (this._dhtReadyTimer.unref) this._dhtReadyTimer.unref()
            })

            this.swarm = new Hyperswarm({
                dht: this.dht,
                local: true,
                mdns: true,
                maxPeers: this.profile.maxPeers * 2
            })

            this.swarm.on('connection', (socket, info) => this._onConnection(socket, info))

            const shouldAnnounce = !this.profile.passive && !NodeAdapter.isCritical() &&
                (ConfigManager.getP2PUploadEnabled() || ConfigManager.getLocalOptimization())

            const discovery = this.swarm.join(SWARM_TOPIC, { server: shouldAnnounce, client: true })

            this.bandwidth._updateLimits(true) // Apply initial limit

            await discovery.flushed()
            console.log(`[P2PEngine] P2P Service Started. Debug: ${isDev}`)
            if (shouldAnnounce) {
                if (ConfigManager.getLocalOptimization()) console.log('[P2PEngine] Local Network: Active (MDNS)')
                if (ConfigManager.getP2PUploadEnabled()) console.log('[P2PEngine] Global Network: Active (DHT)')
                else console.log('[P2PEngine] Global Network: Downloads Only')
            } else {
                console.log('[P2PEngine] Passive Mode (Client Only)')
            }
        } catch (err) {
            console.error('[P2PEngine] Init failed:', err)
            throw err
        }
    }

    _onConnection(socket, info) {
        const peer = new PeerHandler(socket, this, info)

        let ip = (info.peer?.host) || socket.remoteAddress || socket.rawStream?.remoteAddress || 'unknown'
        if (ip.startsWith('::ffff:')) ip = ip.substring(7)

        const peerId = peer.getID()
        if (this.security.isBlacklisted(peerId)) {
            if (isDev) console.warn(`[P2PEngine] Rejecting blacklisted peer: ${peerId}`)
            socket.destroy()
            return
        }

        if (this.peers.length > this.profile.maxPeers) {
            if (isDev) console.debug(`[P2PEngine] Max peers reached. Rejecting.`)
            socket.destroy()
            return
        }

        socket.setMaxListeners(500)
        this.peers.push(peer)
        this.emit('peer_added', peer)
    }

    _prewarmDHT() {
        const known = PeerPersistence.getPeers('global')
        if (!known.length || !this.dht) return

        console.log(`[P2PEngine] Pre-warming: ${known.length} persistent peers.`)
        for (const p of known) {
            try {
                let ip = p.ip
                if (!ip || typeof ip !== 'string') continue
                if (ip.startsWith('::ffff:')) ip = ip.substring(7)
                if (ip.includes(':')) continue // skip IPv6
                this.dht.addNode({ host: ip, port: p.port })
            } catch (e) {
                console.warn(`[P2PEngine] Failed to add persistent node ${p.ip}:${p.port}:`, e.message)
            }
        }
    }

    _startMemoryCleanup() {
        this._memCleanupInterval = setInterval(() => {
            // Prune hanging requests — IMPORTANT: clear timeoutId to avoid memory leak
            const timeoutVal = Config.PROTOCOL?.TIMEOUT ?? 60_000
            const cutoff = Date.now() - timeoutVal * 2
            for (const [reqId, req] of this.requests.entries()) {
                if (req.timestamp < cutoff) {
                    if (req.timeoutId) clearTimeout(req.timeoutId)
                    req.reject(new Error('Hanging request pruned by memory manager'))
                    this.requests.delete(reqId)
                }
            }
        }, MEMORY_CLEANUP_INTERVAL_MS)
        if (this._memCleanupInterval.unref) this._memCleanupInterval.unref()
    }

    _startPeerScoreUpdater() {
        this._scoreUpdateInterval = setInterval(() => {
            for (const p of this.peers) {
                this._calculatePeerScore(p)
            }
        }, 3000)
        if (this._scoreUpdateInterval.unref) this._scoreUpdateInterval.unref()
    }

    _calculatePeerScore(p) {
        const weight = p.remoteWeight || 1
        const rtt = p.rtt || 200
        const activeSpeed = p.currentDownloadSpeed || 0
        const histSpeed = p.lastTransferSpeed || 0
        const maxSpeed = Math.max(activeSpeed, histSpeed)

        // Normalize speed: 100 KB/s → 1, 1 MB/s → 10, cap at 20 (2 MB/s)
        const speedFactor = maxSpeed ? Math.min(20, Math.max(0.1, maxSpeed / 102_400)) : 1

        // LAN bonus: local peers get 10x boost but not 100x — avoids number overflow
        // that dominated the score and made it hard to compare WAN peers meaningfully.
        const lanBonus = p.isLocal() ? 10 : 1

        // Linear weight — weight² was causing HIGH-profile peers to dominate even
        // when their RTT was 10x worse than a nearby MID-profile peer.
        p.cachedScore = weight * (1000 / (rtt + 5)) * speedFactor * lanBonus
    }

    /**
     * Select up to `n` best peers by score (weight, RTT, speed, LAN bonus).
     * @param {PeerHandler[]} candidates
     * @param {number} n
     * @returns {PeerHandler[]}
     */
    _selectTopPeers(candidates, n) {
        return candidates
            .map(p => {
                if (p.cachedScore === undefined) {
                    this._calculatePeerScore(p)
                }
                return { peer: p, score: p.cachedScore }
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, n)
            .map(x => x.peer)
    }

    _waitForConfig() {
        return new Promise(resolve => {
            const iv = setInterval(() => {
                if (ConfigManager.isLoaded()) { clearInterval(iv); resolve(true) }
            }, 50)
        })
    }

    _getRoutingTableSize() {
        if (!this.dht) return 0
        const d = /** @type {any} */(this.dht)
        for (const table of [this.dht.nodes, d.routingTable, d.table, d._dht?.nodes, d.kbucket]) {
            if (!table) continue
            if (typeof table.size === 'number') return table.size
            if (Array.isArray(table)) return table.length
            if (typeof table.count === 'function') return table.count()
            if (typeof table.toArray === 'function') return table.toArray().length
            if (typeof table.length === 'number') return table.length
        }
        return 0
    }

    /**
     * @param {string} name  Property name of the timer
     * @param {boolean} [isInterval]
     */
    _clearTimer(name, isInterval = false) {
        const t = this[name]
        if (t) {
            isInterval ? clearInterval(t) : clearTimeout(t)
            this[name] = null
        }
    }
}

module.exports = new P2PEngine()
