const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const os = require('os')
const { validateLocalFile } = require('../../../../../../../app/assets/js/core/common/FileUtils')

describe('FileUtils validateLocalFile Retry & Lock Resilience', () => {
    let tmpDir

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileutils-test-'))
    })

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        } catch (e) { }
    })

    test('validates matching file without errors', async () => {
        const filePath = path.join(tmpDir, 'valid.txt')
        const content = 'Hello world validation'
        fs.writeFileSync(filePath, content)
        const hash = crypto.createHash('sha1').update(content).digest('hex')

        const isValid = await validateLocalFile(filePath, 'sha1', hash, Buffer.byteLength(content))
        expect(isValid).toBe(true)
    })

    test('returns false immediately on ENOENT without long retries', async () => {
        const filePath = path.join(tmpDir, 'does-not-exist.txt')
        const start = Date.now()
        const isValid = await validateLocalFile(filePath, 'sha1', 'dummyhash', 100)
        const duration = Date.now() - start

        expect(isValid).toBe(false)
        expect(duration).toBeLessThan(300)
    })

    test('retries and succeeds when transient lock EBUSY occurs during stat', async () => {
        const filePath = path.join(tmpDir, 'transient.txt')
        const content = 'Transient test'
        fs.writeFileSync(filePath, content)
        const hash = crypto.createHash('sha1').update(content).digest('hex')

        let calls = 0
        const originalStat = fs.promises.stat
        fs.promises.stat = jest.fn(async (...args) => {
            calls++
            if (calls === 1) {
                const err = new Error('File locked')
                err.code = 'EBUSY'
                throw err
            }
            return originalStat.apply(fs.promises, args)
        })

        try {
            const isValid = await validateLocalFile(filePath, 'sha1', hash, Buffer.byteLength(content))
            expect(isValid).toBe(true)
            expect(calls).toBeGreaterThanOrEqual(2)
        } finally {
            fs.promises.stat = originalStat
        }
    })

    test('returns false when hash mismatch occurs', async () => {
        const filePath = path.join(tmpDir, 'mismatch.txt')
        const content = 'Mismatch test'
        fs.writeFileSync(filePath, content)

        const isValid = await validateLocalFile(filePath, 'sha1', '0000000000000000000000000000000000000000', Buffer.byteLength(content))
        expect(isValid).toBe(false)
    })
})
