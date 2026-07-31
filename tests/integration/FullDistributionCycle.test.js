/**
 * @jest-environment node
 */
const crypto = require('crypto')
const path = require('path')
const fs = require('fs/promises')
const http = require('http')
const { DistributionAPI } = require('../../app/assets/js/core/common/DistributionAPI')

describe('Real-World Distribution Integration Cycle', () => {
    let testDir
    let publicKeyHex
    let privateKey
    let server
    let serverPort
    let responseData = {}

    beforeAll(async () => {
        testDir = path.join(__dirname, `tmp_real_distro_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`)
        await fs.mkdir(testDir, { recursive: true })

        // 1. Generate real Ed25519 keypair
        const { publicKey, privateKey: priv } = crypto.generateKeyPairSync('ed25519')
        privateKey = priv
        const exported = publicKey.export({ type: 'spki', format: 'der' })
        publicKeyHex = exported.slice(12).toString('hex')

        // 2. Setup a real local HTTP server
        server = http.createServer((req, res) => {
            if (responseData[req.url]) {
                res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
                res.end(responseData[req.url])
            } else {
                res.writeHead(404)
                res.end()
            }
        })
        
        await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
            serverPort = server.address().port
            resolve()
        }))

        // 3. Setup IPC Bridge Mock
        global.window = {
            HeliosAPI: {
                ipc: {
                    invoke: async (channel, data) => {
                        if (channel === 'net:fetch') {
                            const [url, options, timeout] = [data, arguments[2], arguments[3]]
                            return new Promise((resolve, reject) => {
                                http.get(url, (res) => {
                                    const chunks = []
                                    res.on('data', chunk => chunks.push(chunk))
                                    res.on('end', () => {
                                        const buf = Buffer.concat(chunks)
                                        resolve({ ok: res.statusCode === 200, status: res.statusCode, body: buf.toString('base64') })
                                    })
                                }).on('error', reject)
                            })
                        }
                        if (channel === 'crypto:verifyDistribution') {
                            const { dataHex, signatureHex, trustedKeys } = data
                            for (const keyHex of trustedKeys) {
                                try {
                                    const spkiBuffer = Buffer.concat([
                                        Buffer.from('302a300506032b6570032100', 'hex'),
                                        Buffer.from(keyHex, 'hex')
                                    ])
                                    const publicKeyObj = crypto.createPublicKey({ key: spkiBuffer, format: 'der', type: 'spki' })
                                    const isValid = crypto.verify(null, Buffer.from(dataHex, 'hex'), publicKeyObj, Buffer.from(signatureHex, 'hex'))
                                    if (isValid) return true
                                } catch (e) { /* Invalid key format, try next */ }
                            }
                            return false
                        }
                    }
                }
            },
            ipcRenderer: {
                invoke: (...args) => global.window.HeliosAPI.ipc.invoke(...args)
            }
        }
        process.type = 'renderer'
    })

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve))
        delete global.window
        delete process.type

        // Robust cleanup for Windows
        for (let i = 0; i < 5; i++) {
            try {
                await fs.rm(testDir, { recursive: true, force: true })
                break
            } catch (e) {
                if (i === 4) console.warn('Cleanup failed after 5 attempts:', e.message)
                await new Promise(r => setTimeout(r, 200))
            }
        }
    })

    it('should REALLY fetch, verify, and parse from a local HTTP server', async () => {
        const mockDistro = {
            version: '1.0.0',
            servers: [{ id: 'server1', name: 'Server 1', minecraftVersion: '1.20.1' }]
        }
        const jsonBuf = Buffer.from(JSON.stringify(mockDistro))
        const signature = crypto.sign(null, jsonBuf, privateKey).toString('hex')

        // Setup server data
        responseData['/distro.json'] = jsonBuf
        responseData['/distro.json.sig'] = Buffer.from(signature)

        const distroApi = new DistributionAPI(testDir, testDir, testDir, [`http://127.0.0.1:${serverPort}/distro.json`], false)
        distroApi.trustedKeys = [publicKeyHex]

        const result = await distroApi.pullRemote()

        expect(result.responseStatus).toBe('SUCCESS')
        expect(result.data.version).toBe('1.0.0')
        expect(result.signatureValid).toBe(true)
    })

    it('should DETECT tampered data over real HTTP', async () => {
        const mockDistro = { version: '1.0.0', servers: [] }
        const jsonBuf = Buffer.from(JSON.stringify(mockDistro))
        const signature = crypto.sign(null, jsonBuf, privateKey).toString('hex')

        // Tamper data on server but keep original signature
        const tamperedBuf = Buffer.from(JSON.stringify({ version: '6.6.6', servers: [] }))
        
        responseData['/bad.json'] = tamperedBuf
        responseData['/bad.json.sig'] = Buffer.from(signature)

        const distroApi = new DistributionAPI(testDir, testDir, testDir, [`http://127.0.0.1:${serverPort}/bad.json`], false)
        distroApi.trustedKeys = [publicKeyHex]

        const result = await distroApi.pullRemote()

        expect(result.responseStatus).toBe('ERROR')
        expect(result.error.message).toContain('signature verification failed')
    })
})
