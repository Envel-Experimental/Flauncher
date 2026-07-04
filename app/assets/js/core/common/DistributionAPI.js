// @ts-check

const crypto = require('crypto');
const { resolve } = require('path');
const fs = require('fs/promises');
const { LoggerUtil } = require('../util/LoggerUtil');
const { RestResponseStatus, handleFetchError } = require('./RestResponse');
const { HeliosDistribution } = require('./DistributionClasses');
const { fetchWithTimeout } = require('../configmanager');

class DistributionAPI {
    static log = LoggerUtil.getLogger('DistributionAPI');

    /**
     * @param {string} launcherDirectory 
     * @param {string} commonDir 
     * @param {string} instanceDir 
     * @param {string | string[]} remoteUrls 
     * @param {boolean} devMode 
     * @param {string[]} [trustedKeys] 
     */
    constructor(launcherDirectory, commonDir, instanceDir, remoteUrls, devMode, trustedKeys) {
        this.launcherDirectory = launcherDirectory;
        this.commonDir = commonDir;
        this.instanceDir = instanceDir;
        this.remoteUrls = Array.isArray(remoteUrls) ? remoteUrls : [remoteUrls];
        this.devMode = devMode;
        this.trustedKeys = trustedKeys;
        this.DISTRO_FILE = 'distribution.json';

        this.DISTRO_FILE_DEV = 'distribution_dev.json';
        this.distroPath = resolve(launcherDirectory, this.DISTRO_FILE);
        this.distroDevPath = resolve(launcherDirectory, this.DISTRO_FILE_DEV);
        /**
         * @type {DistributionData | null}
         */
        this.rawDistribution = null;
        /**
         * @type {HeliosDistribution | null}
         */
        this.distribution = null;
    }

    /**
     * @returns {Promise<HeliosDistribution>}
     */
    async getDistribution() {
        if (this.rawDistribution == null) {
            this.rawDistribution = await this.loadDistribution();
            this.distribution = new HeliosDistribution(this.rawDistribution, this.commonDir, this.instanceDir);
        }
        return this.distribution;

    }

    /**
     * @returns {Promise<HeliosDistribution>}
     */
    async getDistributionLocalLoadOnly() {
        if (this.rawDistribution == null) {
            const x = await this.pullLocal();
            if (x == null) {
                throw new Error('FATAL: Unable to load distribution from local disk.');
            }
            this.rawDistribution = x;
            this.distribution = new HeliosDistribution(this.rawDistribution, this.commonDir, this.instanceDir);
        }
        return this.distribution;
    }

    /**
     * @returns {Promise<HeliosDistribution | null>}
     */
    async refreshDistributionOrFallback() {
        const distro = await this._loadDistributionNullable();
        if (distro == null) {
            DistributionAPI.log.warn('Failed to refresh distribution, falling back to current load (if exists).');
            return this.distribution;
        }
        else {
            this.rawDistribution = distro;
            this.distribution = new HeliosDistribution(distro, this.commonDir, this.instanceDir);
            return this.distribution;
        }
    }

    /**
     * @param {boolean} dev 
     */
    toggleDevMode(dev) {
        this.devMode = dev;
    }

    isDevMode() {
        return this.devMode;
    }

    /**
     * @returns {Promise<DistributionData>}
     */
    async loadDistribution() {
        const distro = await this._loadDistributionNullable();
        if (distro == null) {
            throw new Error('FATAL: Unable to load distribution from remote server or local disk.');
        }
        return distro;
    }

    /**
     * @returns {Promise<DistributionData | null>}
     */
    async _loadDistributionNullable() {
        /** @type {DistributionData | null} */

        let distro = null;
        if (!this.devMode) {
            const localDistro = await this.pullLocal();
            const localTimestamp = localDistro?.timestamp ? new Date(localDistro.timestamp).getTime() : 0;

            const pullRes = await this.pullRemote(localTimestamp);
            distro = pullRes.data;

            if (distro == null) {
                distro = localDistro;
            }
            else {
                try {
                    await this.writeDistributionToDisk(distro);
                } catch (err) {
                    console.error('[DistributionAPI] Failed to write distribution to disk:', err);
                    // Continue anyway with the in-memory distro to let user play
                }
            }
        }
        else {
            distro = await this.pullLocal();
            if (distro == null) {
                console.log('[DistributionAPI] devMode: distribution_dev.json missing, falling back to production distribution.json');
                distro = await this.readDistributionFromFile(this.distroPath);
            }
            if (distro == null) {
                console.log('[DistributionAPI] devMode: local distribution files missing, falling back to remote...');
                distro = (await this.pullRemote()).data;
                if (distro != null) {
                    try {
                        await this.writeDistributionToDisk(distro);
                    } catch (err) {
                        console.error('[DistributionAPI] Failed to write remote distribution to disk (dev fallback):', err);
                    }
                }
            }
        }
        return distro;
    }

    /**
     * @param {number} [localTimestamp] 
     */
    async pullRemote(localTimestamp = 0) {
        if (this.remoteUrls.length === 0) {
            return handleFetchError('Pull Remote', new Error('No distribution URLs configured'), DistributionAPI.log);
        }

        const fetchOne = async (url) => {
            const res = await fetchWithTimeout(url, { cache: 'no-store' }, 10000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const rawBuffer = Buffer.from(await res.arrayBuffer());
            const rawText = rawBuffer.toString('utf-8');
            const data = JSON.parse(rawText);

            let signatureValid = false;

            if (this.trustedKeys && Array.isArray(this.trustedKeys) && this.trustedKeys.length > 0) {
                try {
                    const sigRes = await fetchWithTimeout(url + '.sig', { cache: 'no-store' }, 5000);
                    if (sigRes.ok) {
                        const signatureHex = (await sigRes.text()).trim();
                        const verifyData = {
                            dataHex: rawBuffer.toString('hex'),
                            signatureHex: signatureHex,
                            trustedKeys: this.trustedKeys
                        };
                        const { verifyDistribution } = require('../util/SignatureUtils');
                        signatureValid = await verifyDistribution(verifyData);
                    } else {
                        console.warn(`[DistributionAPI] Signature file missing for: ${url}`);
                    }
                } catch (e) {
                    console.warn(`[DistributionAPI] Error checking signature for ${url}:`, e.message);
                }
            }

            // ANTI-REPLAY CHECK
            if (signatureValid && this.trustedKeys && this.trustedKeys.length > 0) {
                const remoteTimestampStr = data.timestamp || data.rss;
                const remoteTimestamp = remoteTimestampStr ? new Date(remoteTimestampStr).getTime() : 0;

                if (localTimestamp > 0 && remoteTimestamp < localTimestamp) {
                    console.warn(`[DistributionAPI] Replay Attack Detected! Remote timestamp (${remoteTimestampStr}) is older than local (${new Date(localTimestamp).toISOString()}).`);
                    throw new Error('Distribution replay attack detected (downgrade attempt).');
                }
            }

            if (!signatureValid && this.trustedKeys && this.trustedKeys.length > 0) {
                throw new Error('Distribution signature verification failed.');
            }

            return {
                data: data,
                responseStatus: RestResponseStatus.SUCCESS,
                signatureValid: signatureValid,
                url: url // Track which one won
            };
        };

        // Competitive Racing: Give the first URL (primary) a 500ms head start
        // This satisfies the requirement: "if f-launcher is slower by 500+ ms or doesn't respond immediately, switch"
        const promises = this.remoteUrls.map(async (url, index) => {
            if (index > 0) {
                // Secondary mirrors wait 500ms before starting
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            try {
                return await fetchOne(url);
            } catch (err) {
                // Re-throw to be caught by Promise.any or similar
                throw err;
            }
        });

        try {
            // Promise.any returns the first SUCCESSFUL promise
            const winner = await Promise.any(promises);
            if (winner.url !== this.remoteUrls[0]) {
                console.log(`[DistributionAPI] Primary mirror was slow/down. Switched to: ${winner.url}`);
            }
            return winner;
        } catch (err) {
            console.error('[DistributionAPI] All distribution sources failed or timed out.');
            
            let finalError = new Error('All mirrors failed');
            
            // Satisfy test expectations by extracting the specific security error if it exists
            if (err instanceof AggregateError) {
                // Priority: Replay > Signature > Other
                const replayErr = err.errors.find(e => e.message.includes('replay'));
                const sigErr = err.errors.find(e => e.message.includes('signature'));
                
                if (replayErr) finalError = replayErr;
                else if (sigErr) finalError = sigErr;
                else if (err.errors.length > 0) finalError = err.errors[0];
            }

            return handleFetchError('Pull Remote', finalError, DistributionAPI.log);
        }
    }

    /**
     * @param {DistributionData} distribution 
     */
    async writeDistributionToDisk(distribution) {
        // Ensure directory exists (v3.1 Fix for ENOENT)
        await fs.mkdir(this.launcherDirectory, { recursive: true });
        await fs.writeFile(this.distroPath, JSON.stringify(distribution, null, 4));
    }

    /**
     * @returns {Promise<DistributionData | null>}
     */
    async pullLocal() {
        return await this.readDistributionFromFile(!this.devMode ? this.distroPath : this.distroDevPath);
    }

    /**
     * @param {string} path 
     * @returns {Promise<DistributionData | null>}
     */
    async readDistributionFromFile(path) {
        try {

            await fs.access(path);
            const raw = await fs.readFile(path, 'utf-8');
            try {
                return JSON.parse(raw);
            }
            catch (error) {
                DistributionAPI.log.error(`Malformed distribution file at ${path}`);
                return null;
            }
        } catch (e) {
            DistributionAPI.log.info(`No distribution file found at ${path}!`);
            return null;
        }
    }
}

module.exports = { DistributionAPI }
