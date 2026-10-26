/**
 * @jest-environment node
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const https = require('https')
const { downloadFile } = require('../../app/assets/js/core/dl/DownloadEngine')

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`HTTP ${res.statusCode}`))
            }
            const chunks = []
            res.on('data', d => chunks.push(d))
            res.on('end', () => resolve(Buffer.concat(chunks)))
            res.on('error', reject)
        }).on('error', reject)
    })
}

describe('Live Mirror Download & Auto-Failover Integration', () => {
    let tmpDir

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-dl-test-'))
        if (typeof global.fetch === 'undefined' && typeof globalThis.fetch === 'function') {
            global.fetch = globalThis.fetch
        }
        if (typeof global.Request === 'undefined' && typeof globalThis.Request === 'function') {
            global.Request = globalThis.Request
        }
    })

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        } catch (e) { }
    })

    test('downloads real distribution.json from live mirror and verifies integrity', async () => {
        const destPath = path.join(tmpDir, 'distribution.json')
        const mirrorUrl = 'https://c5b0e231-0f4e-4fc2-b437-12f1eb34927f.selcdn.net/distribution.json'

        const buffer = await fetchBuffer(mirrorUrl)
        const actualHash = crypto.createHash('sha1').update(buffer).digest('hex')
        const actualSize = buffer.length

        const asset = {
            id: 'distribution.json',
            url: mirrorUrl,
            path: destPath,
            algo: 'sha1',
            hash: actualHash,
            size: actualSize,
            fallbackUrls: [
                'https://f-launcher.ru/fox/new/distribution.json',
                'https://mirror.nikita.best/distribution.json'
            ],
            maxAttempts: 3
        }

        const outcome = await downloadFile(asset, null, true)
        expect(outcome).toBeDefined()
        expect(fs.existsSync(destPath)).toBe(true)

        const downloadedBuffer = fs.readFileSync(destPath)
        expect(downloadedBuffer.length).toBe(actualSize)
        const downloadedHash = crypto.createHash('sha1').update(downloadedBuffer).digest('hex')
        expect(downloadedHash).toBe(actualHash)
    }, 15000)

    test('automatically self-heals and fails over to secondary mirror when primary URL is invalid', async () => {
        const destPath = path.join(tmpDir, 'distribution_fallback.json')
        const brokenUrl = 'https://broken-nonexistent-mirror-12345.nikita.best/distribution.json'
        const workingMirrorUrl = 'https://f-launcher.ru/fox/new/distribution.json'

        const buffer = await fetchBuffer(workingMirrorUrl)
        const actualHash = crypto.createHash('sha1').update(buffer).digest('hex')
        const actualSize = buffer.length

        const asset = {
            id: 'distribution_fallback.json',
            url: brokenUrl,
            path: destPath,
            algo: 'sha1',
            hash: actualHash,
            size: actualSize,
            fallbackUrls: [
                workingMirrorUrl,
                'https://mirror.nikita.best/distribution.json'
            ],
            maxAttempts: 3
        }

        const outcome = await downloadFile(asset, null, true)
        expect(outcome).toBeDefined()
        expect(fs.existsSync(destPath)).toBe(true)

        const downloadedBuffer = fs.readFileSync(destPath)
        expect(downloadedBuffer.length).toBe(actualSize)
        const downloadedHash = crypto.createHash('sha1').update(downloadedBuffer).digest('hex')
        expect(downloadedHash).toBe(actualHash)
    }, 20000)
})
