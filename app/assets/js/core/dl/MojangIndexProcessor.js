const path = require('path');
const fs = require('fs/promises');
const { HashAlgo } = require('./Asset');
const { AssetGuardError } = require('./AssetGuardError');
const { IndexProcessor } = require('./IndexProcessor');
const { getVersionJsonPath, validateLocalFile, getLibraryDir, getVersionJarPath, calculateHashByBuffer, safeEnsureDir } = require('../common/FileUtils');
const { downloadFile } = require('./DownloadEngine');
const { mcVersionAtLeast, isLibraryCompatible, getMojangOS } = require('../common/MojangUtils');
const { LoggerUtil } = require('../util/LoggerUtil');
const { handleFetchError } = require('../common/RestResponse');
const { MOJANG_MIRRORS, DISTRO_PUB_KEYS } = require('../../../../../network/config');
const { pLimit } = require('../util/NodeUtil');

const MirrorManager = require('../../../../../network/MirrorManager');
const { verifyDistribution } = require('../util/SignatureUtils');

class MojangIndexProcessor extends IndexProcessor {
    static LAUNCHER_JSON_ENDPOINT = 'https://launchermeta.mojang.com/mc/launcher.json';
    static VERSION_MANIFEST_ENDPOINT = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
    static PISTON_META_BASE = 'https://piston-meta.mojang.com';
    static ASSET_RESOURCE_ENDPOINT = 'https://resources.download.minecraft.net';
    static LAUNCHER_META_BASE = 'https://launchermeta.mojang.com';
    static logger = LoggerUtil.getLogger('MojangIndexProcessor');
    static mirrorManifestCache = new Map();
    static versionJsonCache = new Map();

    constructor(commonDir, version) {
        super(commonDir);
        this.version = version;
        this.assetPath = path.join(commonDir, 'assets');
    }

    async getMirrorManifest(mirror) {
        if (!mirror.version_manifest) return null;
        if (MojangIndexProcessor.mirrorManifestCache.has(mirror.version_manifest)) {
            return MojangIndexProcessor.mirrorManifestCache.get(mirror.version_manifest);
        }

        try {
            const response = await fetch(mirror.version_manifest);
            if (!response.ok) return null;
            const rawBuffer = Buffer.from(await response.arrayBuffer());

            // Verify Signature if it's our mirror
            if (MirrorManager.isMirrorUrl(mirror.version_manifest) && DISTRO_PUB_KEYS && DISTRO_PUB_KEYS.length > 0) {
                try {
                    const sigRes = await fetch(mirror.version_manifest + '.sig');
                    if (sigRes.ok) {
                        const signatureHex = (await sigRes.text()).trim();
                        const isValid = await verifyDistribution({
                            dataHex: rawBuffer.toString('hex'),
                            signatureHex: signatureHex,
                            trustedKeys: DISTRO_PUB_KEYS
                        });
                        if (!isValid) {
                            MojangIndexProcessor.logger.warn(`Signature verification failed for mirror manifest: ${mirror.version_manifest}`);
                            return null;
                        }
                    } else {
                        MojangIndexProcessor.logger.warn(`Signature file missing for mirror manifest: ${mirror.version_manifest}`);
                        return null;
                    }
                } catch (e) {
                    MojangIndexProcessor.logger.warn(`Error verifying signature for mirror manifest: ${mirror.version_manifest}`, e);
                    return null;
                }
            }

            const manifest = JSON.parse(rawBuffer.toString('utf-8'));
            MojangIndexProcessor.mirrorManifestCache.set(mirror.version_manifest, manifest);
            return manifest;
        } catch (e) {
            return null;
        }
    }

    async resolveVersionFallbacks(versionId) {
        const fallbacks = [];
        if (!MOJANG_MIRRORS) return fallbacks;

        const mirrors = MirrorManager.getSortedMirrors()
        for (const mirror of mirrors) {
            const manifest = await this.getMirrorManifest(mirror);
            if (manifest && manifest.versions) {
                const versionInfo = manifest.versions.find(v => v.id === versionId);
                if (versionInfo && versionInfo.url) {
                    fallbacks.push({ url: versionInfo.url, hash: versionInfo.sha1 });
                }
            }
        }
        return fallbacks;
    }

    async init() {
        await MirrorManager.init(MOJANG_MIRRORS)
        const versionManifest = await this.loadVersionManifest();
        this.versionJson = await this.loadVersionJson(this.version, versionManifest);
        this.assetIndex = await this.loadAssetIndex(this.versionJson);
    }

    async getVersionJson() {
        if (MojangIndexProcessor.versionJsonCache.has(this.version)) {
            return MojangIndexProcessor.versionJsonCache.get(this.version);
        }
        const versionManifest = await this.loadVersionManifest();
        this.versionJson = await this.loadVersionJson(this.version, versionManifest);
        MojangIndexProcessor.versionJsonCache.set(this.version, this.versionJson);
        return this.versionJson;
    }

    async loadAssetIndex(versionJson) {
        const assetIndexPath = this.getAssetIndexPath(versionJson.assetIndex.id);
        return await this.loadContentWithRemoteFallback(versionJson.assetIndex.url, assetIndexPath, { algo: HashAlgo.SHA1, value: versionJson.assetIndex.sha1 });
    }

    async loadVersionJson(version, versionManifest) {
        const versionJsonPath = getVersionJsonPath(this.commonDir, version);
        if (versionManifest != null) {
            const versionInfo = versionManifest.versions.find(({ id }) => id === version);
            if (versionInfo == null) {
                throw new AssetGuardError(`Invalid version: ${version}.`);
            }

            // Robust Fallback: Resolve URLs from Mirror Manifests
            const explicitFallbacks = await this.resolveVersionFallbacks(version);
            const versionJson = await this.loadContentWithRemoteFallback(versionInfo.url, versionJsonPath, { algo: HashAlgo.SHA1, value: versionInfo.sha1 }, explicitFallbacks);

            if (process.arch === 'arm64' && !mcVersionAtLeast('1.19', version)) {
                const compatVersion = '1.19.4'
                const compatVersionJsonPath = getVersionJsonPath(this.commonDir, compatVersion)
                const compatVersionInfo = versionManifest.versions.find(({ id }) => id === compatVersion)
                if (compatVersionInfo == null) {
                    throw new AssetGuardError(`Cannot find compatibility version ${compatVersion}.`)
                }
                const explicitCompatFallbacks = await this.resolveVersionFallbacks(compatVersion)
                const compatVersionJson = await this.loadContentWithRemoteFallback(compatVersionInfo.url, compatVersionJsonPath, { algo: HashAlgo.SHA1, value: compatVersionInfo.sha1 }, explicitCompatFallbacks)

                MojangIndexProcessor.logger.info(`Using LWJGL from ${compatVersion} for ARM64 compatibility (fixes mallocStack errors).`)
                versionJson.libraries = versionJson.libraries.filter(l => !l.name.startsWith('org.lwjgl:')).concat(compatVersionJson.libraries.filter(l => l.name.startsWith('org.lwjgl:')))
            }
            return versionJson;
        }
        else {
            try {
                await fs.access(versionJsonPath);
                return JSON.parse(await fs.readFile(versionJsonPath, 'utf8'));
            } catch (e) {
                throw new AssetGuardError(`Unable to load version manifest and ${version} json index does not exist locally.`);
            }
        }
    }

    async loadContentWithRemoteFallback(url, filePath, hash, extraFallbacks = [], size = 0) {
        // Prepare Mirror Candidates
        const candidates = [...extraFallbacks];

        if (MOJANG_MIRRORS && MOJANG_MIRRORS.length > 0) {
            const mirrors = MirrorManager.getSortedMirrors()
            for (const mirror of mirrors) {
                if (url.includes(MojangIndexProcessor.ASSET_RESOURCE_ENDPOINT) && mirror.assets) {
                    candidates.push(url.replace(MojangIndexProcessor.ASSET_RESOURCE_ENDPOINT, mirror.assets));
                } else if (url.includes(MojangIndexProcessor.PISTON_META_BASE) && mirror.piston_meta) {
                    candidates.push(url.replace(MojangIndexProcessor.PISTON_META_BASE, mirror.piston_meta));
                } else if (url.includes(MojangIndexProcessor.LAUNCHER_META_BASE) && mirror.launcher_meta) {
                    candidates.push(url.replace(MojangIndexProcessor.LAUNCHER_META_BASE, mirror.launcher_meta));
                } else if (url.includes(MojangIndexProcessor.VERSION_MANIFEST_ENDPOINT) && mirror.version_manifest) {
                    candidates.push(mirror.version_manifest);
                }
            }
        }

        const asset = {
            id: path.basename(filePath),
            url: url,
            path: filePath,
            algo: hash ? hash.algo : null,
            hash: hash ? hash.value : null,
            fallbackUrls: candidates,
            size: size,
            verifySignature: true
        };

        await downloadFile(asset);
        const content = await fs.readFile(filePath, 'utf8');
        return JSON.parse(content);
    }

    async loadVersionManifest() {
        const manifestPath = path.join(this.commonDir, 'version_manifest_v2.json');

        const candidates = [];
        if (MOJANG_MIRRORS && MOJANG_MIRRORS.length > 0) {
            const mirrors = MirrorManager.getSortedMirrors()
            for (const mirror of mirrors) {
                if (mirror.version_manifest) {
                    candidates.push(mirror.version_manifest);
                }
            }
        }

        const asset = {
            id: 'version_manifest_v2.json',
            url: MojangIndexProcessor.VERSION_MANIFEST_ENDPOINT,
            path: manifestPath,
            algo: null, // No hash verification for root manifest
            hash: null,
            fallbackUrls: candidates,
            verifySignature: true,
            force: true,
            maxAttempts: 3
        };

        try {
            await downloadFile(asset);
            const data = await fs.readFile(manifestPath, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            MojangIndexProcessor.logger.warn('Failed to download Mojang Version Manifest via DownloadEngine. Falling back to cache.', err);
            try {
                await fs.access(manifestPath);
                const data = await fs.readFile(manifestPath, 'utf8');
                return JSON.parse(data);
            } catch (e) {
                // If both network and cache fail, re-throw the original DownloadEngine error so `landing.js` can report it.
                throw err;
            }
        }
    }

    getAssetIndexPath(id) {
        return path.join(this.assetPath, 'indexes', `${id}.json`);
    }

    totalStages() {
        return 4;
    }

    async validate(onStageComplete) {
        const assets = await this.validateAssets(this.assetIndex);
        if (onStageComplete) await onStageComplete();
        const libraries = await this.validateLibraries(this.versionJson);
        if (onStageComplete) await onStageComplete();
        const client = await this.validateClient(this.versionJson);
        if (onStageComplete) await onStageComplete();
        const logConfig = await this.validateLogConfig(this.versionJson);
        if (onStageComplete) await onStageComplete();
        return {
            assets,
            libraries,
            client,
            misc: [
                ...logConfig
            ]
        };
    }

    async postDownload() {
        // no-op
    }

    async validateAssets(assetIndex) {
        const objectDir = path.join(this.assetPath, 'objects');
        const limit = pLimit(32); // Concurrency limit 32

        const tasks = Object.entries(assetIndex.objects).map(([id, meta]) => {
            return limit(async () => {
                // Skip unnecessary language files (Only keep EN and RU)
                const isLangFile = id.startsWith('minecraft/lang/') || id.startsWith('realms/lang/') || id.includes('/lang/');
                if (isLangFile) {
                    const isEssential = id.endsWith('en_us.json') ||
                        id.endsWith('en_gb.json') ||
                        id.endsWith('ru_ru.json') ||
                        id.endsWith('en_us.lang') ||
                        id.endsWith('ru_ru.lang');
                    if (!isEssential) return null;
                }

                const hash = meta.hash;
                const filePath = path.join(objectDir, hash.substring(0, 2), hash);
                const url = `${MojangIndexProcessor.ASSET_RESOURCE_ENDPOINT}/${hash.substring(0, 2)}/${hash}`;

                const fallbackUrls = [];
                if (MOJANG_MIRRORS && MOJANG_MIRRORS.length > 0) {
                    const mirrors = MirrorManager.getSortedMirrors()
                    for (const mirror of mirrors) {
                        if (mirror.assets) {
                            fallbackUrls.push(`${mirror.assets}/${hash.substring(0, 2)}/${hash}`);
                        }
                    }
                }

                if (!await validateLocalFile(filePath, HashAlgo.SHA1, hash, meta.size)) {
                    return {
                        id,
                        hash,
                        algo: HashAlgo.SHA1,
                        size: meta.size,
                        url,
                        fallbackUrls,
                        path: filePath
                    };
                }
                return null;
            });
        });

        const results = await Promise.all(tasks);
        return results.filter(Boolean);
    }

    async validateLibraries(versionJson) {
        const libDir = getLibraryDir(this.commonDir);
        const limit = pLimit(32);

        const tasks = versionJson.libraries.map(libEntry => {
            return limit(async () => {
                if (isLibraryCompatible(libEntry.rules, libEntry.natives, libEntry.name)) {
                    let artifact;
                    if (libEntry.natives == null) {
                        artifact = libEntry.downloads.artifact;
                    }
                    else {
                        const classifier = libEntry.natives[getMojangOS()].replace('${arch}', process.arch.replace('x', ''));
                        artifact = libEntry.downloads.classifiers[classifier];
                    }

                    if (artifact) {
                        const filePath = path.join(libDir, artifact.path);
                        const hash = artifact.sha1;
                        if (!await validateLocalFile(filePath, HashAlgo.SHA1, hash, artifact.size)) {
                            return {
                                id: libEntry.name,
                                hash,
                                algo: HashAlgo.SHA1,
                                size: artifact.size,
                                url: artifact.url,
                                fallbackUrls: MirrorManager.getSortedMirrors().map(m => m.libraries ? artifact.url.replace('https://libraries.minecraft.net', m.libraries) : null).filter(Boolean), // Assuming libraries mirror logic if needed, or strict.
                                path: filePath
                            };
                        }
                    }
                }
                return null;
            });
        });

        const results = await Promise.all(tasks);
        return results.filter(Boolean);
    }

    async validateClient(versionJson) {
        const version = versionJson.id;
        const versionJarPath = getVersionJarPath(this.commonDir, version);
        const hash = versionJson.downloads.client.sha1;
        if (!await validateLocalFile(versionJarPath, HashAlgo.SHA1, hash, versionJson.downloads.client.size)) {
            return [{
                id: `${version} client`,
                hash,
                algo: HashAlgo.SHA1,
                size: versionJson.downloads.client.size,
                url: versionJson.downloads.client.url,
                path: versionJarPath,
                fallbackUrls: MirrorManager.getSortedMirrors().map(m => m.client ? versionJson.downloads.client.url.replace('https://piston-data.mojang.com', m.client) : null).filter(Boolean)
            }];
        }
        return [];
    }

    async validateLogConfig(versionJson) {
        if (!versionJson.logging || !versionJson.logging.client) return [];
        const logFile = versionJson.logging.client.file;
        const filePath = path.join(this.assetPath, 'log_configs', logFile.id);
        const hash = logFile.sha1;
        if (!await validateLocalFile(filePath, HashAlgo.SHA1, hash, logFile.size)) {
            return [{
                id: logFile.id,
                hash,
                algo: HashAlgo.SHA1,
                size: logFile.size,
                url: logFile.url,
                fallbackUrls: MirrorManager.getSortedMirrors().map(m => m.piston_meta ? logFile.url.replace('https://piston-meta.mojang.com', m.piston_meta) : null).filter(Boolean),
                path: filePath
            }];
        }
        return [];
    }
}

module.exports = { MojangIndexProcessor }
