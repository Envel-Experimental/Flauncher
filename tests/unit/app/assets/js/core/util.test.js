const path = require('path')

describe('util', () => {
    let util
    let fsPromises

    beforeEach(() => {
        jest.resetModules()
        
        jest.doMock('fs', () => ({
            promises: {
                mkdir: jest.fn().mockResolvedValue(undefined),
                rename: jest.fn().mockResolvedValue(undefined),
                cp: jest.fn().mockResolvedValue(undefined),
                rm: jest.fn().mockResolvedValue(undefined),
                writeFile: jest.fn().mockResolvedValue(undefined),
                readFile: jest.fn().mockResolvedValue('{}')
            }
        }))

        util = require('../../../../../../app/assets/js/core/util')
        fsPromises = require('fs').promises
        global.fetch = jest.fn()
    })

    describe('retry', () => {
        it('should succeed on first attempt', async () => {
            const func = jest.fn().mockResolvedValue('success')
            const result = await util.retry(func)
            expect(result).toBe('success')
            expect(func).toHaveBeenCalledTimes(1)
        })

        it('should retry on failure and succeed', async () => {
            const func = jest.fn()
                .mockRejectedValueOnce(new Error('fail'))
                .mockResolvedValueOnce('success')
            
            const result = await util.retry(func, 3, 0) // 0 delay for speed
            expect(result).toBe('success')
            expect(func).toHaveBeenCalledTimes(2)
        })
    })

    describe('fetchWithTimeout', () => {
        it('should fetch successfully', async () => {
            global.fetch.mockResolvedValue({ ok: true })
            const res = await util.fetchWithTimeout('http://test.com')
            expect(res.ok).toBe(true)
        })
    })

    describe('move', () => {
        it('should use rename if possible', async () => {
            await util.move('src', 'dest')
            expect(fsPromises.rename).toHaveBeenCalledWith('src', 'dest')
        })

        it('should fallback to cp/rm on EXDEV error', async () => {
            fsPromises.rename.mockRejectedValue({ code: 'EXDEV' })
            await util.move('src', 'dest')
            expect(fsPromises.cp).toHaveBeenCalled()
            expect(fsPromises.rm).toHaveBeenCalled()
        })
    })

    describe('safeWriteJson', () => {
        it('should write JSON atomically', async () => {
            await util.safeWriteJson('test.json', { a: 1 })
            expect(fsPromises.writeFile).toHaveBeenCalled()
            expect(fsPromises.rename).toHaveBeenCalled()
        })

        it('should fallback to direct write if rename fails', async () => {
            fsPromises.rename.mockRejectedValueOnce(new Error('Rename failed'))
            await util.safeWriteJson('test.json', { a: 1 })
            // Once for the temp file, once for the fallback write to target file
            expect(fsPromises.writeFile).toHaveBeenCalledTimes(2)
        })
    })

    describe('safeReadJson', () => {
        it('should read valid JSON', async () => {
            fsPromises.readFile.mockResolvedValue('{"a": 1}')
            const data = await util.safeReadJson('test.json')
            expect(data).toEqual({ a: 1 })
        })

        it('should return null if file missing (ENOENT)', async () => {
            fsPromises.readFile.mockRejectedValue({ code: 'ENOENT' })
            const data = await util.safeReadJson('test.json')
            expect(data).toBeNull()
        })
    })

    describe('deepMerge', () => {
        it('should merge objects deeply', () => {
            const defaults = { a: 1, b: { c: 2 } }
            const obj = { b: { d: 3 } }
            const result = util.deepMerge(obj, defaults)
            expect(result).toEqual({ a: 1, b: { c: 2, d: 3 } })
        })
    })

    describe('move', () => {
        it('should fallback to copy and delete on EXDEV (cross-device) error', async () => {
            fsPromises.rename.mockRejectedValueOnce({ code: 'EXDEV' })
            fsPromises.cp = jest.fn().mockResolvedValue(undefined)
            fsPromises.rm = jest.fn().mockResolvedValue(undefined)
            
            await util.move('src', 'dest')
            
            expect(fsPromises.rename).toHaveBeenCalledWith('src', 'dest')
            expect(fsPromises.cp).toHaveBeenCalledWith('src', 'dest', { recursive: true, force: true })
            expect(fsPromises.rm).toHaveBeenCalledWith('src', { recursive: true, force: true })
        })
    })
})
