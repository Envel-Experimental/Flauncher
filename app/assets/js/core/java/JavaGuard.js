const { exec, execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const util = require('util');
const semver = require('semver');
const { LoggerUtil } = require('../util/LoggerUtil');
const { HashAlgo } = require('../dl/Asset');
const { extractZip, extractTarGz } = require('../common/FileUtils');
const { Platform, javaExecFromRoot, ensureJavaDirIsRoot, resolveNativeArch } = require('./JavaUtils');
const { JdkDistribution } = require('../common/DistributionClasses');

const log = LoggerUtil.getLogger('JavaGuard');

async function execAsync(cmd, opts) {
    return new Promise((resolve, reject) => {
        require('child_process').exec(cmd, opts, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
        });
    });
}

async function execFileAsync(file, args, opts) {
    return new Promise((resolve, reject) => {
        require('child_process').execFile(file, args, opts, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
        });
    });
}

/**
 * Perform a fetch with a 10s timeout.
 */
async function fetchWithTimeout(url, options = {}, timeout = 10000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

const { MOJANG_MIRRORS, DISTRO_PUB_KEYS } = require('../../../../../network/config');
const { verifyDistribution } = require('../util/SignatureUtils');
const MirrorManager = require('../../../../../network/MirrorManager');

let javaMirrorManifestMap = new Map(); // url -> manifest

async function getHotSpotSettings(execPath) {
    if (!execPath || execPath.trim() === '') {
        log.warn('getHotSpotSettings called with empty path');
        return null;
    }
    const javaExecutable = path.resolve(execPath.includes('javaw.exe') ? execPath.replace('javaw.exe', 'java.exe') : execPath);
    try {
        await fs.access(javaExecutable);
    } catch (e) {
        log.warn(`Candidate JVM path does not exist, skipping. ${javaExecutable}`);
        return null;
    }

    let stderr;
    try {
        stderr = (await execFileAsync(javaExecutable, ['-XshowSettings:properties', '-version'], {
            cwd: path.dirname(javaExecutable)
        })).stderr;
    }
    catch (error) {
        log.error(`Failed to resolve JVM settings for '${execPath}'`, error);
        return null;
    }
    const listProps = [
        'java.library.path'
    ];
    const ret = {};
    const split = stderr.split('\n');
    let lastProp = null;
    for (const prop of split) {
        if (prop.startsWith('        ')) {
            if (!Array.isArray(ret[lastProp])) {
                ret[lastProp] = [ret[lastProp]];
            }
            ret[lastProp].push(prop.trim());
        }
        else if (prop.startsWith('    ')) {
            const tmp = prop.split('=');
            const key = tmp[0].trim();
            const val = tmp[1].trim();
            ret[key] = val;
            lastProp = key;
        }
    }
    for (const key of listProps) {
        if (ret[key] != null && !Array.isArray(ret[key])) {
            ret[key] = [ret[key]];
        }
    }
    return ret;
}

async function resolveJvmSettings(paths) {
    const ret = {};
    for (const p of paths) {
        const settings = await getHotSpotSettings(javaExecFromRoot(p));
        if (settings != null) {
            ret[p] = settings;
        }
        else {
            log.warn(`Skipping invalid JVM candidate: ${p}`);
        }
    }
    return ret;
}

function filterApplicableJavaPaths(resolvedSettings, semverRange) {
    const arm = resolveNativeArch() === 'arm64';
    const jvmDetailsUnfiltered = Object.entries(resolvedSettings)
        .filter(([, settings]) => parseInt(settings['sun.arch.data.model']) === 64)
        .filter(([, settings]) => arm ? (settings['os.arch'] === 'aarch64' || settings['os.arch'] === 'arm64') : true)
        .map(([path, settings]) => {
            const parsedVersion = parseJavaRuntimeVersion(settings['java.version']);
            if (parsedVersion == null) {
                log.error(`Failed to parse JDK version at location '${path}' (Vendor: ${settings['java.vendor']}). Ensure this is a valid HotSpot or GraalVM build.`);
                return null;
            }
            return {
                semver: parsedVersion,
                semverStr: javaVersionToString(parsedVersion),
                vendor: settings['java.vendor'],
                path: javaExecFromRoot(path)
            };
        })
        .filter(x => x != null);

    const jvmDetails = jvmDetailsUnfiltered
        .filter(details => semver.satisfies(details.semverStr, semverRange));
    return jvmDetails;
}

function rankApplicableJvms(jvmDetails, suggestedMajor = null) {
    jvmDetails.sort((a, b) => {
        if (suggestedMajor !== null) {
            const targetMajor = parseInt(suggestedMajor, 10);
            const aIsSuggested = a.semver.major === targetMajor;
            const bIsSuggested = b.semver.major === targetMajor;
            if (aIsSuggested && !bIsSuggested) return -1;
            if (!aIsSuggested && bIsSuggested) return 1;
        }

        if (a.semver.major === b.semver.major) {
            if (a.semver.minor === b.semver.minor) {
                if (a.semver.patch === b.semver.patch) {
                    if (a.path.toLowerCase().includes('jdk')) {
                        return b.path.toLowerCase().includes('jdk') ? 0 : -1;
                    }
                    else {
                        return b.path.toLowerCase().includes('jdk') ? 1 : 0;
                    }
                }
                else {
                    return (a.semver.patch - b.semver.patch) * -1;
                }
            }
            else {
                return (a.semver.minor - b.semver.minor) * -1;
            }
        }
        else {
            return (a.semver.major - b.semver.major) * -1;
        }
    });
}

async function discoverBestJvmInstallation(dataDir, semverRange, suggestedMajor = null) {
    const paths = [...new Set(await getValidatableJavaPaths(dataDir))];
    const resolvedSettings = await resolveJvmSettings(paths);
    const jvmDetails = filterApplicableJavaPaths(resolvedSettings, semverRange);
    rankApplicableJvms(jvmDetails, suggestedMajor);
    return jvmDetails.length > 0 ? jvmDetails[0] : null;
}

async function discoverAllJvmInstallations(dataDir, semverRange = '*', suggestedMajor = null) {
    const paths = [...new Set(await getValidatableJavaPaths(dataDir))];
    const resolvedSettings = await resolveJvmSettings(paths);
    const jvmDetails = filterApplicableJavaPaths(resolvedSettings, semverRange);
    rankApplicableJvms(jvmDetails, suggestedMajor);
    return jvmDetails;
}

async function validateSelectedJvm(path, semverRange) {
    if (!path || String(path).trim() === '' || path === 'null') {
        return null;
    }
    try {
        await fs.access(path);
    } catch (e) { /* Java binary inaccessible */ return null; }

    const resolvedSettings = await resolveJvmSettings([path]);

    // We utilize the provided semver range to ensure the selected Java is valid.
    // Use '*' if no range is provided (fallback).
    const jvmDetails = filterApplicableJavaPaths(resolvedSettings, semverRange || '*');

    rankApplicableJvms(jvmDetails);
    return jvmDetails.length > 0 ? jvmDetails[0] : null;
}

async function loadJavaMirrorManifest(mirrorUrl) {
    if (javaMirrorManifestMap.has(mirrorUrl)) {
        return javaMirrorManifestMap.get(mirrorUrl);
    }
    try {
        const res = await fetchWithTimeout(mirrorUrl, { cache: 'no-store' });
        if (res.ok) {
            const rawBuffer = Buffer.from(await res.arrayBuffer());
            const manifest = JSON.parse(rawBuffer.toString('utf-8'));

            // Verification logic for custom mirrors
            if (DISTRO_PUB_KEYS && DISTRO_PUB_KEYS.length > 0) {
                log.info(`Verifying signature for Java manifest: ${mirrorUrl}`);
                try {
                    const sigRes = await fetchWithTimeout(mirrorUrl + '.sig', { cache: 'no-store' }, 5000);
                    if (sigRes.ok) {
                        const signatureHex = (await sigRes.text()).trim();
                        const signatureValid = await verifyDistribution({
                            dataHex: rawBuffer.toString('hex'),
                            signatureHex: signatureHex,
                            trustedKeys: DISTRO_PUB_KEYS
                        });

                        if (!signatureValid) {
                            log.error(`CRITICAL: Java manifest signature verification FAILED for ${mirrorUrl}`);
                            return null;
                        }
                        log.info(`Java manifest signature VALID for ${mirrorUrl}`);
                    } else {
                        log.error(`CRITICAL: Java manifest signature MISSING for ${mirrorUrl}. Mandatory for custom mirrors.`);
                        return null;
                    }
                } catch (sigErr) {
                    log.error(`Failed to verify Java manifest signature for ${mirrorUrl}`, sigErr);
                    return null;
                }
            }

            javaMirrorManifestMap.set(mirrorUrl, manifest);
            return manifest;
        }
    } catch (e) {
        log.warn(`Failed to fetch Java mirror manifest from ${mirrorUrl}`, e);
    }
    return null;
}

async function latestOpenJDK(major, dataDir, distribution) {
    const mirrors = (MirrorManager.initialized ? MirrorManager.getSortedMirrors() : MOJANG_MIRRORS).filter(m => m.java_manifest)
    
    /** @type {Promise<{ source: string, data: any, latency: number }>[]} */
    const tasks = []

    // 1. Create Mirror Tasks
    for (const mirror of mirrors) {
        tasks.push((async () => {
            const start = Date.now()
            const manifest = await loadJavaMirrorManifest(mirror.java_manifest)
            if (manifest) {
                const os = process.platform === Platform.WIN32 ? 'windows' : (process.platform === Platform.DARWIN ? 'mac' : process.platform)
                const arch = resolveNativeArch() === 'arm64' ? 'aarch64' : 'x64'
                const field = (distribution === 'installer' && os === 'windows') ? 'installer' : major.toString()

                if (manifest[os] && manifest[os][arch] && manifest[os][arch][field]) {
                    const entry = manifest[os][arch][field]
                    
                    let resolvedUrl = entry.url
                    if (entry.relUrl && mirror.java_manifest) {
                        const lastSlash = mirror.java_manifest.lastIndexOf('/');
                        const base = lastSlash > 7 ? mirror.java_manifest.substring(0, lastSlash) : mirror.java_manifest;
                        const cleanRelUrl = entry.relUrl.startsWith('/') ? entry.relUrl : '/' + entry.relUrl;
                        resolvedUrl = base + cleanRelUrl;
                    }

                    return {
                        source: `Mirror (${mirror.name})`,
                        latency: Date.now() - start,
                        data: {
                            url: resolvedUrl,
                            size: entry.size,
                            id: entry.name,
                            hash: entry.sha1,
                            algo: HashAlgo.SHA1,
                            path: path.join(getLauncherRuntimeDir(dataDir), entry.name),
                            isInstaller: field === 'installer'
                        }
                    }
                }
            }
            throw new Error(`Mirror ${mirror.name} did not provide Java ${major}`)
        })())
    }

    // 2. Create Official Task
    tasks.push((async () => {
        const start = Date.now()
        let result = null
        try {
            if (distribution == null) {
                if (major >= 17) {
                    const graal = await latestGraalVM(major, dataDir)
                    if (graal) result = graal
                    else result = await latestAdoptium(major, dataDir)
                } else {
                    result = await latestAdoptium(major, dataDir)
                }
            } else {
                switch (distribution) {
                    case 'graalvm': result = await latestGraalVM(major, dataDir); break
                    case JdkDistribution.TEMURIN:
                    case 'temurin': result = await latestAdoptium(major, dataDir); break
                    case JdkDistribution.CORRETTO: result = await latestCorretto(major, dataDir); break
                    case 'installer': result = await latestAdoptium(major, dataDir, 'installer'); break
                    default: throw new Error(`Unknown distribution '${distribution}'`)
                }
            }
        } catch (e) {
            throw new Error(`Official resolution failed: ${e.message}`, { cause: e })
        }
        
        if (result) {
            return {
                source: 'Official (Adoptium/GitHub)',
                latency: Date.now() - start,
                data: result
            }
        }
        throw new Error('No Java found from official sources')
    })())

    // RACE!
    try {
        const fastest = await Promise.any(tasks)
        log.info(`Java ${major} resolved from ${fastest.source} in ${fastest.latency}ms`)
        return fastest.data
    } catch (e) {
        log.error(`Failed to resolve Java ${major} from any source.`, e)
        return null
    }
}

async function latestGraalVM(major, dataDir) {
    // 1. Try Liberica NIK (Mirror - BellSoft servers, usually faster/more reliable than GitHub raw)
    try {
        const nik = await latestLibericaNIK(major, dataDir);
        if (nik) return nik;
    } catch (e) {
        log.warn(`Liberica NIK mirror failed for Java ${major}, falling back to GitHub.`, e);
    }

    // 2. Fallback to GitHub (Official GraalVM CE)
    return await latestGraalVM_GitHub(major, dataDir);
}

async function latestLibericaNIK(major, dataDir) {
    const arch = resolveNativeArch() === 'arm64' ? 'aarch64' : 'x64'; // Liberica uses specific arch names
    const os = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');
    const bitness = '64';
    const packageType = process.platform === 'win32' ? 'zip' : 'tar.gz';

    // BellSoft API v1 for NIK
    // https://api.bell-sw.com/v1/nik/releases?version-feature={major}&os={os}&arch={arch}&bitness=64&package-type={type}
    const url = `https://api.bell-sw.com/v1/nik/releases?version-feature=${major}&os=${os}&arch=${arch}&bitness=${bitness}&package-type=${packageType}&bundle-type=standard`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`BellSoft API Error ${res.status}`);

    const releases = await res.json();
    if (!releases || releases.length === 0) return null;

    // Get latest version
    const latest = releases[0]; // API usually sorts by version? Verification needed, but typically yes.

    // Construct download info
    return {
        url: latest.downloadUrl,
        size: latest.size,
        id: latest.filename, // e.g. bellsoft-nik23.0.1-linux-amd64.tar.gz
        hash: latest.sha1, // BellSoft provides sha1 usually
        algo: HashAlgo.SHA1,
        path: path.join(getLauncherRuntimeDir(dataDir), latest.filename)
    };
}

async function latestGraalVM_GitHub(major, dataDir) {
    const arch = resolveNativeArch() === 'arm64' ? 'aarch64' : 'x64';
    let sanitizedOS;
    let ext;

    switch (process.platform) {
        case Platform.WIN32:
            sanitizedOS = 'windows';
            ext = 'zip';
            break;
        case Platform.DARWIN:
            sanitizedOS = 'macos';
            ext = 'tar.gz';
            break;
        case Platform.LINUX:
            sanitizedOS = 'linux';
            ext = 'tar.gz';
            break;
        default:
            sanitizedOS = process.platform;
            ext = 'tar.gz';
            break;
    }

    // GraalVM Community Edition (GitHub Releases)
    // Matches formats like: graalvm-community-jdk-21.0.2_windows-x64_bin.zip
    const repo = 'graalvm/graalvm-ce-builds';

    // We want the absolute latest release that matches our Major version
    // GitHub API 'latest' might be 22 while we want 21. 
    // So we list releases and find the first one matching 'jdk-{major}.'

    const url = `https://api.github.com/repos/${repo}/releases`;

    try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) {
            log.warn(`GitHub API Error ${res.status} while fetching GraalVM. This might be due to rate limits.`);
            return null;
        }
        const releases = await res.json();

        // Find release for this major version
        const targetRelease = releases.find(r => r.tag_name && r.tag_name.startsWith(`jdk-${major}.`));

        if (!targetRelease) {
            log.warn(`No GraalVM release found for Java ${major}`);
            return null;
        }

        const asset = targetRelease.assets.find(a =>
            a.name.toLowerCase().includes(sanitizedOS) &&
            a.name.toLowerCase().includes(arch) &&
            a.name.endsWith(ext)
        );

        if (asset) {
            return {
                url: asset.browser_download_url,
                size: asset.size,
                id: asset.name,
                hash: null,
                algo: null,
                path: path.join(getLauncherRuntimeDir(dataDir), asset.name)
            };
        }

        return null;
    } catch (err) {
        log.error(`Error fetching GraalVM for Java ${major}`, err);
        return null;
    }
}

async function latestAdoptium(major, dataDir, distribution = null) {
    const isInstaller = distribution === 'installer';
    const sanitizedOS = process.platform === Platform.WIN32 ? 'windows' : (process.platform === Platform.DARWIN ? 'mac' : process.platform);
    const arch = resolveNativeArch() === 'arm64' ? 'aarch64' : 'x64';
    const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?vendor=eclipse`;
    try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) {
            log.error(`Adoptium API returned ${res.status} for URL: ${url}`);
            throw new Error(`HTTP ${res.status}`);
        }
        const body = await res.json();
        log.info(`Adoptium API returned ${body.length} binaries for JDK ${major}. Filtering for OS: ${sanitizedOS}, Arch: ${arch}, Installer: ${isInstaller}`);

        if (body.length > 0) {
            const targetBinary = body.find(entry => {
                let pkgMatch = true;
                if (process.platform === Platform.WIN32) {
                    pkgMatch = isInstaller ? entry.binary.package.name.endsWith('.msi') : entry.binary.package.name.endsWith('.zip');
                }
                const entryMajor = entry.version.major
                const match = entryMajor == major
                    && entry.binary.os === sanitizedOS
                    && entry.binary.image_type === 'jdk'
                    && entry.binary.architecture === arch
                    && pkgMatch;
                return match;
            });
            if (targetBinary != null) {
                return {
                    url: targetBinary.binary.package.link,
                    size: targetBinary.binary.package.size,
                    id: targetBinary.binary.package.name,
                    hash: targetBinary.binary.package.checksum,
                    algo: HashAlgo.SHA256,
                    path: path.join(getLauncherRuntimeDir(dataDir), targetBinary.binary.package.name),
                    isInstaller: isInstaller
                };
            }
        }
        log.error(`Failed to find a suitable Adoptium binary for JDK ${major} (${sanitizedOS} ${arch}, installer: ${isInstaller}).`);
        if (isInstaller) {
            log.warn(`Falling back to standard ZIP distribution for JDK ${major} since MSI was not found.`);
            return await latestAdoptium(major, dataDir, null);
        }
        return null;
    }
    catch (err) {
        log.error(`Error while retrieving latest Adoptium JDK ${major} binaries.`, err);
        return null;
    }
}

async function latestCorretto(major, dataDir) {
    let sanitizedOS, ext;
    const arch = resolveNativeArch() === 'arm64' ? 'aarch64' : 'x64';
    switch (process.platform) {
        case Platform.WIN32:
            sanitizedOS = 'windows';
            ext = 'zip';
            break;
        case Platform.DARWIN:
            sanitizedOS = 'macos';
            ext = 'tar.gz';
            break;
        case Platform.LINUX:
            sanitizedOS = 'linux';
            ext = 'tar.gz';
            break;
        default:
            sanitizedOS = process.platform;
            ext = 'tar.gz';
            break;
    }
    const url = `https://corretto.aws/downloads/latest/amazon-corretto-${major}-${arch}-${sanitizedOS}-jdk.${ext}`;

    try {
        const res = await fetchWithTimeout(url, { method: 'HEAD' });
        if (res.ok) {
            const finalUrl = res.url;
            const name = finalUrl.substring(finalUrl.lastIndexOf('/') + 1);
            return {
                url: finalUrl,
                size: parseInt(res.headers.get('content-length')),
                id: name,
                hash: null,
                algo: null,
                path: path.join(getLauncherRuntimeDir(dataDir), name)
            };
        }
        log.error(`Error while retrieving latest Corretto JDK ${major} (${sanitizedOS} ${arch}): ${res.status}`);
        return null;
    }
    catch (err) {
        log.error(`Error while retrieving latest Corretto JDK ${major} (${sanitizedOS} ${arch}).`, err);
        return null;
    }
}

async function extractJdk(archivePath) {
    let javaExecPath = null;
    if (archivePath.endsWith('zip')) {
        await extractZip(archivePath, async (zip) => {
            const entries = zip.entries();
            const keys = Object.keys(entries);
            javaExecPath = javaExecFromRoot(path.join(path.dirname(archivePath), keys[0]));
        });
    }
    else {
        await extractTarGz(archivePath, async (header) => {
            if (javaExecPath == null) {
                let h = header.name;
                if (h.includes('/')) {
                    h = h.substring(0, h.indexOf('/'));
                }
                javaExecPath = javaExecFromRoot(path.join(path.dirname(archivePath), h));
            }
        });
    }
    return javaExecPath;
}

async function runInstaller(installerPath) {
    if (process.platform === Platform.WIN32) {
        log.info(`Running MSI installer: ${installerPath}`);
        const { execFile } = require('child_process');
        return new Promise((resolve, reject) => {
            execFile('msiexec', ['/i', installerPath, '/passive'], (err) => {
                if (err) {
                    log.error('Installer exited with error', err);
                    reject(err);
                } else {
                    log.info('Installer completed successfully.');
                    resolve();
                }
            });
        });
    } else {
        const { shell } = require('electron');
        log.info(`Opening installer: ${installerPath}`);
        return await shell.openPath(installerPath);
    }
}

function isJavaExecPath(pth) {
    const pthLower = pth.toLowerCase();
    switch (process.platform) {
        case Platform.WIN32:
            return pthLower.endsWith('javaw.exe') || pthLower.endsWith('java.exe');
        case Platform.DARWIN:
        case Platform.LINUX:
            return pthLower.endsWith('/java') || pthLower.endsWith('java') || pthLower.endsWith('/javaw') || pthLower.endsWith('javaw');
        default:
            return false;
    }
}

function parseJavaRuntimeVersion(verString) {
    if (verString.startsWith('1.')) {
        return parseJavaRuntimeVersionLegacy(verString);
    }
    else {
        return parseJavaRuntimeVersionSemver(verString);
    }
}

function parseJavaRuntimeVersionLegacy(verString) {
    const regex = /1.(\d+).(\d+)_(\d+)(?:-b(\d+))?/;
    const match = regex.exec(verString);
    if (match == null) {
        log.error(`Failed to parse legacy Java version: ${verString}`);
        return null;
    }
    return {
        major: parseInt(match[1]),
        minor: parseInt(match[2]),
        patch: parseInt(match[3])
    };
}

function parseJavaRuntimeVersionSemver(verString) {
    const regex = /(\d+)\.(\d+).(\d+)(?:[+.](\d+))?/;
    const match = regex.exec(verString);
    if (match == null) {
        log.error(`Failed to parse semver Java version: ${verString}`);
        return null;
    }
    return {
        major: parseInt(match[1]),
        minor: parseInt(match[2]),
        patch: parseInt(match[3])
    };
}

function javaVersionToString({ major, minor, patch }) {
    return `${major}.${minor}.${patch}`;
}

async function getValidatableJavaPaths(dataDir) {
    let discoverers = [];
    switch (process.platform) {
        case Platform.WIN32:
            discoverers = await getWin32Discoverers(dataDir);
            break;
        case Platform.DARWIN:
            discoverers = await getDarwinDiscoverers(dataDir);
            break;
        case Platform.LINUX:
            discoverers = await getLinuxDiscoverers(dataDir);
            break;
        default:
            log.warn(`Unable to discover Java paths on platform: ${process.platform}`);
    }
    let paths = [];
    for (const discover of discoverers) {
        paths = [
            ...paths,
            ...await discover.discover()
        ];
    }
    return [...(new Set(paths))];
}

async function getWin32Discoverers(dataDir) {
    const list = [
        new EnvironmentBasedJavaDiscoverer(getPossibleJavaEnvs()),
        new DirectoryBasedJavaDiscoverer([
            ...(await getPathsOnAllDrivesWin32([
                'Program Files\\Java',
                'Program Files\\Eclipse Adoptium',
                'Program Files\\Eclipse Foundation',
                'Program Files\\AdoptOpenJDK',
                'Program Files\\Amazon Corretto'
            ])),
            getLauncherRuntimeDir(dataDir)
        ])
    ];
    list.push(new Win32RegistryJavaDiscoverer());
    return list;
}

async function getDarwinDiscoverers(dataDir) {
    return [
        new EnvironmentBasedJavaDiscoverer(getPossibleJavaEnvs()),
        new DirectoryBasedJavaDiscoverer([
            '/Library/Java/JavaVirtualMachines',
            getLauncherRuntimeDir(dataDir)
        ]),
        new PathBasedJavaDiscoverer([
            '/Library/Internet Plug-Ins/JavaAppletPlugin.plugin'
        ])
    ];
}

async function getLinuxDiscoverers(dataDir) {
    return [
        new EnvironmentBasedJavaDiscoverer(getPossibleJavaEnvs()),
        new DirectoryBasedJavaDiscoverer([
            '/usr/lib/jvm',
            getLauncherRuntimeDir(dataDir)
        ])
    ];
}

async function win32DriveMounts() {
    const drives = [];
    const checkDrive = async (letter) => {
        const drive = letter + ':\\';
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                resolve(null);
            }, 1000);
            fs.access(drive)
                .then(() => {
                    clearTimeout(timer);
                    resolve(drive);
                })
                .catch(() => {
                    clearTimeout(timer);
                    resolve(null);
                });
        });
    };

    const letters = [];
    for (let i = 67; i <= 90; i++) { // From 'C' to 'Z'
        letters.push(String.fromCharCode(i));
    }

    const results = await Promise.all(letters.map(checkDrive));
    for (const r of results) {
        if (r != null) {
            drives.push(r);
        }
    }
    return drives.length > 0 ? drives : ['C:\\'];
}

async function getPathsOnAllDrivesWin32(paths) {
    const driveMounts = await win32DriveMounts();
    const res = [];
    for (const p of paths) {
        for (const mount of driveMounts) {
            res.push(path.join(mount, p));
        }
    }
    return res;
}

function getPossibleJavaEnvs() {
    return [
        'JAVA_HOME',
        'JRE_HOME',
        'JDK_HOME'
    ];
}

function getLauncherRuntimeDir(dataDir) {
    return path.join(dataDir, 'runtime', process.arch);
}

class PathBasedJavaDiscoverer {
    constructor(paths) {
        this.paths = paths;
    }
    async discover() {
        const res = new Set();
        for (const p of this.paths) {
            try {
                await fs.access(javaExecFromRoot(p));
                res.add(p);
            } catch (e) { /* Drive inaccessible */ }
        }
        return [...res];
    }
}

class DirectoryBasedJavaDiscoverer {
    constructor(directories) {
        this.directories = directories;
    }
    async discover() {
        const res = new Set();
        for (const directory of this.directories) {
            try {
                const files = await fs.readdir(directory);
                for (const file of files) {
                    const fullPath = path.join(directory, file);
                    try {
                        await fs.access(javaExecFromRoot(fullPath));
                        res.add(fullPath);
                    } catch (e) { /* Drive inaccessible */ }
                }
            } catch (e) { /* Drive inaccessible */ }
        }
        return [...res];
    }
}

class EnvironmentBasedJavaDiscoverer {
    constructor(keys) {
        this.keys = keys;
    }
    async discover() {
        const res = new Set();
        for (const key of this.keys) {
            const value = process.env[key];
            if (value != null) {
                const asRoot = ensureJavaDirIsRoot(value);
                try {
                    await fs.access(asRoot);
                    res.add(asRoot);
                } catch (e) { /* Drive inaccessible */ }
            }
        }
        return [...res];
    }
}

class Win32RegistryJavaDiscoverer {
    async discover() {
        if (process.platform !== 'win32') return [];
        const regKeys = [
            '\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
            '\\SOFTWARE\\JavaSoft\\Java Development Kit',
            '\\SOFTWARE\\JavaSoft\\JRE',
            '\\SOFTWARE\\JavaSoft\\JDK'
        ];
        const candidates = new Set();
        for (const keyPath of regKeys) {
            try {
                const { stdout } = await execFileAsync('reg', ['query', 'HKLM' + keyPath]);
                if (!stdout) continue;
                const lines = stdout.split('\n');
                const subkeys = lines.filter(line => line.trim().startsWith('HKEY_LOCAL_MACHINE'));
                for (const subkey of subkeys) {
                    try {
                        const { stdout: valStdout } = await execFileAsync('reg', ['query', subkey.trim(), '/v', 'JavaHome']);
                        if (!valStdout) continue;
                        const match = valStdout.match(/\sJavaHome\s+REG_SZ\s+(.*)/i);
                        if (match && match[1]) {
                            const javaHome = match[1].trim();
                            if (javaHome && !javaHome.includes('(x86)')) {
                                candidates.add(javaHome);
                            }
                        }
                    } catch (e) { /* Registry value does not exist */ }
                }
            } catch (e) { /* Registry key does not exist */ }
        }
        return [...candidates];
    }
}

module.exports = {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    discoverAllJvmInstallations,
    latestOpenJDK,
    latestAdoptium,
    latestCorretto,
    latestGraalVM,
    latestGraalVM_GitHub,
    latestLibericaNIK,
    extractJdk,
    runInstaller,
    getHotSpotSettings,
    resolveJvmSettings,
    rankApplicableJvms,
    isJavaExecPath,
    parseJavaRuntimeVersion,
    javaVersionToString,
    getValidatableJavaPaths,
    PathBasedJavaDiscoverer,
    DirectoryBasedJavaDiscoverer,
    EnvironmentBasedJavaDiscoverer,
    Win32RegistryJavaDiscoverer
}
