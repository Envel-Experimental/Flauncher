const os = require('os')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')


// Configurable thresholds
const TOTAL_RAM_THRESHOLD_GB = 6
const FREE_RAM_THRESHOLD_GB = 0.8
const FREE_DISK_THRESHOLD_GB = 10

// Convert GB to Bytes for comparison
const BYTES_PER_GB = 1024 * 1024 * 1024

/**
 * Gets the actual available system memory in gigabytes.
 * This method works correctly across macOS, Linux, and Windows.
 * @returns {Promise<number>} A promise that resolves to the available RAM in GB.
 */
function getAvailableRamGb() {
    return new Promise((resolve, reject) => {
        const platform = os.platform()

        if (platform === 'darwin') { // macOS
            execFile('vm_stat', (err, stdout) => {
                if (err) return reject(err)

                try {
                    // On macOS, os.freemem() is misleadingly low due to aggressive caching.
                    // A realistic available memory amount is Total Memory minus Wired Memory.
                    const wiredMatch = stdout.match(/Pages wired down:\s+(\d+)/)
                    if (wiredMatch) {
                        const wiredPages = parseInt(wiredMatch[1])
                        const pageSize = 4096 // Page size is typically 4096 bytes.
                        const totalBytes = os.totalmem()
                        const wiredBytes = wiredPages * pageSize

                        const availableBytes = Math.max(0, totalBytes - wiredBytes)
                        resolve(availableBytes / BYTES_PER_GB)
                    } else {
                        // Fallback to free + inactive if wired pages is not found (e.g., in unit tests)
                        const freeMatch = stdout.match(/Pages free:\s+(\d+)/)
                        const inactiveMatch = stdout.match(/Pages inactive:\s+(\d+)/)
                        if (!freeMatch || !inactiveMatch) throw new Error('Failed to parse vm_stat output')

                        const freePages = parseInt(freeMatch[1])
                        const inactivePages = parseInt(inactiveMatch[1])
                        const pageSize = 4096

                        const availableBytes = (freePages + inactivePages) * pageSize
                        resolve(availableBytes / BYTES_PER_GB)
                    }
                } catch (e) {
                    reject(e)
                }
            })
        } else if (platform === 'linux') {
            // On Linux, /proc/meminfo provides a direct 'MemAvailable' value.
            // Using direct file reading is safer and faster than exec('grep').
            fs.readFile('/proc/meminfo', 'utf-8', (err, data) => {
                if (err || !data) {
                    // Fallback for older kernels without MemAvailable.
                    return resolve(os.freemem() / BYTES_PER_GB)
                }
                const match = data.match(/MemAvailable:\s+(\d+)\s+(?:k|K)B/)
                if (match) {
                    const availableKb = parseInt(match[1])
                    const val = availableKb / (1024 * 1024)
                    resolve(isNaN(val) ? (os.freemem() / BYTES_PER_GB) : val)
                } else {
                    resolve(os.freemem() / BYTES_PER_GB)
                }
            })
        } else { // win32 and other platforms
            // os.freemem() is generally accurate enough on Windows.
            resolve(os.freemem() / BYTES_PER_GB)
        }
    })
}

/**
 * Gets the free disk space in GB for the primary drive.
 * Uses native Node.js fs.statfs (Node 19+) to avoid spawning 'wmic'.
 */
function getFreeDiskSpaceGb() {
    return new Promise((resolve, reject) => {
        let targetPath
        try {
            const ConfigManager = require('./configmanager')
            // Attempt to get data directory, fallback to OS defaults if not initialized
            targetPath = ConfigManager.getDataDirectory()
        } catch (e) {
            // Ignore require errors or other config issues
        }
        
        if (!targetPath) {
            targetPath = os.platform() === 'win32' ? 'C:\\' : '/'
        }

        // Check if fs.statfs exists (Node 19.6.0+)
        if (typeof fs.statfs === 'function') {
            fs.statfs(targetPath, (err, stats) => {
                if (err) {
                    // If the path doesn't exist yet, check the parent directory
                    if (err.code === 'ENOENT') {
                        fs.statfs(path.dirname(targetPath), (err2, stats2) => {
                            if (err2) return resolve(0) // Return 0 instead of rejecting to avoid breaking the whole check
                            const freeBytes = stats2.bavail * stats2.bsize
                            resolve(freeBytes / BYTES_PER_GB)
                        })
                    } else {
                        // For other errors (permissions etc), return a safe high value or 0? 
                        // Let's return a safe value to avoid warning if we can't check.
                        // Or resolve to a large number. Let's resolve to a large number to be safe.
                        resolve(100) 
                    }
                } else {
                    const freeBytes = stats.bavail * stats.bsize
                    resolve(freeBytes / BYTES_PER_GB)
                }
            })
        } else {
            // Very old Node/Electron? Fallback to something or resolve high.
            resolve(100)
        }
    })
}

/**
 * Performs system requirement checks for RAM and disk space.
 * @returns {Promise<Array<string>>} A promise that resolves to an array of warning keys.
 */
exports.getAvailableRamGb = getAvailableRamGb
exports.getFreeDiskSpaceGb = getFreeDiskSpaceGb
exports.performChecks = async function () {
    const warnings = []

    // 1. Total RAM Check (once, or every launch if not cached)
    const totalRamGb = os.totalmem() / BYTES_PER_GB
    if (totalRamGb < TOTAL_RAM_THRESHOLD_GB) {
        warnings.push('lowTotalRAM')
    }

    try {
        // 2. Available RAM Check (every launch)
        const availableRam = await getAvailableRamGb()
        // console.log(`Available RAM: ${availableRam.toFixed(2)} GB`)
        if (availableRam < FREE_RAM_THRESHOLD_GB) {
            warnings.push('lowFreeRAM')
        }
    } catch (err) {
        console.error('Error checking available RAM:', err)
        // Fallback to the old method on error, but skip for macOS to avoid false positives.
        if (os.platform() !== 'darwin') {
            if (os.freemem() / BYTES_PER_GB < FREE_RAM_THRESHOLD_GB) {
                warnings.push('lowFreeRAM')
            }
        }
    }

    // 3. Free Disk Space Check (every launch)
    try {
        const freeDisk = await getFreeDiskSpaceGb()
        if (freeDisk < FREE_DISK_THRESHOLD_GB) {
            warnings.push('lowDiskSpace')
        }
    } catch (err) {
        console.error('Error checking disk space:', err)
    }

    return warnings
}

