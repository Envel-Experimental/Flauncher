// @ts-check

const { LoggerUtil } = require('../util/LoggerUtil');
const { validateLocalFile, safeEnsureDir } = require('../common/FileUtils');
const { ensureDecodedPath, sleep } = require('../util/NodeUtil');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
let P2PEngine = require('../../../../../network/P2PEngine');
let RaceManager = require('../../../../../network/RaceManager');

// Test Hook for robust mocking in complex environments
if (process.env.JEST_WORKER_ID) {
    if (global.__P2P_MOCK__) P2PEngine = global.__P2P_MOCK__;
    if (global.__RACE_MOCK__) RaceManager = global.__RACE_MOCK__;
    // Test hook to reset counters
    global.__RESET_DL_ENGINE_COUNTERS__ = () => {
        activeHttpRequests = 0;
        activeWrites = 0;
    };
}

const { MAX_PARALLEL_DOWNLOADS } = require('../../../../../network/constants');
const ConfigManager = require('../configmanager');
const isDev = require('../isdev');
const MirrorManager = require('../../../../../network/MirrorManager');
const { DISTRO_PUB_KEYS } = require('../../../../../network/config');
const { verifyDistribution } = require('../util/SignatureUtils');

/**
 * @typedef {import('../../../../../types').DistributionData} DistributionData
 */

const log = LoggerUtil.getLogger('DownloadEngine');

// Global HTTP Throttling
const MAX_HTTP_CONCURRENCY = 10;
let activeHttpRequests = 0;

// Global Write Throttling (I/O)
const MAX_CONCURRENT_WRITES = 16; // Balanced limit to prevent HDD head thrashing while maintaining SSD throughput
let activeWrites = 0;

// Cleaning Task State
let lastCleanup = 0;
const CLEANUP_INTERVAL = 1000 * 60 * 60; // Run at most once per hour

/**
 * Clears old `.tmp` files left over from failed downloads.
 * 
 * @returns {Promise<void>}
 */
async function cleanupStaleTempFiles() {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL) return;
    lastCleanup = now;

    log.info('[Cleanup] Starting stale .tmp file cleanup...');
    const MAX_AGE = 4 * 60 * 60 * 1000; // 4 hours

    const scanAndClean = async (dir) => {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    // Limit recursion to relevant folders to avoid scanning the entire disk
                    // We only store downloads in 'assets', 'libraries', 'natives', 'objects' or sub-dirs like '00'-'ff'
                    if (['assets', 'libraries', 'natives', 'objects', 'common', 'minecraft'].includes(entry.name) || /^[0-9a-f]{2}$/.test(entry.name)) {
                        await scanAndClean(fullPath);
                    }
                } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
                    try {
                        const stats = await fs.stat(fullPath);
                        if (now - stats.mtimeMs > MAX_AGE) {
                            await fs.unlink(fullPath);
                            log.debug(`[Cleanup] Deleted stale file: ${fullPath}`);
                        }
                    } catch (e) { /* Ignored: cleanup failure is not critical */ }
                }
            }
        } catch (e) { /* Ignored: dir scanning failure */ }
    };

    try {
        const dataDir = ConfigManager.getDataDirectory();
        const commonDir = await ConfigManager.getCommonDirectory();

        if (dataDir) await scanAndClean(dataDir);
        if (commonDir && commonDir !== dataDir) await scanAndClean(commonDir);
    } catch (e) {
        log.warn('[Cleanup] Cleanup failed:', e);
    }
}

/**
 * Processes a queue of assets to download, utilizing parallel downloads and P2P logic.
 * 
 * @param {Array<any>} assets An array of asset objects to download.
 * @param {Function} [onProgress] Callback function for progress tracking.
 * @returns {Promise<Record<string, number>>} A promise resolving to an object mapping asset IDs to received bytes.
 */
async function downloadQueue(assets, onProgress) {
    // Make sure we catch any async initialization errors from P2PEngine
    P2PEngine.start().catch(e => {
        log.warn('[DownloadEngine] P2PEngine failed to start (Unhandled Async). Falling back entirely to HTTP.', e);
    });
    const limit = MAX_PARALLEL_DOWNLOADS;
    const receivedTotals = assets.reduce((acc, a) => ({ ...acc, [a.id]: 0 }), {});
    let receivedGlobal = 0;

    let activeDownloads = 0;
    const deferredQueue = [];

    const stats = {
        p2p_files: 0,
        p2p_bytes: 0,
        http_files: 0,
        http_bytes: 0,
        local_files: 0,
        local_bytes: 0,
        mirrors: {}
    };

    const runDownload = async (asset, forceHTTP = false, instantDefer = false) => {
        const onEachProgress = (transferred) => {
            receivedGlobal += (transferred - receivedTotals[asset.id]);
            receivedTotals[asset.id] = transferred;
            if (onProgress) onProgress(receivedGlobal);
        };
        const outcome = await downloadFile(asset, onEachProgress, forceHTTP, instantDefer);
        if (outcome) {
            if (outcome.source === 'p2p') {
                stats.p2p_files++;
                stats.p2p_bytes += outcome.bytes;
            } else if (outcome.source === 'http') {
                stats.http_files++;
                stats.http_bytes += outcome.bytes;
                const mirrorLabel = getMirrorLabel(outcome.url);
                if (!stats.mirrors[mirrorLabel]) {
                    stats.mirrors[mirrorLabel] = { files: 0, bytes: 0 };
                }
                stats.mirrors[mirrorLabel].files++;
                stats.mirrors[mirrorLabel].bytes += outcome.bytes;
            } else if (outcome.source === 'local') {
                stats.local_files++;
                stats.local_bytes += outcome.bytes;
            }
        }
    };

    let queue = [...assets];

    const worker = async (forceHTTP = false, instantDefer = false) => {
        while (queue.length > 0) {
            // Dynamic Throttling
            const currentMax = P2PEngine.getOptimalConcurrency(limit);
            if (activeDownloads >= currentMax) {
                await sleep(100);
                continue;
            }

            // HTTP Throttling (Global)
            if (forceHTTP && activeHttpRequests >= MAX_HTTP_CONCURRENCY) {
                await sleep(100);
                continue;
            }

            const asset = queue.shift();
            if (!asset) break;

            activeDownloads++;
            if (forceHTTP) activeHttpRequests++;
            try {
                await runDownload(asset, forceHTTP, instantDefer);
            } catch (err) {
                if (!forceHTTP) {
                    const isNoPeers = err.message && err.message.includes('No peers available')
                    if (isDev && !isNoPeers) {
                        log.debug(`[DownloadEngine] Deferring failed file: ${asset.id} (${err.message}). Will retry at the end.`);
                    }
                    deferredQueue.push(asset);
                } else {
                    // In final stand, if it fails again, we must collect it to throw later
                    // Attach history to asset for reporting
                    if (err.history) {
                        asset.history = err.history;
                    } else {
                        asset.history = [{ error: err.message, attempt: 'Final' }];
                    }
                    deferredQueue.push(asset);
                }
            } finally {
                activeDownloads--;
                if (forceHTTP) activeHttpRequests--;
            }
        }
    };

    // 1. Discovery Pass (Wait for P2P if enabled and no peers found yet)
    // This gives HyperDHT time to find peers before we start deferring everything.
    if (P2PEngine.peers.length === 0) {
        log.info('[DownloadEngine] Waiting 1.5s for P2P discovery...');
        await sleep(1500);
    }

    // 2. Main Pass (Fast pass: try only once and defer failures)
    const workers = [];
    for (let i = 0; i < limit; i++) workers.push(worker(false, true));
    await Promise.all(workers);

    // 2. Final Stand Pass (Retry deferred files with Force HTTP)
    if (deferredQueue.length > 0) {
        log.warn(`[DownloadEngine] Attempting "Final Stand" for ${deferredQueue.length} deferred files (P2P Disabled)...`);
        queue = [...deferredQueue];
        deferredQueue.length = 0; // Clear it to reuse for last check

        // Use fewer workers for final pass to avoid congestion
        const finalWorkers = [];
        for (let i = 0; i < 4; i++) finalWorkers.push(worker(true));
        await Promise.all(finalWorkers);
    }

    // 3. Last Check
    if (deferredQueue.length > 0) {
        const MAX_REPORT_NAMES = 5;
        let names = deferredQueue.slice(0, MAX_REPORT_NAMES).map(a => a.id).join(', ');
        if (deferredQueue.length > MAX_REPORT_NAMES) {
            names += ` ... и еще ${deferredQueue.length - MAX_REPORT_NAMES} файл(ов)`;
        }
        const fileWord = deferredQueue.length === 1 ? 'файл' : 'файлов';
        const errorMsg = `Не удалось скачать ${deferredQueue.length} ${fileWord}: ${names}. Пожалуйста, проверьте интернет-соединение и попробуйте снова.`;
        const criticalError = Object.assign(new Error(errorMsg), {
            failedFiles: deferredQueue.map(a => ({
                id: a.id,
                url: a.url,
                history: a.history || []
            }))
        });
        throw criticalError;
    }

    // Flatten mirrors stats to prevent PostHog nested object serialization issues
    const mirrorsPayload = {};
    for (const [mirrorName, mirrorData] of Object.entries(stats.mirrors)) {
        // Replace spaces or special characters in hostnames/names with underscores just in case
        const safeName = mirrorName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        mirrorsPayload[`mirror_files_${safeName}`] = mirrorData.files;
        mirrorsPayload[`mirror_bytes_${safeName}`] = mirrorData.bytes;
    }

    // Send event to PostHog
    try {
        const Analytics = require('../util/Analytics');
        Analytics.capture('Download Campaign Finished', {
            total_files: assets.length,
            p2p_files: stats.p2p_files,
            p2p_bytes: stats.p2p_bytes,
            http_files: stats.http_files,
            http_bytes: stats.http_bytes,
            local_files: stats.local_files,
            local_bytes: stats.local_bytes,
            ...mirrorsPayload
        });
    } catch (e) {
        // Ignore analytics failures
    }

    return receivedTotals;
}

/**
 * Downloads a single file with resilience and retry logic.
 * 
 * @param {any} asset The asset to download.
 * @param {Function} [onProgress] Callback function for progress tracking.
 * @param {boolean} [forceHTTP=false] Whether to bypass P2P and force HTTP.
 * @param {boolean} [instantDefer=false] Whether to fail fast (defer) if no peers are found and P2P is preferred.
 * @returns {Promise<void>}
 */
async function downloadFile(asset, onProgress, forceHTTP = false, instantDefer = false) {
    if (!asset || !asset.path) {
        throw new Error('Asset or asset path is null or undefined.');
    }
    const { path: assetPath, algo, hash } = asset;
    const decodedPath = ensureDecodedPath(assetPath);
    const CONFIG_EXTENSIONS = ['.txt', '.json', '.yml', '.yaml', '.dat'];

    // Initial check (Optimistic)
    try {
        await fs.access(decodedPath);

        // Mutable File Handling: Skip validation for configs and ANYTHING in instances
        const isInstanceFile = decodedPath.replace(/\\/g, '/').includes('/instances/');
        const isConfig = CONFIG_EXTENSIONS.includes(path.extname(decodedPath));

        if (!asset.force && (isConfig || isInstanceFile)) {
            log.debug(`Skipping validation/download of mutable file: ${decodedPath}`);
            if (onProgress) onProgress(asset.size);
            return { source: 'local', bytes: asset.size };
        }

        if (!asset.force && await validateLocalFile(decodedPath, algo, hash, asset.size)) {
            // log.debug(`File already exists and is valid: ${decodedPath}`);
            if (onProgress) onProgress(asset.size); // Account for skipping
            return { source: 'local', bytes: asset.size };
        }
    } catch (e) { /* File doesn't exist, proceed to download */ }

    await safeEnsureDir(path.dirname(decodedPath));

    const maxAttempts = asset.maxAttempts || 10;
    let lastError = null;
    const attemptHistory = [];
    const candidates = [asset.url, ...(asset.fallbackUrls || [])].filter(Boolean);

    // Retry Loop (Resilience)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // RESUMPTION LOGIC
        let startOffset = 0
        const tempPath = decodedPath + '.tmp';

        try {
            // Check if we have a partial file to resume
            if (fsSync.existsSync(tempPath)) {
                // Only resume if it's NOT the first attempt (fresh start) OR if we are explicitly retrying
                // Actually, if temp exists, we should probably try to resume unless it's corrupt.
                const stat = fsSync.statSync(tempPath)
                if (stat.size > 0 && stat.size < asset.size) {
                    startOffset = stat.size
                    if (isDev) log.debug(`[DownloadEngine] Resuming ${asset.id} from offset ${startOffset} / ${asset.size}`)
                } else if (stat.size >= asset.size) {
                    // It's already full? Validation will catch it, or it's corrupt. Let's reset just in case if we are here.
                    startOffset = 0
                    await fs.unlink(tempPath)
                }
            }
        } catch (e) {
            startOffset = 0
        }

        const candidate = candidates[attempt % candidates.length];
        const currentUrl = typeof candidate === 'string' ? candidate : candidate.url;
        const currentHash = typeof candidate === 'object' && candidate.hash ? candidate.hash : hash;

        // Start Timing for MirrorManager
        const downloadStartTime = Date.now();

        // Strict Blocking: If P2P Only Mode is enabled, BLOCK all official Mojang/Minecraft domains
        // But ALLOW mirrors (which are not mojang.com/minecraft.net)
        // Strict Blocking: Handle "No Servers" (P2P Only) and "No Mojang" modes
        const noServers = ConfigManager.getNoServers() || ConfigManager.getP2POnlyMode() // Support legacy key
        const noMojang = ConfigManager.getNoMojang()

        if (noServers || noMojang) {
            try {
                const urlObj = new URL(currentUrl)
                const hostname = urlObj.hostname.toLowerCase()
                const isMojang = hostname === 'mojang.com' || hostname.endsWith('.mojang.com') ||
                                hostname === 'minecraft.net' || hostname.endsWith('.minecraft.net')

                if (noServers) {
                    // Handled below
                } else if (noMojang && isMojang) {
                    // Block official URL in "No Mojang" Mode
                    continue
                }
            } catch (e) { /* Invalid URL, ignore blocking */ }
        }

        try {
            if (attempt > 0) {
                const backoff = Math.min(10000, Math.pow(2, attempt - 1) * 1000); // Exponential backoff up to 10s
                // Only log attempts if we are really struggling (3+ attempts)
                if (isDev && attempt >= 2) log.debug(`[DownloadEngine] Attempt ${attempt + 1} for ${asset.id}. Waiting ${backoff}ms...`);
                await sleep(backoff);
            }

            // RaceManager Strategy
            // Construct headers
            const headers = new Headers();
            if (asset.size) headers.append('X-Expected-Size', asset.size.toString());
            if (startOffset > 0) headers.append('X-Start-Offset', startOffset.toString()); // Hint for P2P/RaceManager
            if (assetPath) {
                const dataDir = ConfigManager.getDataDirectory().trim();
                const relPath = path.relative(dataDir, assetPath).replace(/\\/g, '/');
                headers.append('X-File-Path', encodeURIComponent(relPath));
            }
            if (asset.id) headers.append('X-File-Id', asset.id);
            if (hash) headers.append('X-File-Hash', hash);

            // Force HTTP after 2 failed attempts or if explicitly requested (deferral)
            // But NOT if we are in P2P Only Mode (where HTTP is blocked anyway)
            if ((attempt >= 2 || forceHTTP) && !noServers) {
                headers.append('X-Skip-P2P', 'true');
            }

            // Use RaceManager
            const req = new Request(currentUrl, { headers });

            const response = await RaceManager.handle(req);

            if (!response.ok) throw new Error(`RaceManager failed: ${response.status}`);

            const tempPath = decodedPath + '.tmp';
            
            // Wait for a write slot (I/O throttling)
            while (activeWrites >= MAX_CONCURRENT_WRITES) {
                await sleep(4);
            }
            // Progress tracking wrapper
            let loaded = startOffset;
            const total = asset.size || 0;

            activeWrites++;
            try {
                let fileStream;
                try {
                    fileStream = fsSync.createWriteStream(tempPath, { flags: startOffset > 0 ? 'a' : 'w' });
                } catch (e) {
                    throw e;
                }

                let lastProgressTime = 0;

                // Direct Node Stream (P2P / RaceManager optimized)
                if (response.p2pStream) {
                    const progressStream = new Transform({
                        transform(chunk, encoding, callback) {
                            loaded += chunk.length;
                            const now = Date.now();
                            if (onProgress && (now - lastProgressTime >= 100 || loaded === total)) {
                                onProgress(loaded);
                                lastProgressTime = now;
                            }
                            this.push(chunk);
                            callback();
                        }
                    });
                    await pipeline(response.p2pStream, progressStream, fileStream);
                }
                // Web Response Body (Standard HTTP)
                else if (response.body) {
                    const nodeStream = Readable.fromWeb(response.body);
                    const progressStream = new Transform({
                        transform(chunk, encoding, callback) {
                            loaded += chunk.length;
                            const now = Date.now();
                            if (onProgress && (now - lastProgressTime >= 100 || loaded === total)) {
                                onProgress(loaded);
                                lastProgressTime = now;
                            }
                            this.push(chunk);
                            callback();
                        }
                    });

                    await pipeline(nodeStream, progressStream, fileStream);
                } else {
                    throw new Error('No body in response');
                }
            } finally {
                activeWrites--;
            }

            // Validate Atomic Write (RCE Guard)
            const isP2P = !!response.p2pStream;
            if (await validateLocalFile(tempPath, algo, currentHash, asset.size, isP2P)) {

                // Signature Verification for Mirrored Manifests
                if (asset.verifySignature && MirrorManager.isMirrorUrl(currentUrl)) {
                    if (DISTRO_PUB_KEYS && DISTRO_PUB_KEYS.length > 0) {
                        try {
                            const sigUrl = currentUrl + '.sig';
                            const sigRes = await fetch(sigUrl, { cache: 'no-store' });
                            if (!sigRes.ok) throw new Error(`Signature file missing or inaccessible (HTTP ${sigRes.status})`);
                            
                            const signatureHex = (await sigRes.text()).trim();
                            const dataBuffer = await fs.readFile(tempPath);
                            
                            const isValid = await verifyDistribution({
                                dataHex: dataBuffer.toString('hex'),
                                signatureHex: signatureHex,
                                trustedKeys: DISTRO_PUB_KEYS
                            });

                            if (!isValid) {
                                throw new Error('Signature verification failed');
                            }
                            log.debug(`[DownloadEngine] Signature verified for ${asset.id} from mirror.`);
                        } catch (e) {
                            log.warn(`[DownloadEngine] Signature check FAILED for ${asset.id} from ${currentUrl}: ${e.message}`);
                            // If signature fails, we MUST NOT use this file. 
                            // Treat as validation failure to trigger retry/fallback.
                            try { await fs.unlink(tempPath) } catch (err) { /* Ignored */ }
                            
                            attemptHistory.push({
                                attempt: attempt + 1,
                                url: currentUrl,
                                method: 'Signature Check',
                                error: e.message
                            });
                            continue; // Retry loop
                        }
                    } else {
                        log.warn(`[DownloadEngine] Signature verification requested for ${asset.id} but no DISTRO_PUB_KEYS configured.`);
                    }
                }

                // Success! Atomic rename to final path with retries for Windows (Antivirus guard)
                if (fsSync.existsSync(tempPath)) {
                    await safeRename(tempPath, decodedPath);
                } else {
                    throw new Error(`Temp file disappeared before rename: ${tempPath}`);
                }

                // Report Success to MirrorManager
                MirrorManager.reportSuccess(currentUrl, Date.now() - downloadStartTime, loaded);
                return {
                    source: isP2P ? 'p2p' : 'http',
                    url: currentUrl,
                    bytes: loaded
                };
            }

            const isInstanceFile = decodedPath.replace(/\\/g, '/').includes('/instances/');
            const isConfig = CONFIG_EXTENSIONS.includes(path.extname(decodedPath));

            if (asset.force && (isConfig || isInstanceFile)) {
                if (total > 0 && loaded !== total) {
                    log.warn(`[DownloadEngine] Size mismatch for forced mutable file ${asset.id} (${loaded} vs ${total}), but accepting anyway.`);
                }
                if (fsSync.existsSync(tempPath)) {
                    await safeRename(tempPath, decodedPath);
                }
                return {
                    source: isP2P ? 'p2p' : 'http',
                    url: currentUrl,
                    bytes: loaded
                };
            }

            if (isDev) {
                const logFn = (isConfig || isInstanceFile) ? console.warn : console.error;
                logFn(`[DownloadEngine] Validation failed for ${asset.id}. File size: ${loaded} / ${total}`)
            }

            // DEBUG: Inspect contents and delete temp
            try {
                const fd = await fs.open(tempPath, 'r');
                const buffer = Buffer.alloc(100);
                const { bytesRead } = await fd.read(buffer, 0, 100, 0);
                await fd.close();

                const preview = buffer.slice(0, bytesRead).toString('utf-8');
                console.error(`[DownloadEngine] Failed File Content Preview (First 100 bytes): ${preview}`);
                await fs.unlink(tempPath);
            } catch (e) { /* Preview failed */ }

            const validationError = new Error('Validation failed');
            attemptHistory.push({
                attempt: attempt + 1,
                url: currentUrl,
                method: headers.has('X-Skip-P2P') ? 'HTTP' : 'Race(P2P+HTTP)',
                error: `Hash Mismatch (Got ${loaded} bytes)`
            });
            throw validationError;

        } catch (err) {
            lastError = err;

            // On failure, do NOT delete .tmp if it's a P2P error (we might resume later)
            // But if it's a validation error (hash mismatch on full file), we MUST delete it.
            const isValidationError = err.code === 'HASH_MISMATCH' || 
                                      err.message === 'Validation failed' || 
                                      (err.message && err.message.toLowerCase().includes('hash mismatch'));

            if (isValidationError) {
                try { await fs.unlink(decodedPath + '.tmp') } catch (e) { /* Ignored */ }
            }

            // Record failure if not already recorded (Validation failed adds its own)
            if (!isValidationError) {
                attemptHistory.push({
                    attempt: attempt + 1,
                    url: currentUrl,
                    method: 'Unknown', // Headers scope is limited, simplifying for safety or need to recalc
                    error: err.message
                });

                if (isDev) log.debug(`[DownloadEngine] Attempt ${attempt + 1} failed for ${asset.id}: ${err.message}`);
                
                // Report Failure to MirrorManager (network or validation error)
                MirrorManager.reportFailure(currentUrl, err.status);
            }

            // Continue to next attempt
        }
    }

    // If we're here, all retries failed
    const errorMsg = lastError ? (lastError.message || lastError.toString()) : 'Network timeout or no peers found';
    log.error(`Failed to download ${asset.id} after ${maxAttempts} attempts: ${errorMsg}`);
    const finalError = Object.assign(lastError || new Error(errorMsg), {
        history: attemptHistory
    });
    throw finalError;
}



/**
 * Safely renames a file with retries to handle temporary locks from Antivirus/OS (Windows).
 * 
 * @param {string} oldPath 
 * @param {string} newPath 
 * @param {number} [retries=5] 
 */
async function safeRename(oldPath, newPath, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            await fs.rename(oldPath, newPath);
            return;
        } catch (err) {
            const isLocked = err.code === 'EPERM' || err.code === 'EBUSY';
            if (isLocked && i < retries - 1) {
                const delay = 100 * (i + 1);
                log.debug(`[DownloadEngine] File locked during rename (${err.code}). Retry ${i + 1}/${retries} in ${delay}ms...`);
                await sleep(delay);
                continue;
            }
            throw err;
        }
    }
}

function getMirrorLabel(urlStr) {
    if (!urlStr) return 'unknown';
    const mirror = MirrorManager._findMirrorByUrl(urlStr);
    if (mirror && mirror.config && mirror.config.name) {
        return mirror.config.name;
    }
    try {
        const urlObj = new URL(urlStr);
        return urlObj.hostname;
    } catch (e) {
        return 'unknown';
    }
}

module.exports = { downloadQueue, downloadFile, cleanupStaleTempFiles }
