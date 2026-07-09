// @ts-check

const b4a = require('b4a')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const ConfigManager = require('../app/assets/js/core/configmanager')
const PeerPersistence = require('./PeerPersistence')
const {
    MSG_REQUEST, MSG_DATA, MSG_ERROR, MSG_END,
    MSG_HELLO, MSG_PING, MSG_PONG, MSG_BATCH_REQUEST,
    BATCH_SIZE_LIMIT
} = require('./constants')

const TrafficState = require('./TrafficState')
const isDev = require('../app/assets/js/core/isdev')
const RateLimiter = require('../app/assets/js/core/util/RateLimiter')

const hashCache = new Map()

class PeerHandler {
    /**
     * @param {any} socket 
     * @param {any} engine 
     * @param {any} info 
     */
    constructor(socket, engine, info) {
        this.socket = socket
        this.engine = engine
        this.info = info
        /** @type {Buffer[]} */
        this.chunks = []
        this.chunksLen = 0
        this.chunkIndex = 0
        this.chunkOffset = 0
        this.processing = false
        this.batchSupport = false
        this.resumptionSupport = true // Always supported in this version
        this.remoteWeight = 0
        this.rtt = 0
        this.currentUploadSpeed = 0
        this.currentDownloadSpeed = 0
        this.downloadBytesActive = 0
        this.lastDownloadIntervalBytes = 0
        this.lastDownloadIntervalTime = Date.now()
        this.baselineRTT = 0
        /** @type {Map<number, { stream: any, source: any, cleanup: () => void }>} */
        this.uploads = new Map()

        // VULNERABILITY FIX (Slowloris): 30s Timeout
        this.socket.setTimeout(30000)
        this.socket.on('timeout', () => {
            // console.warn('[PeerHandler] Socket timeout (Slowloris protection).')
            this.socket.destroy()
        })

        socket.on('data', (data) => {
            // VULNERABILITY FIX 2: Memory Leak DoS Protection
            if (this.chunksLen + data.length > 2 * 1024 * 1024) { // 2MB Hard Limit
                // console.error('[PeerHandler] Buffer overflow. Closing connection.')
                this.socket.destroy()
                return
            }
            this.chunks.push(data)
            this.chunksLen += data.length
            this.processChunks()
        })

        const handleClose = () => {
            if (this.metricsInterval) {
                clearInterval(this.metricsInterval)
            }
            this.engine.removePeer(this)
        }
        socket.on('error', handleClose)
        socket.on('close', handleClose)

        // Initialize Real Paths for Security Checks
        try {
            const dataDir = ConfigManager.getDataDirectory().trim()
            const commonDir = ConfigManager.getCommonDirectorySync().trim()
            
            if (fs.existsSync(dataDir)) {
                this.dataDirReal = fs.realpathSync(dataDir)
            } else {
                this.dataDirReal = dataDir // Fallback to raw path if it doesn't exist yet
            }

            if (fs.existsSync(commonDir)) {
                this.commonDirReal = fs.realpathSync(commonDir)
            } else {
                this.commonDirReal = commonDir
            }
        } catch (e) {
            if (isDev) console.error('[PeerHandler] Failed to resolve real paths for security roots:', e)
            this.dataDirReal = null
            this.commonDirReal = null
        }

        // Send Hello with local weight
        this.sendHello()
        
        // Start Metric Observation
        this.metricsInterval = setInterval(() => {
            this.updateMetrics()
        }, 5000)
        if (this.metricsInterval.unref) this.metricsInterval.unref()
    }

    /**
     * @returns {string}
     */
    getIP() {
        let ip = (this.info && this.info.peer && this.info.peer.host) || this.socket.remoteAddress || (this.socket.rawStream && this.socket.rawStream.remoteAddress) || 'unknown'
        if (typeof ip === 'string' && ip.startsWith('::ffff:')) ip = ip.substring(7)
        return ip
    }

    /**
     * @returns {string}
     */
    getID() {
        const ip = this.getIP()
        // If IP is unknown, use the Public Key as a stable, unique ID
        if (ip === 'unknown' && this.info && this.info.publicKey) {
            return b4a.toString(this.info.publicKey, 'hex')
        }
        return ip
    }

    processChunks() {
        if (this.processing) return
        this.processing = true

        try {
            while (true) {
                // We need at least 9 bytes for the header
                if (this.chunksLen < 9) break

                // FIX: DoS Vulnerability (Fragmentation)
                // If the current chunk is too small for the header, consolidate remaining chunks.
                // This ensures we don't repeatedly traverse a list of small buffers (O(N^2))
                const currentChunk = this.chunks[this.chunkIndex]
                const availableInCurrent = currentChunk.length - this.chunkOffset
                if (availableInCurrent < 9) {
                    const remaining = this.chunks.slice(this.chunkIndex)
                    if (this.chunkOffset > 0) {
                        remaining[0] = remaining[0].subarray(this.chunkOffset)
                    }
                    this.chunks = [/** @type {Buffer} */(/** @type {any} */(b4a.concat(remaining)))]
                    this.chunkIndex = 0
                    this.chunkOffset = 0
                }

                // Optimized peek for header size
                const header = this._peekBytes(9)

                const type = header[0]
                const reqId = header.readUInt32BE(1)
                const len = header.readUInt32BE(5)

                // VULNERABILITY FIX 1: OOM Protection
                if (len > 1024 * 1024) { // 1MB Max Message Size
                    this.socket.destroy()
                    return
                }

                if (this.chunksLen < 9 + len) {
                    break // Wait for more data
                }

                // Consume Header
                this._readBytes(9)

                // Consume Body
                const payload = this._readBytes(len)

                this.handleMessage(type, reqId, payload)
            }
        } finally {
            this.processing = false
        }
    }

    /**
     * @param {number} n 
     * @returns {Buffer}
     */
    _peekBytes(n) {
        if (this.chunksLen < n) throw new Error('Not enough data')

        const currentChunk = this.chunks[this.chunkIndex]
        const availableInCurrent = currentChunk.length - this.chunkOffset

        if (availableInCurrent >= n) {
            return /** @type {Buffer} */(/** @type {any} */(currentChunk.subarray(this.chunkOffset, this.chunkOffset + n)))
        }

        // Header spans multiple chunks - rare but possible
        const res = b4a.alloc(n)
        let offset = 0
        let idx = this.chunkIndex
        let startOff = this.chunkOffset
        while (offset < n) {
            const chunk = this.chunks[idx]
            const available = chunk.length - startOff
            const toCopy = Math.min(n - offset, available)
            chunk.copy(res, offset, startOff, startOff + toCopy)
            offset += toCopy
            idx++
            startOff = 0
        }
        return /** @type {Buffer} */(/** @type {any} */(res))
    }

    /**
     * @param {number} n 
     * @returns {Buffer}
     */
    _readBytes(n) {
        if (n === 0) return /** @type {Buffer} */(/** @type {any} */(b4a.alloc(0)))
        if (this.chunksLen < n) throw new Error('Not enough data')

        this.chunksLen -= n

        const currentChunk = this.chunks[this.chunkIndex]
        const availableInCurrent = currentChunk.length - this.chunkOffset

        // Fast path: fully contained in the current chunk
        if (availableInCurrent >= n) {
            const buf = /** @type {Buffer} */(/** @type {any} */(currentChunk.subarray(this.chunkOffset, this.chunkOffset + n)))
            this.chunkOffset += n
            if (this.chunkOffset === currentChunk.length) {
                this.chunkIndex++
                this.chunkOffset = 0
                this._cleanupChunks()
            }
            return buf
        }

        // Slow path: spans multiple chunks
        const res = /** @type {Buffer} */(b4a.alloc(n))
        let offset = 0
        while (offset < n) {
            const chunk = this.chunks[this.chunkIndex]
            const available = chunk.length - this.chunkOffset
            const toCopy = Math.min(n - offset, available)
            chunk.copy(res, offset, this.chunkOffset, this.chunkOffset + toCopy)
            offset += toCopy
            this.chunkOffset += toCopy

            if (this.chunkOffset === chunk.length) {
                this.chunkIndex++
                this.chunkOffset = 0
            }
        }
        this._cleanupChunks()
        return res
    }

    _cleanupChunks() {
        if (this.chunkIndex > 128) {
            this.chunks = this.chunks.slice(this.chunkIndex)
            this.chunkIndex = 0
        }
    }

    /**
     * @param {number} type 
     * @param {number} reqId 
     * @param {Buffer} payload 
     */
    handleMessage(type, reqId, payload) {
        switch (type) {
            case MSG_REQUEST:
                this.handleRequest(reqId, payload)
                break
            case MSG_DATA:
                this.engine.handleIncomingData(reqId, payload, this) // Pass verified peer
                break
            case MSG_ERROR: {
                const uploadErr = this.uploads.get(reqId)
                if (uploadErr) {
                    if (isDev) console.debug(`[PeerHandler] Client cancelled upload for reqId ${reqId} via MSG_ERROR`)
                    uploadErr.cleanup()
                } else {
                    this.engine.handleIncomingError(reqId, payload, this)
                }
                break
            }
            case MSG_END: {
                const uploadEnd = this.uploads.get(reqId)
                if (uploadEnd) {
                    if (isDev) console.debug(`[PeerHandler] Client cancelled upload for reqId ${reqId} via MSG_END`)
                    uploadEnd.cleanup()
                } else {
                    this.engine.handleIncomingEnd(reqId, this)
                }
                break
            }
            case MSG_HELLO:
                this.handleHello(payload)
                break;
            case MSG_PING:
                this.sendPong(reqId)
                break;
            case MSG_BATCH_REQUEST:
                this.handleBatchRequest(payload)
                break;
        }
    }

    /**
     * @param {Buffer} payload 
     */
    handleHello(payload) {
        if (payload.length >= 1) {
            this.remoteWeight = payload.readUInt8(0)
            // Caps (byte 1)
            if (payload.length >= 2) {
                const caps = payload.readUInt8(1)
                this.batchSupport = (caps & 0x01) === 0x01
                // this.resumptionSupport = true (Default)
            }
            // console.log(`[PeerHandler] Peer weight set to ${this.remoteWeight}`)

            // Persist Peer
            try {
                let ip = this.socket.remoteAddress
                if (!ip) return

                // Unmap IPv4-mapped IPv6 addresses
                if (ip.startsWith('::ffff:')) {
                    ip = ip.substring(7)
                }

                const isLocal = this.engine.isLocalIP(ip)
                const type = isLocal ? 'local' : 'global'
                const publicKey = this.info && this.info.publicKey ? this.info.publicKey.toString('hex') : null

                PeerPersistence.updatePeer(type, {
                    ip,
                    port: this.socket.remotePort,
                    publicKey,
                    score: this.remoteWeight,
                    avgSpeed: 0
                })
            } catch (e) {
                if (isDev) console.error('[PeerHandler] Persistence Error:', e)
            }
        }
    }

    /**
     * Update metrics using native UDX RTT
     */
    updateMetrics() {
        if (this.socket.destroyed) {
            clearInterval(this.metricsInterval)
            return
        }

        // Calculate download speed dynamically based on incoming traffic
        const now = Date.now()
        const timeStep = (now - this.lastDownloadIntervalTime) / 1000
        if (timeStep >= 2) {
            const bytesStep = this.downloadBytesActive - this.lastDownloadIntervalBytes
            this.currentDownloadSpeed = Math.max(0, bytesStep / timeStep)
            this.lastDownloadIntervalBytes = this.downloadBytesActive
            this.lastDownloadIntervalTime = now
        }

        // If no active requests exist for this peer, reset download speed
        const hasActiveDownloads = this.engine && this.engine.requests
            ? Array.from(this.engine.requests.values()).some(req => req.peer === this)
            : false
        if (!hasActiveDownloads) {
            this.currentDownloadSpeed = 0
            this.downloadBytesActive = 0
            this.lastDownloadIntervalBytes = 0
            this.lastDownloadIntervalTime = now
        }

        // UDX/Hyperswarm provide RTT in rawStream
        const nativeRTT = this.socket.rawStream ? this.socket.rawStream.rtt : 0
        
        if (nativeRTT > 0) {
            this.rtt = nativeRTT
            
            // Update baseline (minimum seen)
            if (this.baselineRTT === 0 || this.rtt < this.baselineRTT) {
                this.baselineRTT = this.rtt
            }

            // Notify engine for congestion detection
            this.engine.onPeerRTTUpdate(this, this.rtt)
        }
    }

    // Unpack Batch and process individually
    /**
     * @param {Buffer} payload 
     */
    handleBatchRequest(payload) {
        let offset = 0
        if (payload.length < 2) return
        const rawCount = payload.readUInt16BE(offset)
        const count = Math.min(rawCount, BATCH_SIZE_LIMIT)
        offset += 2

        for (let i = 0; i < count; i++) {
            if (offset + 5 > payload.length) break
            const reqId = payload.readUInt32BE(offset)
            offset += 4
            const hashLen = payload.readUInt8(offset)
            offset += 1

            if (offset + hashLen > payload.length) break
            const hash = payload.subarray(offset, offset + hashLen)
            offset += hashLen

            // Process individual request (fire and forget / async)
            this.handleRequest(reqId, hash).catch(e => { })
        }
    }

    /**
     * @param {number} reqId 
     * @param {Buffer} payload 
     */
    async handleRequest(reqId, payload) {
        try {
            // Seeder Logic
            let hash = payload.toString('utf-8')
            let relPath = null
            let fileId = null
            let startOffset = 0

            // Detect JSON Payload (Starts with '{')
            if (payload.length > 0 && payload[0] === 123) { // 123 is '{'
                if (payload.length > 1024) { // 1KB Max for JSON payload
                    this.sendError(reqId, 'JSON Payload Too Large')
                    return
                }

                try {
                    const str = payload.toString('utf-8')
                    const data = JSON.parse(str)

                    // STRUCTURAL VALIDATION: Ensure flat object (Schema Validation)
                    // We expect { h: string, p: string, id: string }
                    if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.h === 'string') {
                        // Prevent Nested Objects (Depth > 1 prohibited)
                        let isNested = false
                        for (const key in data) {
                            if (typeof data[key] === 'object' && data[key] !== null) {
                                isNested = true
                                break
                            }
                        }

                        if (!isNested) {
                            hash = data.h.trim()
                            relPath = (data.p && typeof data.p === 'string') ? data.p.trim() : null
                            fileId = (data.id && typeof data.id === 'string') ? data.id.trim() : null
                            if (data.s && typeof data.s === 'number' && Number.isFinite(data.s) && Number.isInteger(data.s) && data.s > 0 && data.s < 2 * 1024 * 1024 * 1024) {
                                startOffset = data.s
                            }
                        }
                    }
                } catch (e) {
                    // If it's not valid JSON, treat as raw hash (the '7b' fix)
                    hash = payload.toString('utf-8').trim()
                }
            }

            // Sanitize hash to prevent directory traversal
            // Support SHA1 (40 chars) and MD5 (32 chars)
            if (hash) {
                if (!/^([a-f0-9]{64}|[a-f0-9]{40})$/i.test(hash)) {
                    this.sendError(reqId, 'Invalid hash (Only SHA-1 and SHA-256 allowed)')
                    return
                }
            } else if (!fileId && !relPath) {
                this.sendError(reqId, 'Missing Identification (Hash or FileId required)')
                return
            }

            // Sanitize relPath (Allow a-z, 0-9, /, ., _, -)
            if (relPath) {
                relPath = relPath.trim()
                // Basic sanitization: No '..'
                if (relPath.includes('..')) relPath = null // Security Risk
                if (path.isAbsolute(relPath)) relPath = null // Local path leakage
            }

            if (fileId) {
                fileId = fileId.trim()
                if (fileId.includes('..')) fileId = null
                if (path.isAbsolute(fileId)) fileId = null
            }

            if (hash) {
                hash = hash.trim()
            }

            let remoteIP = this.socket.remoteAddress || this.socket.remoteHost || (this.socket.rawStream && this.socket.rawStream.remoteAddress)
            if (!remoteIP && this.info && this.info.peer) remoteIP = this.info.peer.host
            if (!remoteIP) remoteIP = 'unknown'

            if (isDev) {
                // console.log(`%c[P2PEngine] Connection Established with ${remoteIP}`, 'color: #00ff00; font-weight: bold')
                const identifier = hash ? hash.substring(0, 8) : (fileId || 'n/a');
                // console.debug(`[P2P Debug] Received Request ${reqId} for ${identifier}...`)
            }

            const isGlobalUpload = ConfigManager.getP2PUploadEnabled()
            const isLocalUpload = ConfigManager.getLocalOptimization() && this.engine.isLocalIP(remoteIP)

            // Bypass limits for LAN peers
            if (!isLocalUpload) {
                // 2. Fair Usage Check (Soft Ban)
                const { MIN_CREDITS_TO_START } = require('./constants')
                // USE PEER ID (Public Key) if available to solve NAT issues, fallback to IP
                const usageKey = this.getID()
                const credits = this.engine.usageTracker.getCredits(usageKey)

                if (credits < MIN_CREDITS_TO_START) {
                    if (isDev) console.warn(`[P2P FairUsage] Soft-banning ${usageKey} (Credits: ${credits.toFixed(1)} MB)`)
                    this.sendError(reqId, 'Busy (Fair Usage Cooling)')
                    return
                }

                // Queue request via Engine
                this.engine.queueRequest(this, reqId, hash, relPath, fileId, startOffset)
                return // Stop execution here, wait for queue processing
            }

            // LAN peers bypass queue/limits largely, but we could still queue them?
            // For now, let LAN bypass queue for max speed.
            this.executeRequest(reqId, hash, relPath, fileId, startOffset)
        } catch (e) {
            if (isDev) console.error('[PeerHandler] Error handling request:', e)
            this.sendError(reqId, 'Internal error')
        }
    }

    /**
     * @param {number} reqId 
     * @param {string} hash 
     * @param {string | null} relPath 
     * @param {string | null} fileId 
     * @param {number} startOffset 
     */
    async executeRequest(reqId, hash, relPath, fileId, startOffset = 0) {
        let remoteIP = this.socket.remoteAddress || this.socket.remoteHost || (this.socket.rawStream && this.socket.rawStream.remoteAddress)
        if (!remoteIP && this.info && this.info.peer) remoteIP = this.info.peer.host
        if (!remoteIP) remoteIP = 'unknown'

        const isLocalUpload = ConfigManager.getLocalOptimization() && this.engine.isLocalIP(remoteIP)

        try {
            const commonDir = ConfigManager.getCommonDirectorySync().trim()
            const dataDir = ConfigManager.getDataDirectory().trim()

            // Candidate Paths (Normalized)
            const candidates = [
                path.resolve(path.join(commonDir, 'assets', 'objects', hash.substring(0, 2), hash)),
                path.resolve(path.join(dataDir, 'assets', 'objects', hash.substring(0, 2), hash)),
                path.resolve(path.join(dataDir, 'common', 'assets', 'objects', hash.substring(0, 2), hash)),
                path.resolve(path.join(dataDir, 'common', 'common', 'assets', 'objects', hash.substring(0, 2), hash))
            ]

            if (relPath) {
                candidates.push(path.resolve(path.join(commonDir, relPath)))
                candidates.push(path.resolve(path.join(dataDir, relPath)))
                // Try recursive-ish fallbacks for common assets
                candidates.push(path.resolve(path.join(dataDir, 'common', relPath)))
                candidates.push(path.resolve(path.join(dataDir, 'minecraft', relPath)))
            }

            if (fileId) {
                candidates.push(path.resolve(path.join(commonDir, fileId)))
                candidates.push(path.resolve(path.join(dataDir, fileId)))
                candidates.push(path.resolve(path.join(dataDir, 'common', fileId)))
            }

            // INSTANCE SEARCH: Removed as instances are user-mutable and not intended for P2P distribution


            // Deduplicate and filter any invalid paths
            const uniqueCandidates = [...new Set(candidates)].filter(p => p && p.length > 5)

            let foundPath = null
            for (const p of uniqueCandidates) {
                // SECURITY CHECK: Whitelist Validation
                if (!this._isPathSecure(p)) {
                    if (isDev) {
                        const dataDir = ConfigManager.getDataDirectory().trim()
                        const rel = path.relative(dataDir, p)
                        console.warn(`[P2P Security] Blocked access to unsafe path: ${p} (Rel: ${rel}, DataDir: ${dataDir})`)
                    }
                    continue
                }

                try {
                    // VULNERABILITY FIX: Symlink Path Traversal
                    // Resolve the *actual* path on disk to ensure it's not a symlink to outside.
                    // Using async fs.promises.realpath directly avoids both existSync and realpathSync blocking the Event Loop.
                    // If the path does not exist, realpath throws ENOENT which is caught.
                    const realP = await fs.promises.realpath(p)
                    if (this._isRealPathSecure(realP)) {
                        foundPath = realP
                        break
                    } else {
                        if (isDev) console.warn(`[P2P Security] Symlink redirection detected! ${p} -> ${realP}`)
                    }
                } catch (e) {
                    if (e.code !== 'ENOENT') {
                        if (isDev) console.error(`[P2P Debug] Error checking path ${p}:`, e.message)
                    }
                }
            }



            if (foundPath) {
                // VULNERABILITY FIX: Mandatory Hash Verification
                // Ensure the file content actually matches the requested hash (if provided)
                if (hash) {
                    try {
                        const actualHash = await this._calculateFileHash(foundPath, hash.length === 64 ? 'sha256' : 'sha1')
                        if (actualHash.toLowerCase() !== hash.toLowerCase()) {
                            if (isDev) console.warn(`[P2P Security] Hash mismatch for ${foundPath}. Requested: ${hash}, Actual: ${actualHash}`)
                            this.sendError(reqId, 'Integrity Error (Hash Mismatch)')
                            return
                        }
                    } catch (e) {
                        if (isDev) console.error(`[P2P Security] Failed to verify hash for ${foundPath}:`, e.message)
                        this.sendError(reqId, 'Verification Failed')
                        return
                    }
                }

                // Get File Size for Credits (using async fs.promises.stat to avoid blocking event loop)
                const stat = await fs.promises.stat(foundPath)
                const sizeMB = stat.size / 1024 / 1024
                const usageKey = this.getID()

                // VULNERABILITY FIX 2: Race to Drain (Credit Reservation)
                // Reserve credits *before* starting.
                if (!isLocalUpload) {
                    if (!this.engine.usageTracker.reserve(usageKey, sizeMB)) {
                        this.sendError(reqId, 'Quota Exceeded (Reservation Failed)')
                        return
                    }
                }

                this.engine.activeUploads++
                this.engine.incrementUploadCountForIP(remoteIP)

                const stream = fs.createReadStream(foundPath, { start: startOffset })
                if (isDev) {
                    // console.debug(`[P2P] Serving ${foundPath} to ${remoteIP}`)
                }

                // Register active upload
                this.uploads.set(reqId, {
                    stream,
                    source: null,
                    cleanup: () => cleanup()
                })

                // VULNERABILITY FIX 3: Global Rate Limiter Bug
                // Do NOT call RateLimiter.update() here, as it sets it for EVERYONE.
                // Instead, we use the singleton instance and pipe through it ONLY if needed.
                // @ts-ignore

                /** @type {import('stream').Readable} */
                let source = stream

                if (!isLocalUpload) {
                    // WAN: Pipe through Global Rate Limiter
                    // Limiter is a Transform stream
                    source = /** @type {any} */(stream.pipe(RateLimiter.throttle()))
                }

                const activeUpload = this.uploads.get(reqId)
                if (activeUpload) activeUpload.source = source

                // Performance Monitoring
                const startTime = Date.now()
                let totalBytesSent = 0
                let errorOccurred = false

                const onSocketClose = () => {
                    if (!stream.destroyed) {
                        errorOccurred = true 
                        stream.destroy()
                    }
                }

                let isPausedLocal = false
                const onDrain = () => {
                    if (isPausedLocal && source) {
                        isPausedLocal = false
                        source.resume()
                    }
                }

                this.socket.on('close', onSocketClose)
                this.socket.on('error', onSocketClose)
                this.socket.on('drain', onDrain)

                // Watchdog: Anti-Slowloris & Inactivity Protection
                let lastActivity = Date.now()
                const watchdogStart = Date.now()

                // Track instantaneous speed
                let lastIntervalBytes = 0
                let lastIntervalTime = Date.now()

                const watchdog = setInterval(() => {
                    if (this.socket.destroyed) {
                        clearInterval(watchdog)
                        return
                    }

                    const now = Date.now()

                    // 1. Inactivity Check (45s tolerance)
                    // We allow 45s of silence to avoid race conditions with the 15s check interval.
                    if (now - lastActivity > 45000) {
                        errorOccurred = true
                        if (isDev) console.warn(`[P2PEngine] Disconnecting ${remoteIP} due to inactivity (>45s).`)
                        stream.destroy()
                        clearInterval(watchdog)
                        return
                    }

                    // 2. Minimum Speed Enforcement
                    // Grace Period: Allow startup time
                    const totalDuration = (now - watchdogStart) / 1000

                    if (totalDuration >= 15) {
                        const timeStep = (now - lastIntervalTime) / 1000
                        const bytesStep = totalBytesSent - lastIntervalBytes

                        // Jitter Protection: Avoid false positives on rapid timer fires
                        if (timeStep >= 5) {
                            // Update for next check (Only if we actually checked)
                            lastIntervalBytes = totalBytesSent
                            lastIntervalTime = now

                            const currentSpeed = bytesStep / timeStep
                            this.currentUploadSpeed = currentSpeed // Expose for upload speed tracking
 
                             if (currentSpeed < 128000) { // < 125 KB/s
                                this.watchdogStrikes = (this.watchdogStrikes || 0) + 1
                                if (isDev) console.warn(`[P2PEngine] Peer ${remoteIP} slow (${currentSpeed.toFixed(0)} B/s). Strike ${this.watchdogStrikes}/3`)

                                if (this.watchdogStrikes >= 3) {
                                    // 3 strikes * 15s = 45s max patience for dead/slow peers
                                    errorOccurred = true
                                    if (isDev) console.error(`[P2PEngine] Disconnecting ${remoteIP} due to sustained slow speed.`)
                                    stream.destroy()
                                    clearInterval(watchdog)
                                }
                            } else {
                                // Reset strikes if speed recovers
                                if (this.watchdogStrikes > 0) {
                                    this.watchdogStrikes = 0
                                }
                            }
                        }
                    }
                }, 15000)
                if (watchdog.unref) watchdog.unref()
                let cleanupDone = false
                const cleanup = () => {
                    if (cleanupDone) return
                    cleanupDone = true

                    this.uploads.delete(reqId)

                     this.socket.removeListener('close', onSocketClose)
                     this.socket.removeListener('error', onSocketClose)
                     this.socket.removeListener('drain', onDrain)
                     clearInterval(watchdog)
 
                     if (this.uploads.size === 0) {
                         this.currentUploadSpeed = 0
                     }

                    // Robust Stream Destruction
                    if (!stream.destroyed) stream.destroy()
                    if (source && source !== stream && !source.destroyed) source.destroy()

                    // Report Stats
                    const duration = (Date.now() - startTime) / 1000
                    if (duration > 2) { // Ignore micro-transactions
                        const speed = totalBytesSent / duration // Bytes/sec

                        // Only report as "Error" if it was a real performance failure (timed out or socket died with low speed)
                        // This prevents "Not Found" or "Busy" from penalizing the seeder's reputation.
                        const isRealFailure = errorOccurred && speed < 102400 // Less than 100KB/s on failure
                        this.engine.reportUploadStats(speed, isRealFailure)
                    }

                    this.engine.activeUploads = Math.max(0, this.engine.activeUploads - 1)
                    this.engine.decrementUploadCountForIP(remoteIP)
                    this.engine.onUploadFinished()

                    // Refund Logic
                    if (!isLocalUpload) {
                        const sentMB = totalBytesSent / (1024 * 1024)
                        const unused = Math.max(0, sizeMB - sentMB)

                        if (unused > 0) {
                            // Only refund if we started from 0 (otherwise calculating 'unused' is complex and minor)
                            if (startOffset === 0) {
                                this.engine.usageTracker.refund(usageKey, unused)
                            }
                        }
                    }
                }

                source.on('data', (chunk) => {
                    lastActivity = Date.now()
                    totalBytesSent += chunk.length

                    const isLocal = this.engine.isLocalIP(remoteIP)
                    if (isLocal) {
                        this.engine.uploadBytesLocal += chunk.length
                        this.engine.totalUploadedLocal = (this.engine.totalUploadedLocal || 0) + chunk.length
                    } else {
                        this.engine.uploadBytesGlobal += chunk.length
                        this.engine.totalUploadedGlobal = (this.engine.totalUploadedGlobal || 0) + chunk.length
                    }

                    this.engine.totalUploaded = (this.engine.totalUploaded || 0) + chunk.length
                    
                    // BACKPRESSURE: Independent per-stream state in closure
                    if (!this.sendData(reqId, chunk)) {
                        isPausedLocal = true
                        source.pause()
                    }
                })

                if (isDev) {
                    // console.log(`[P2P Debug] Seeding file: ${foundPath} to ${remoteIP}`)
                }
                stream.on('end', () => {
                    this.sendEnd(reqId)
                    // if (isDev) console.log(`[P2P Debug] Upload Finished: ${foundPath} (${totalBytesSent} bytes)`)
                    cleanup()
                })

                stream.on('error', (err) => {
                    errorOccurred = true
                    // Ignore common file access errors (EACCES/EPERM) to prevent log spam
                    const code = /** @type {any} */(err).code
                    if (code !== 'EACCES' && code !== 'EPERM') {
                        if (isDev) console.error(`[P2P Debug] Read Error on ${foundPath}:`, err.message)
                    }
                    this.sendError(reqId, 'Read Error')
                    cleanup()
                })

                // Allow cleanup via file close?
                stream.on('close', cleanup)

            } else {
                this.sendError(reqId, 'Not Found')
            }
        } catch (err) {
            console.error('[PeerHandler] Request Handling Error:', err)
            this.sendError(reqId, 'Server Error')
        }
    }



    isLocal() {
        if (this.info && this.info.local) return true
        return this.engine.isLocalIP(this.getIP())
    }

    /**
     * @param {number} reqId 
     * @param {Buffer} data 
     * @returns {boolean} returns false if the socket buffer is full
     */
    sendData(reqId, data) {
        if (this.socket.destroyed) return true; // Guard against dead socket
        const header = /** @type {Buffer} */(b4a.alloc(9))
        header[0] = MSG_DATA
        header.writeUInt32BE(reqId, 1)
        header.writeUInt32BE(data.length, 5)
        return this.socket.write(b4a.concat([header, data]))
    }

    /**
     * @param {number} reqId 
     * @param {string} message 
     */
    sendError(reqId, message) {
        const payload = b4a.from(message, 'utf-8')
        const header = /** @type {Buffer} */(b4a.alloc(9))
        header[0] = MSG_ERROR
        header.writeUInt32BE(reqId, 1)
        header.writeUInt32BE(payload.length, 5)
        this.socket.write(b4a.concat([header, payload]))
    }

    /**
     * @param {number} reqId 
     */
    sendEnd(reqId) {
        const header = /** @type {Buffer} */(b4a.alloc(9))
        header[0] = MSG_END
        header.writeUInt32BE(reqId, 1)
        header.writeUInt32BE(0, 5) // No payload
        this.socket.write(header)
    }

    sendHello() {
        // Payload: [Weight (1 byte), Capabilities (1 byte)]
        // Capabilities: Bit 0 = Batch Support
        const localWeight = this.engine.profile.weight
        const payload = /** @type {Buffer} */(b4a.alloc(2))
        payload.writeUInt8(localWeight, 0)
        payload.writeUInt8(0x01, 1) // Advertise Batch Support

        const header = /** @type {Buffer} */(b4a.alloc(9))
        header[0] = MSG_HELLO
        header.writeUInt32BE(0, 1) // reqId 0 for system messages
        header.writeUInt32BE(payload.length, 5)
        this.socket.write(b4a.concat([header, payload]))
    }

    /**
     * Send PONG response for keep-alive
     * @param {number} reqId 
     */
    sendPong(reqId) {
        const header = /** @type {Buffer} */(b4a.alloc(9))
        header[0] = MSG_PONG
        header.writeUInt32BE(reqId, 1)
        header.writeUInt32BE(0, 5)
        this.socket.write(header)
    }


    /**
     * @param {number} reqId 
     */

    /**
     * @param {number} reqId 
     * @param {string} hash 
     * @param {string | null} [relPath] 
     * @param {string | null} [fileId] 
     * @param {number} [startOffset]
     */
    sendRequest(reqId, hash, relPath = null, fileId = null, startOffset = 0) {
        let payload
        if (relPath || fileId || startOffset > 0) {
            payload = b4a.from(JSON.stringify({ h: hash, p: relPath, id: fileId, o: startOffset }), 'utf-8')
        } else {
            payload = b4a.from(hash, 'utf-8')
        }

        const header = /** @type {Buffer} */(b4a.alloc(9))
        header[0] = MSG_REQUEST
        header.writeUInt32BE(reqId, 1)
        header.writeUInt32BE(payload.length, 5)
        this.socket.write(b4a.concat([header, payload]))
    }

    sendBatchRequest(requests) {
        // requests: Array<{ reqId, hash }>
        // Payload: Count(2) + [ReqId(4) + Len(1) + Hash(N)]...

        const mapped = requests.map(req => ({
            reqId: req.reqId,
            hashBuf: /** @type {Buffer} */(b4a.from(req.hash, 'utf-8'))
        }))

        let totalSize = 2;
        for (const item of mapped) {
            totalSize += 4 + 1 + item.hashBuf.length;
        }

        const payload = /** @type {Buffer} */(b4a.alloc(totalSize));
        let offset = 0;
        payload.writeUInt16BE(requests.length, offset);
        offset += 2;

        for (const item of mapped) {
            payload.writeUInt32BE(item.reqId, offset);
            offset += 4;
            payload.writeUInt8(item.hashBuf.length, offset);
            offset += 1;
            item.hashBuf.copy(payload, offset)
            offset += item.hashBuf.length
        }

        const header = /** @type {Buffer} */(b4a.alloc(9))
        header[0] = MSG_BATCH_REQUEST
        header.writeUInt32BE(0, 1) // ReqID 0 for container messages usually
        header.writeUInt32BE(payload.length, 5)
        this.socket.write(b4a.concat([header, payload]))
    }

    /**
     * @param {string} filePath 
     * @returns {boolean}
     */
    _isPathSecure(filePath) {
        try {
            const dataDir = ConfigManager.getDataDirectory().trim()
            const commonDir = ConfigManager.getCommonDirectorySync().trim()
            // console.log(`[_isPathSecure] filePath: ${filePath}, dataDir: ${dataDir}, commonDir: ${commonDir}`)

            // Check Data Dir
            const relData = path.relative(dataDir, filePath)
            const isInData = !relData.startsWith('..') && !path.isAbsolute(relData)

            // Check Common Dir
            const relCommon = path.relative(commonDir, filePath)
            const isInCommon = !relCommon.startsWith('..') && !path.isAbsolute(relCommon)

            // Must be in at least one valid root
            if (!isInData && !isInCommon) return false

            // Use the valid relative path for whitelist checks
            const activeRel = isInData ? relData : relCommon
            const normalizedRel = activeRel.replace(/\\/g, '/')
            const parts = normalizedRel.split('/')
            const firstPart = parts[0]
            const fileName = parts[parts.length - 1]

            // STRICT BLACKLIST (Files)
            const blacklist = [
                'config.json', 'distribution.json', 'peers.json', 'version_manifest_v2.json',
                'launcher_accounts.json', 'launcher_profiles.json', 'usercache.json', 'options.txt'
            ]
            if (blacklist.includes(fileName)) return false

            if (fileName.endsWith('.enc')) return false

            // STRICT EXTENSION BLACKLIST
            if (fileName.endsWith('.dat') || fileName.endsWith('.log') || fileName.endsWith('.txt')) {
                return false
            }

            // STRICT WHITELIST
            // assets - textures/sounds (heavy)
            // libraries - game libs (code)
            // versions - game core (code)
            // mods - mods (code, heavy)
            // common - shared files
            // objects - hashed assets
            // shaderpacks / resourcepacks - client aesthetics
            // scripts / kubejs - custom scripting
            // defaultconfigs - modpack defaults
            const whitelist = [
                'assets', 'libraries', 'versions', 'common', 'icons', 'objects',
                'mods', 'minecraft', 'shaderpacks', 'resourcepacks',
                'scripts', 'kubejs', 'defaultconfigs', 'fancymenu_data'
            ]

            const isWhitelisted = whitelist.includes(firstPart)

            // Allow only strictly whitelisted Root Files
            // e.g. pack.mcmeta, instance.cfg
            if (parts.length === 1) {
                const allowedRootFiles = ['pack.mcmeta', 'instance.cfg']
                return allowedRootFiles.includes(fileName)
            }

            return isWhitelisted
        } catch (e) {
            console.error('[P2P Security] Path check failed:', e)
            return false
        }
    }

    _isRealPathSecure(realPath) {
        try {
            if (!this.dataDirReal || !this.commonDirReal) {
                // Re-attempt resolution if they failed in constructor (unlikely but safe)
                try {
                    const dataDir = ConfigManager.getDataDirectory().trim()
                    const commonDir = ConfigManager.getCommonDirectorySync().trim()
                    
                    if (fs.existsSync(dataDir)) {
                        this.dataDirReal = fs.realpathSync(dataDir)
                    } else {
                        this.dataDirReal = dataDir
                    }

                    if (fs.existsSync(commonDir)) {
                        this.commonDirReal = fs.realpathSync(commonDir)
                    } else {
                        this.commonDirReal = commonDir
                    }
                } catch (e) {
                    return false // Cannot verify security
                }
            }

            // Check Data Dir (Real)
            const relData = path.relative(this.dataDirReal, realPath)
            const isInData = !relData.startsWith('..') && !path.isAbsolute(relData)

            // Check Common Dir (Real)
            const relCommon = path.relative(this.commonDirReal, realPath)
            const isInCommon = !relCommon.startsWith('..') && !path.isAbsolute(relCommon)

            return isInData || isInCommon
        } catch (e) {
            console.error('[P2P Security] RealPath check failed:', e)
            return false
        }
    }

    async _calculateFileHash(filePath, algo) {
        try {
            const stat = await fs.promises.stat(filePath)
            const cacheKey = `${filePath}:${algo}`
            const cached = hashCache.get(cacheKey)
            if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
                return cached.hash
            }

            const hashVal = await new Promise((resolve, reject) => {
                const hash = crypto.createHash(algo)
                const stream = fs.createReadStream(filePath)
                stream.on('error', reject)

                if (typeof stream[Symbol.asyncIterator] === 'function') {
                    const consume = async () => {
                        for await (const chunk of stream) {
                            hash.update(chunk)
                        }
                    }
                    consume()
                        .then(() => resolve(hash.digest('hex')))
                        .catch(reject)
                } else {
                    stream.on('data', (data) => hash.update(data))
                    stream.on('end', () => resolve(hash.digest('hex')))
                }
            })

            hashCache.set(cacheKey, {
                hash: hashVal,
                mtime: stat.mtimeMs,
                size: stat.size
            })

            return hashVal
        } catch (e) {
            throw e
        }
    }
}

module.exports = PeerHandler
