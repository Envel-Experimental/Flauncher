const path = require('path');

const Platform = {
    WIN32: 'win32',
    DARWIN: 'darwin',
    LINUX: 'linux'
};

/**
 * Resolves the true native CPU architecture of the host machine.
 *
 * On Windows ARM64, Electron (and Node) typically runs as an x64 process via
 * emulation, so `process.arch` reports 'x64'. Windows sets the environment
 * variable `PROCESSOR_ARCHITEW6432` for WOW64 / x64-on-ARM processes to
 * indicate the real native architecture. We use this to correctly identify
 * ARM64 hosts and download the appropriate native JDK.
 *
 * @returns {'arm64' | 'x64' | string} Canonical arch string ('arm64' or 'x64')
 */
function resolveNativeArch() {
    if (process.platform === 'win32') {
        // PROCESSOR_ARCHITEW6432 is set by Windows for x86/x64 processes running
        // under WOW64 on a non-x64 host (e.g. ARM64). Its value is the native arch.
        // This is the most reliable way to detect ARM64 when Electron runs as
        // an emulated x64 process (process.arch === 'x64' even on ARM64 hosts).
        const wow64Arch = process.env.PROCESSOR_ARCHITEW6432;
        if (wow64Arch && wow64Arch.trim().toUpperCase() === 'ARM64') return 'arm64';

        // PROCESSOR_ARCHITECTURE is 'ARM64' only when the process itself is a
        // native ARM64 binary (future Electron ARM64 builds).
        const procArch = process.env.PROCESSOR_ARCHITECTURE;
        if (procArch && procArch.trim().toUpperCase() === 'ARM64') return 'arm64';

        // On Windows, if detection is inconclusive, default to x64.
        // This is safer than trusting process.arch which may reflect
        // the emulation layer rather than the native host architecture.
        return 'x64';
    }

    // On macOS / Linux, process.arch is reliable.
    return process.arch;
}

function javaExecFromRoot(rootDir) {
    switch (process.platform) {
        case Platform.WIN32:
            return path.join(rootDir, 'bin', 'javaw.exe');
        case Platform.DARWIN:
            return path.join(rootDir, 'Contents', 'Home', 'bin', 'java');
        case Platform.LINUX:
            return path.join(rootDir, 'bin', 'java');
        default:
            return rootDir;
    }
}

function ensureJavaDirIsRoot(dir) {
    if (!dir) return dir;
    switch (process.platform) {
        case Platform.DARWIN: {
            const index = dir.indexOf('/Contents/Home');
            return index > -1 ? dir.substring(0, index) : dir;
        }
        case Platform.WIN32:
        case Platform.LINUX:
        default: {
            const index = dir.indexOf(path.join('/', 'bin', 'java'));
            if (index === -1) {
                const winIndex = dir.indexOf(path.join('\\', 'bin', 'javaw.exe'));
                return winIndex > -1 ? dir.substring(0, winIndex) : dir;
            }
            return index > -1 ? dir.substring(0, index) : dir;
        }
    }
}

module.exports = {
    javaExecFromRoot,
    ensureJavaDirIsRoot,
    resolveNativeArch,
    Platform
};
