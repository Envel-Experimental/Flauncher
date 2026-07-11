const { LoggerUtil } = require('../util/LoggerUtil');
const { IndexProcessor } = require('./IndexProcessor');
const { AssetGuardError } = require('./AssetGuardError');
const { validateLocalFile, getVersionJsonPath, safeEnsureDir, readFileFromZip } = require('../common/FileUtils');
const { HashAlgo } = require('./Asset');
const { Type } = require('../common/DistributionClasses');
const { mcVersionAtLeast } = require('../common/MojangUtils');
const { pLimit } = require('../util/NodeUtil');
const fs = require('fs/promises');
const path = require('path');
const MirrorManager = require('../../../../../network/MirrorManager');


class DistributionIndexProcessor extends IndexProcessor {
    static logger = LoggerUtil.getLogger('DistributionIndexProcessor');

    constructor(commonDir, distribution, serverId) {
        super(commonDir);
        this.distribution = distribution;
        this.serverId = serverId;
    }

    async init() {
        // no-op
    }

    totalStages() {
        return 1;
    }

    async validate(onStageComplete) {
        const server = this.distribution.getServerById(this.serverId);
        if (server == null) {
            throw new AssetGuardError(`Invalid server id ${this.serverId}`);
        }

        const notValid = await this.validateModules(server.modules);
        if (onStageComplete) await onStageComplete();
        return {
            distribution: notValid
        };
    }

    async postDownload() {
        await this.loadModLoaderVersionJson();
    }

    async validateModules(modules) {
        const limit = pLimit(32);

        // Flatten module tree for validation
        const flatModules = [];
        const traverse = (modList) => {
            for (const mod of modList) {
                flatModules.push(mod);
                if (mod.hasSubModules()) {
                    traverse(mod.subModules);
                }
            }
        };
        traverse(modules);

        const tasks = flatModules.map(module => {
            return limit(async () => {
                const modulePath = module.getPath();
                const artifact = module.rawModule ? module.rawModule.artifact : null;
                
                if (!artifact || !artifact.SHA256) {
                    // No supported hash found (SHA256 required). Skip validation.
                    return null;
                }

                let hash = artifact.SHA256;
                let algo = HashAlgo.SHA256;

                // Skip validation for anything in 'instances' - these are user-mutable
                if (!module.rawModule.force && modulePath.replace(/\\/g, '/').includes('/instances/')) {
                    return null;
                }

                if (!await validateLocalFile(modulePath, algo, hash, artifact.size)) {
                    const fallbackUrls = [];
                    let url = artifact.url;
                    const relUrl = artifact.relUrl;

                    if (relUrl) {
                        const sortedMirrors = MirrorManager.getSortedMirrors();
                        let first = true;
                        for (const mirror of sortedMirrors) {
                            if (mirror.distribution) {
                                let base = mirror.distribution;
                                const lastSlash = base.lastIndexOf('/');
                                // If the URL has a path (slash after the double slash of http://)
                                if (lastSlash > 7) {
                                    base = base.substring(0, lastSlash);
                                }
                                const cleanRelUrl = relUrl.startsWith('/') ? relUrl : '/' + relUrl;
                                const fullUrl = base + cleanRelUrl;
                                if (first) {
                                    url = fullUrl;
                                    first = false;
                                } else {
                                    fallbackUrls.push(fullUrl);
                                }
                            }
                        }
                    } else if (url) {
                        const sortedMirrors = MirrorManager.getSortedMirrors();
                        for (const mirror of sortedMirrors) {
                            if (mirror.distribution) {
                                const primaryBase = mirror.distribution.substring(0, mirror.distribution.lastIndexOf('/') + 1);
                                if (url.startsWith(primaryBase)) {
                                    const relPart = url.substring(primaryBase.length);
                                    for (const otherMirror of sortedMirrors) {
                                        if (otherMirror !== mirror && otherMirror.distribution) {
                                            const fallbackBase = otherMirror.distribution.substring(0, otherMirror.distribution.lastIndexOf('/') + 1);
                                            fallbackUrls.push(fallbackBase + relPart);
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                    }

                    return {
                        id: module.rawModule.id,
                        force: module.rawModule.force,
                        hash: hash,
                        algo: algo,
                        size: artifact.size,
                        url: url,
                        fallbackUrls: fallbackUrls,
                        path: modulePath
                    };
                }
                return null;
            });
        });

        const results = await Promise.all(tasks);
        return results.filter(Boolean);
    }

    async loadModLoaderVersionJson() {
        if (this.modLoaderData) return this.modLoaderData;
        const server = this.distribution.getServerById(this.serverId);
        if (server == null) {
            throw new AssetGuardError(`Invalid server id ${this.serverId}`);
        }
        const modLoaderModule = server.modules.find(({ rawModule: { type } }) => type === Type.ForgeHosted || type === Type.Forge || type === Type.Fabric);
        if (modLoaderModule == null) {
            throw new AssetGuardError('No mod loader found!');
        }
        if (modLoaderModule.rawModule.type === Type.Fabric
            || DistributionIndexProcessor.isForgeGradle3(server.rawServer.minecraftVersion, modLoaderModule.getMavenComponents().version)) {
            return await this.loadVersionManifest(modLoaderModule);
        }
        else {
            try {
                const buffer = await readFileFromZip(modLoaderModule.getPath(), 'version.json');
                const jsonText = buffer.toString('utf-8');
                if (!jsonText || jsonText.trim().length === 0) throw new Error('version.json not found or empty');

                const data = JSON.parse(jsonText);
                const writePath = getVersionJsonPath(this.commonDir, data.id);
                await safeEnsureDir(path.dirname(writePath));
                await fs.writeFile(writePath, JSON.stringify(data));
                this.modLoaderData = data;
                return data;
            } catch (e) {
                throw new AssetGuardError('Failed to extract version.json from modloader', e);
            }
        }
    }

    async loadVersionManifest(modLoaderModule) {
        const versionManifstModule = modLoaderModule.subModules.find(({ rawModule: { type } }) => type === Type.VersionManifest);
        if (versionManifstModule == null) {
            throw new AssetGuardError('No mod loader version manifest module found!');
        }
        this.modLoaderData = JSON.parse(await fs.readFile(versionManifstModule.getPath(), 'utf-8'));
        return this.modLoaderData;
    }

    static isForgeGradle3(mcVersion, forgeVersion) {
        if (mcVersionAtLeast('1.13', mcVersion)) {
            return true;
        }
        try {
            const forgeVer = forgeVersion.split('-')[1];
            const maxFG2 = [14, 23, 5, 2847];
            const verSplit = forgeVer.split('.').map(v => Number(v));
            for (let i = 0; i < maxFG2.length; i++) {
                if (verSplit[i] > maxFG2[i]) {
                    return true;
                }
                else if (verSplit[i] < maxFG2[i]) {
                    return false;
                }
            }
            return false;
        }
        catch (err) {
            throw new Error('Forge version is complex (changed).. launcher requires a patch.', { cause: err });
        }
    }
}

module.exports = { DistributionIndexProcessor }
