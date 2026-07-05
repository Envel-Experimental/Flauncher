const isRenderer = typeof process !== 'undefined' && process.type === 'renderer'

if (isRenderer) {
    // Renderer Process implementation: forwards caching and downloading to Main via IPC
    const listeners = new Map()

    if (typeof window !== 'undefined' && window.HeliosAPI && window.HeliosAPI.ipc) {
        window.HeliosAPI.ipc.on('avatar:downloaded', (event, { uuid, type, base64Url }) => {
            console.log(`[AvatarCache] Renderer received downloaded event for ${uuid} (${type})`)
            const key = `${uuid}_${type}`
            const callbacks = listeners.get(key)
            if (callbacks) {
                for (const cb of callbacks) {
                    try { cb(base64Url) } catch (e) { console.error('[AvatarCache] Callback error:', e) }
                }
                listeners.delete(key)
            }
        })
    }

    function getCachedAvatar(uuid, type = 'head', onDownloaded = null) {
        if (!uuid) {
            return type === 'head' 
                ? 'https://mc-heads.net/head/8667ba71b85a4004af54457a9734eed7/100' 
                : 'https://mc-heads.net/body/8667ba71b85a4004af54457a9734eed7/right'
        }

        const key = `${uuid}_${type}`
        if (onDownloaded) {
            if (!listeners.has(key)) {
                listeners.set(key, new Set())
            }
            listeners.get(key).add(onDownloaded)
        }

        try {
            const cached = window.HeliosAPI.ipc.sendSync('avatar:getSync', uuid, type)
            if (cached) {
                return cached
            }
        } catch (err) {
            console.error('[AvatarCache] Error in getSync:', err)
        }

        window.HeliosAPI.ipc.invoke('avatar:download', uuid, type).catch(err => {
            console.error('[AvatarCache] Error triggering download:', err)
        })

        return type === 'head'
            ? `https://mc-heads.net/head/${uuid}/100`
            : `https://mc-heads.net/body/${uuid}/right`
    }

    module.exports = { getCachedAvatar }

} else {
    // Main Process implementation: interacts directly with fs and native https module
    const fs = require('fs')
    const path = require('path')
    const https = require('https')
    const { getDataDirectory } = require('../configmanager')

    function getAvatarCacheDir() {
        const dataDir = getDataDirectory()
        const cacheDir = path.join(dataDir, 'cache', 'avatars')
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true })
        }
        return cacheDir
    }

    function getCachedAvatarSync(uuid, type) {
        if (!uuid) return null
        const cacheDir = getAvatarCacheDir()
        const fileName = `${uuid}_${type}.png`
        const localPath = path.join(cacheDir, fileName)

        if (fs.existsSync(localPath)) {
            try {
                const stats = fs.statSync(localPath)
                if (stats.size > 200) {
                    const buffer = fs.readFileSync(localPath)
                    return `data:image/png;base64,${buffer.toString('base64')}`
                } else {
                    console.warn(`[AvatarCache] Cache file too small (${stats.size} bytes), deleting: ${localPath}`)
                    fs.unlinkSync(localPath)
                }
            } catch (e) {
                console.error(`[AvatarCache] Failed to read cached file ${localPath}:`, e)
            }
        }
        return null
    }

    const activeDownloads = new Set()

    function downloadAvatar(uuid, type, onComplete) {
        const key = `${uuid}_${type}`
        if (activeDownloads.has(key)) return
        activeDownloads.add(key)

        const cacheDir = getAvatarCacheDir()
        const fileName = `${uuid}_${type}.png`
        const localPath = path.join(cacheDir, fileName)

        const remoteUrl = type === 'head'
            ? `https://mc-heads.net/head/${uuid}/100`
            : `https://mc-heads.net/body/${uuid}/right`

        console.log(`[AvatarCache] Downloading avatar from: ${remoteUrl}`)

        https.get(remoteUrl, (res) => {
            if (res.statusCode !== 200) {
                console.error(`[AvatarCache] Failed to download from ${remoteUrl}, status: ${res.statusCode}`)
                activeDownloads.delete(key)
                return
            }

            const chunks = []
            res.on('data', (chunk) => chunks.push(chunk))
            res.on('end', () => {
                const buffer = Buffer.concat(chunks)
                try {
                    fs.writeFileSync(localPath, buffer)
                    console.log(`[AvatarCache] Successfully saved ${localPath} (${buffer.length} bytes)`)
                    const base64Url = `data:image/png;base64,${buffer.toString('base64')}`
                    onComplete(base64Url)
                } catch (err) {
                    console.error(`[AvatarCache] Failed to write cache file:`, err)
                } finally {
                    activeDownloads.delete(key)
                }
            })
        }).on('error', (err) => {
            console.error(`[AvatarCache] Request error for ${uuid} (${type}):`, err)
            activeDownloads.delete(key)
        })
    }

    function removeCachedAvatar(uuid) {
        if (!uuid) return
        const cacheDir = getAvatarCacheDir()
        const types = ['head', 'body']
        for (const type of types) {
            const fileName = `${uuid}_${type}.png`
            const localPath = path.join(cacheDir, fileName)
            if (fs.existsSync(localPath)) {
                try {
                    fs.unlinkSync(localPath)
                    console.log(`[AvatarCache] Deleted cached avatar for account ${uuid} (${type})`)
                } catch (e) {
                    console.error(`[AvatarCache] Failed to delete cached file ${localPath}:`, e)
                }
            }
        }
    }

    module.exports = { getCachedAvatarSync, downloadAvatar, removeCachedAvatar }
}
