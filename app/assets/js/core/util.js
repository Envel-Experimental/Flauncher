const fs = require('fs').promises
const path = require('path')

/**
 * Asynchronously retries a function with a specified number of attempts and delay.
 */
exports.retry = async function (func, retries = 3, delay = 1000, isRetryable = (err) => true) {
    for (let i = 0; i < retries; i++) {
        try {
            return await func()
        } catch (err) {
            if (isRetryable(err) && i < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)))
            } else {
                throw err
            }
        }
    }
}

/**
 * Perform a fetch with a timeout.
 * 
 * @param {string} url The URL to fetch.
 * @param {object} options The fetch options.
 * @param {number} timeout The timeout in milliseconds.
 * @returns {Promise<Response>} The fetch promise.
 */
exports.fetchWithTimeout = async function (url, options = {}, timeout = 5000) {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), timeout)
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        })
        clearTimeout(id)
        return response
    } catch (error) {
        clearTimeout(id)
        throw error
    }
}

/**
 * Ensures that the directory exists. If the directory structure does not exist, it is created.
 */
exports.ensureDir = async function (dirPath) {
    await fs.mkdir(dirPath, { recursive: true })
}

/**
 * Moves a file or directory. Handles cross-device moves by falling back to copy/delete.
 * Creates destination directory if it doesn't exist.
 */
exports.move = async function (src, dest) {
    // FIX: Сначала создаем папку, куда перемещаем, иначе fs.rename упадет
    await exports.ensureDir(path.dirname(dest))

    try {
        await fs.rename(src, dest)
    } catch (err) {
        if (err.code === 'EXDEV') {
            await fs.cp(src, dest, { recursive: true, force: true })
            await fs.rm(src, { recursive: true, force: true })
        } else {
            throw err
        }
    }
}

/**
 * Atomically writes an object to a JSON file.
 * Creates directory if it doesn't exist.
 */
exports.safeWriteJson = async function (file, data) {
    const tempFile = file + '.tmp.' + Date.now() + '.' + Math.random().toString(36).substring(2, 8)
    const content = JSON.stringify(data, null, 4)

    await exports.ensureDir(path.dirname(file))

    try {
        await fs.writeFile(tempFile, content, 'utf-8')
        await exports.retry(async () => {
            await fs.rename(tempFile, file)
        }, 5, 100, (err) => err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'ENOENT')
    } catch (err) {
        try {
            await fs.rm(tempFile, { force: true })
        } catch (e) {
            // Ignore
        }
        console.warn(`[util] Atomic write failed (${err.code || err.message}). Falling back to direct write to ${file}`)
        await fs.writeFile(file, content, 'utf-8')
    }
}

/**
 * Safely reads a JSON file. Returns null if the file does not exist.
 * Throws if the file is corrupted (invalid JSON).
 */
exports.safeReadJson = async function (file) {
    try {
        const data = await fs.readFile(file, 'utf-8')
        return JSON.parse(data)
    } catch (err) {
        if (err.code === 'ENOENT') {
            return null
        }
        throw err
    }
}

/**
 * deeply merges two objects.
 * @param {object} obj
 * @param {object} defaults
 * @returns {object}
 */
exports.deepMerge = function (obj, defaults) {
    if (!defaults) return obj
    if (!obj) return defaults

    if (typeof obj !== 'object' || typeof defaults !== 'object' || Array.isArray(obj) || Array.isArray(defaults)) {
        return obj
    }

    const result = { ...defaults }
    if (obj && typeof obj === 'object') {
        for (const key in obj) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue

            const val = obj[key]
            if (val === undefined) continue

            if (result && Object.prototype.hasOwnProperty.call(result, key) && val !== null && typeof val === 'object' && !Array.isArray(val)) {
                result[key] = exports.deepMerge(val, result[key])
            } else {
                result[key] = val
            }
        }
    }
    return result
}
