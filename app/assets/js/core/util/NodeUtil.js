const { fileURLToPath } = require('url');
const os = require('os');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureEncodedPath(path) {
    // ## BACKWARD COMPATIBILITY FIX ##
    return path.replace(/\\/g, '/');
}

function ensureDecodedPath(path) {
    if (typeof path !== 'string') {
        return path;
    }
    if (path.startsWith('file://')) {
        try {
            return fileURLToPath(path);
        }
        catch (e) {
            const strippedPath = path.substring(path.startsWith('file:///') ? 8 : 7);
            if (os.platform() === 'win32') {
                if (strippedPath.startsWith('/'))
                    return strippedPath;
                return strippedPath.replace(/\//g, '\\');
            }
            return strippedPath;
        }
    }
    if (os.platform() === 'win32') {
        if (path.startsWith('/')) {
            return path;
        }
        return path.replace(/\//g, '\\');
    }
    return path;
}

/**
 * Simple concurrency limiter to avoid ESM import issues with p-limit package.
 * 
 * @param {number} limit Max concurrent tasks.
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>}
 */
function pLimit(limit) {
    let active = 0;
    const queue = [];
    const next = () => {
        active--;
        if (queue.length > 0) {
            const task = queue.shift();
            if (task) task();
        }
    };
    return (fn) => {
        return new Promise((resolve, reject) => {
            const run = () => {
                active++;
                fn().then(resolve).catch(reject).finally(next);
            };
            if (active < limit) {
                run();
            } else {
                queue.push(run);
            }
        });
    };
}

module.exports = { sleep, ensureEncodedPath, ensureDecodedPath, pLimit }
