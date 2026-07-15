// @ts-check

const { MavenUtil } = require('./MavenUtil');
const { join } = require('path');
const { ensureEncodedPath } = require('../util/NodeUtil');
const { mcVersionAtLeast } = require('./MojangUtils');

const Type = {
    Library: 'Library',
    Forge: 'Forge',
    ForgeHosted: 'ForgeHosted',
    Fabric: 'Fabric',
    LiteLoader: 'LiteLoader',
    ForgeMod: 'ForgeMod',
    LiteMod: 'LiteMod',
    FabricMod: 'FabricMod',
    File: 'File',
    VersionManifest: 'VersionManifest'
}

const Platform = {
    DARWIN: 'darwin',
    WIN32: 'win32',
    LINUX: 'linux'
}

const JdkDistribution = {
    CORRETTO: 'corretto',
    TEMURIN: 'temurin'
}

class HeliosDistribution {
    /**
     * @param {DistributionData} rawDistribution 
     * @param {string} commonDir 
     * @param {string} instanceDir 
     */
    constructor(rawDistribution, commonDir, instanceDir) {
        this.rawDistribution = rawDistribution;
        /** @type {number | null} */
        this.mainServerIndex = null;
        this.resolveMainServerIndex();
        this.servers = this.rawDistribution.servers.map(s => new HeliosServer(s, commonDir, instanceDir));
    }

    resolveMainServerIndex() {
        if (this.rawDistribution.servers.length > 0) {
            for (let i = 0; i < this.rawDistribution.servers.length; i++) {
                if (this.mainServerIndex == null) {
                    if (this.rawDistribution.servers[i].mainServer) {
                        this.mainServerIndex = i;
                    }
                }
                else {
                    this.rawDistribution.servers[i].mainServer = false;
                }
            }
            if (this.mainServerIndex == null) {
                this.mainServerIndex = 0;
                this.rawDistribution.servers[this.mainServerIndex].mainServer = true;
            }
        }
        else {
            console.warn('Distribution has 0 configured servers. This doesnt seem right..');
            this.mainServerIndex = 0;
        }
    }

    /**
     * @returns {HeliosServer | null}
     */
    getMainServer() {
        return this.mainServerIndex != null && this.mainServerIndex < this.servers.length ? this.servers[this.mainServerIndex] : null;
    }

    /**
     * @param {string} id 
     * @returns {HeliosServer | null}
     */
    getServerById(id) {
        return this.servers.find(s => s.rawServer.id === id) || null;
    }
}

class HeliosServer {
    /**
     * @param {ServerData} data
     * @param {string} commonDir 
     * @param {string} instanceDir 
     */
    constructor(data, commonDir, instanceDir) {
        this.rawServer = data;
        this.commonDir = commonDir;
        this.instanceDir = instanceDir;
        const { hostname, port } = this.parseAddress();
        this.hostname = hostname;
        this.port = port;
        this.effectiveJavaOptions = this.parseEffectiveJavaOptions();
        this.modules = this.rawServer.modules.map(m => new HeliosModule(m, this.rawServer.id, commonDir, instanceDir));
    }

    /**
     * @returns {{hostname: string, port: number}}
     */
    parseAddress() {
        if (this.rawServer.address.includes(':')) {
            const pieces = this.rawServer.address.split(':');
            const port = Number(pieces[1]);
            if (!Number.isInteger(port)) {
                throw new Error(`Malformed server address for ${this.rawServer.id}. Port must be an integer!`);
            }
            return { hostname: pieces[0], port };
        }
        else {
            return { hostname: this.rawServer.address, port: 25565 };
        }
    }

    parseEffectiveJavaOptions() {
        const options = this.rawServer.javaOptions?.platformOptions ?? [];
        /** @type {any[]} */
        const mergeableProps = [];
        for (const option of options) {
            if (option.platform === process.platform) {
                if (option.architecture === process.arch) {
                    mergeableProps[0] = option;
                }
                else {
                    mergeableProps[1] = option;
                }
            }
        }
        mergeableProps[3] = {
            distribution: this.rawServer.javaOptions?.distribution,
            supported: this.rawServer.javaOptions?.supported,
            suggestedMajor: this.rawServer.javaOptions?.suggestedMajor
        };
        const merged = {};
        for (let i = mergeableProps.length - 1; i >= 0; i--) {
            if (mergeableProps[i] != null) {
                merged.distribution = mergeableProps[i].distribution;
                merged.supported = mergeableProps[i].supported;
                merged.suggestedMajor = mergeableProps[i].suggestedMajor;
            }
        }
        return this.defaultUndefinedJavaOptions(merged);
    }

    defaultUndefinedJavaOptions(props) {
        const [defaultRange, defaultSuggestion] = this.defaultJavaVersion();
        return {
            supported: props.supported ?? defaultRange,
            distribution: props.distribution ?? this.defaultJavaPlatform(),
            suggestedMajor: props.suggestedMajor ?? defaultSuggestion,
        };
    }

    defaultJavaVersion() {
        const mc = this.rawServer.minecraftVersion;
        if (mcVersionAtLeast('1.20.5', mc)) {
            // For 1.20.5+, Java 21 is required.
            return ['>=21.0.0 <26.0.0', 21];
        }
        else if (mcVersionAtLeast('1.17', mc)) {
            // For 1.17 to 1.20.4, Java 17 is recommended but 21 works.
            return ['>=17.0.0 <26.0.0', 17];
        }
        else {
            // For 1.16.5 and below, Java 8 is required.
            return ['8.x', 8];
        }
    }

    defaultJavaPlatform() {
        return process.platform === Platform.DARWIN ? JdkDistribution.CORRETTO : JdkDistribution.TEMURIN;
    }
}

class HeliosModule {
    /**
     * @param {ModuleData} rawModule 
     * @param {string} serverId 
     * @param {string} commonDir 
     * @param {string} instanceDir 
     */
    constructor(rawModule, serverId, commonDir, instanceDir) {
        this.rawModule = rawModule;
        this.serverId = serverId;
        this.mavenComponents = this.resolveMavenComponents();
        this.required = this.resolveRequired();
        this.localPath = this.resolveLocalPath(commonDir, instanceDir);
        if (this.rawModule.subModules != null) {
            this.subModules = this.rawModule.subModules.map(m => new HeliosModule(m, serverId, commonDir, instanceDir));
        }
        else {
            /** @type {HeliosModule[]} */
            this.subModules = [];
        }
    }

    resolveMavenComponents() {
        if (this.rawModule.type === Type.File && this.rawModule.artifact && this.rawModule.artifact.path != null) {
            return null;
        }
        if (this.rawModule.type === Type.VersionManifest) {
            return null;
        }
        const isMavenId = MavenUtil.isMavenIdentifier(this.rawModule.id);
        if (!isMavenId) {
            if (this.rawModule.type !== Type.File) {
                throw new Error(`Module ${this.rawModule.name} (${this.rawModule.id}) of type ${this.rawModule.type} must have a valid maven identifier!`);
            }
            else {
                throw new Error(`Module ${this.rawModule.name} (${this.rawModule.id}) of type ${this.rawModule.type} must either declare an artifact path or have a valid maven identifier!`);
            }
        }
        try {
            return MavenUtil.getMavenComponents(this.rawModule.id);
        }
        catch (err) {
            throw new Error(`Failed to resolve maven components for module ${this.rawModule.name} (${this.rawModule.id}) of type ${this.rawModule.type}. Reason: ${err.message}`, { cause: err });
        }
    }

    resolveRequired() {
        if (this.rawModule.required == null) {
            return {
                value: true,
                def: true
            };
        }
        else {
            return {
                value: this.rawModule.required.value ?? true,
                def: this.rawModule.required.def ?? true
            };
        }
    }

    resolveLocalPath(commonDir, instanceDir) {
        if (this.rawModule.type === Type.VersionManifest) {
            return ensureEncodedPath(join(commonDir, 'versions', this.rawModule.id, `${this.rawModule.id}.json`));
        }
        const relativePath = (this.rawModule.artifact && this.rawModule.artifact.path) ?? MavenUtil.mavenComponentsAsNormalizedPath(this.mavenComponents.group, this.mavenComponents.artifact, this.mavenComponents.version, this.mavenComponents.classifier, this.mavenComponents.extension);
        switch (this.rawModule.type) {
            case Type.Library:
            case Type.Forge:
            case Type.ForgeHosted:
            case Type.Fabric:
            case Type.LiteLoader:
                return ensureEncodedPath(join(commonDir, 'libraries', relativePath));
            case Type.ForgeMod:
            case Type.LiteMod:
                return ensureEncodedPath(join(commonDir, 'modstore', relativePath));
            case Type.FabricMod:
                return ensureEncodedPath(join(commonDir, 'mods', 'fabric', relativePath));
            case Type.File:
            default:
                return ensureEncodedPath(join(instanceDir, this.serverId, relativePath));
        }
    }

    hasMavenComponents() {
        return this.mavenComponents != null;
    }
    getMavenComponents() {
        return this.mavenComponents;
    }
    getRequired() {
        try {
            const isRenderer = typeof process !== 'undefined' && process.type === 'renderer';
            const isDev = isRenderer ? window.isDev : (require('electron').app ? !require('electron').app.isPackaged : false);
            if (isDev) {
                return {
                    value: false,
                    def: this.required ? this.required.def : false
                };
            }
        } catch (e) {
            // Ignore environment check errors
        }
        return this.required;
    }
    getPath() {
        return this.localPath;
    }
    getMavenIdentifier() {
        return MavenUtil.mavenComponentsToIdentifier(this.mavenComponents.group, this.mavenComponents.artifact, this.mavenComponents.version, this.mavenComponents.classifier, this.mavenComponents.extension);
    }
    getExtensionlessMavenIdentifier() {
        return MavenUtil.mavenComponentsToExtensionlessIdentifier(this.mavenComponents.group, this.mavenComponents.artifact, this.mavenComponents.version, this.mavenComponents.classifier);
    }
    getVersionlessMavenIdentifier() {
        return MavenUtil.mavenComponentsToVersionlessIdentifier(this.mavenComponents.group, this.mavenComponents.artifact, this.mavenComponents.classifier);
    }
    hasSubModules() {
        return this.subModules.length > 0;
    }
}

module.exports = { HeliosDistribution, HeliosServer, HeliosModule, Type, Platform, JdkDistribution }
