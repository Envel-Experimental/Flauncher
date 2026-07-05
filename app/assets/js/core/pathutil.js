const fs = require('fs')
const path = require('path')

const NON_ASCII_REGEX = /[^\x00-\x7F]/

/**
 * Checks if a string contains non-ASCII characters.
 * @param {string} str The string to check.
 * @returns {boolean} True if the string contains non-ASCII characters, otherwise false.
 */
function hasNonAscii(str) {
    return NON_ASCII_REGEX.test(str)
}

/**
 * Checks if a string contains spaces.
 * @param {string} str The string to check.
 * @returns {boolean} True if the string contains spaces, otherwise false.
 */
function hasSpaces(str) {
    return str.includes(' ')
}

/**
 * Validates a path for stability, checking for non-ASCII characters or spaces (critical for Java/JVM).
 * @param {string} p The path to validate.
 * @returns {boolean} True if the path is stable, otherwise false.
 */
function isPathValid(p) {
    return !hasNonAscii(p) && !hasSpaces(p)
}

/**
 * Gets the standard user data directory (%APPDATA% on Windows).
 * This is the primary path used if deemed stable.
 * @param {import('electron').App} app The Electron app object.
 * @returns {string} The default data directory.
 */
function getDefaultDataPath(app) {
    let sysRoot = process.env.APPDATA
    if (!sysRoot && app && typeof app.getPath === 'function') {
        sysRoot = process.platform === 'linux' ? app.getPath('home') : app.getPath('appData')
    }
    
    // Fallback for other platforms if both are missing
    if (!sysRoot) {
        sysRoot = process.platform === 'darwin' ? path.join(process.env.HOME, 'Library', 'Application Support') : process.env.HOME
    }

    return path.join(sysRoot, '.foxford')
}

const { execSync } = require('child_process')

function toShortPath(p) {
    if (process.platform !== 'win32') return p
    try {
        fs.mkdirSync(p, { recursive: true })
        const cmd = `powershell -NoProfile -Command "(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${p}').ShortPath"`;
        const short = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (short) return short;
    } catch (e) {
        try {
            const short = execSync(`cmd.exe /c "for %I in ("${p}") do @echo %~sI"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            if (short) return short;
        } catch (err) {}
    }
    return p;
}

/**
 * Resolves the data directory for the application.
 * Deprecated: Root C: fallback has been removed to avoid permission issues and comply with security best practices.
 * 
 * @param {import('electron').App} app The Electron app object.
 * @returns {Promise<string>} A promise that resolves to the data directory path.
 */
async function resolveDataPath(app) {
    const defaultPath = getDefaultDataPath(app)
    await fs.promises.mkdir(defaultPath, { recursive: true })
    return toShortPath(defaultPath)
}

function resolveDataPathSync(app) {
    const defaultPath = getDefaultDataPath(app)
    fs.mkdirSync(defaultPath, { recursive: true })
    return toShortPath(defaultPath)
}

function getFallbackDataPath() {
    const sysRoot = process.env.APPDATA || (process.platform === 'darwin' ? path.join(process.env.HOME, 'Library', 'Application Support') : process.env.HOME)
    return toShortPath(path.join(sysRoot, '.foxford'))
}

module.exports = {
    hasNonAscii,
    hasSpaces,
    isPathValid,
    getDefaultDataPath,
    getFallbackDataPath,
    resolveDataPath,
    resolveDataPathSync,
    toShortPath
}
