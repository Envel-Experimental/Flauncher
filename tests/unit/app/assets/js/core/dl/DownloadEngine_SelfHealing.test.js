const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { ReadableStream } = require('stream/web')
const { downloadFile } = require('../../../../../../../app/assets/js/core/dl/DownloadEngine')
const MirrorManager = require('../../../../../../../network/MirrorManager')

describe('DownloadEngine Self-Healing & Append Safety', () => {
    let tmpDir

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlengine-test-'))
        global.Request = class Request {
            constructor(url, options) {
                this.url = url
                this.headers = options?.headers || new Headers()
            }
        }
    })

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        } catch (e) { }
    })

    test('recovers from dirty partial .tmp when server returns 200 OK by overwriting cleanly', async () => {
        const destPath = path.join(tmpDir, 'test-target.bin')
        const tempPath = destPath + '.tmp'

        // Pre-create a partial dirty .tmp file
        fs.writeFileSync(tempPath, 'OLD_PARTIAL_BYTES_')

        const freshContent = 'NEW_FULL_FILE_CONTENT_THAT_MUST_NOT_BE_APPENDED'
        const expectedHash = crypto.createHash('sha1').update(freshContent).digest('hex')
        const expectedSize = Buffer.byteLength(freshContent)

        const originalFetch = global.fetch
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-length': expectedSize.toString() }),
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(Buffer.from(freshContent))
                    controller.close()
                }
            })
        })

        try {
            const asset = {
                id: 'test-target.bin',
                url: 'https://mirror.nikita.best/test-target.bin',
                path: destPath,
                algo: 'sha1',
                hash: expectedHash,
                size: expectedSize,
                maxAttempts: 2
            }

            const res = await downloadFile(asset, null, true)
            expect(res).toBeDefined()
            expect(fs.existsSync(destPath)).toBe(true)
            const savedContent = fs.readFileSync(destPath, 'utf8')
            expect(savedContent).toBe(freshContent)
        } finally {
            global.fetch = originalFetch
        }
    })

    test('reports failure to MirrorManager when validation fails due to HTML block', async () => {
        const destPath = path.join(tmpDir, 'blocked-file.jar')
        const htmlBlockContent = '<!DOCTYPE html><html><head><title>Доступ ограничен</title></head><body>Block</body></html>'
        const expectedHash = '1111111111111111111111111111111111111111'

        const reportFailureSpy = jest.spyOn(MirrorManager, 'reportFailure')

        const originalFetch = global.fetch
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-length': Buffer.byteLength(htmlBlockContent).toString() }),
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(Buffer.from(htmlBlockContent))
                    controller.close()
                }
            })
        })

        try {
            const asset = {
                id: 'blocked-file.jar',
                url: 'https://f-launcher.ru/fox/new/blocked-file.jar',
                path: destPath,
                algo: 'sha1',
                hash: expectedHash,
                size: 5000,
                maxAttempts: 1
            }

            await expect(downloadFile(asset, null, true)).rejects.toThrow()
            expect(reportFailureSpy).toHaveBeenCalledWith('https://f-launcher.ru/fox/new/blocked-file.jar', 502)
        } finally {
            global.fetch = originalFetch
            reportFailureSpy.mockRestore()
        }
    })
})
