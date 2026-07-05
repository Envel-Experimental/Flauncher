const path = require('path')

describe('FileUtils', () => {
    let FileUtils
    let fsPromises
    let crypto
    let child_process
    let fs

    beforeEach(() => {
        jest.resetModules()

        const mHash = {
            update: jest.fn().mockReturnThis(),
            digest: jest.fn().mockReturnValue('abc123'),
            on: jest.fn().mockImplementation(function(event, cb) {
                if (event === 'finish') cb()
                return this
            }),
            read: jest.fn().mockReturnValue(Buffer.from('abc123', 'hex'))
        }

        jest.doMock('fs/promises', () => ({
            mkdir: jest.fn().mockResolvedValue(undefined),
            stat: jest.fn().mockResolvedValue({ size: 100 }),
            readFile: jest.fn().mockResolvedValue('test content'),
            rename: jest.fn().mockResolvedValue(undefined),
            copyFile: jest.fn().mockResolvedValue(undefined),
            unlink: jest.fn().mockResolvedValue(undefined)
        }))

        jest.doMock('fs', () => {
            const mStream = {
                on: jest.fn().mockImplementation(function(event, cb) {
                    if (event === 'finish') cb()
                    return this
                }),
                pipe: jest.fn().mockReturnThis(),
                read: jest.fn().mockReturnValue(Buffer.from('abc123', 'hex'))
            }
            return {
                createReadStream: jest.fn().mockReturnValue(mStream)
            }
        })

        jest.doMock('crypto', () => ({
            createHash: jest.fn().mockReturnValue(mHash)
        }))

        jest.doMock('child_process', () => ({
            spawn: jest.fn().mockImplementation((cmd, args) => {
                let stdoutData = Buffer.alloc(0)
                if (args.includes('-tf') || args.includes('-Z1')) {
                    stdoutData = Buffer.from('file1.txt\nfile2.txt')
                }
                return {
                    stdout: { on: jest.fn().mockImplementation((event, cb) => {
                        if (event === 'data') cb(stdoutData)
                    })},
                    stderr: { on: jest.fn() },
                    on: jest.fn().mockImplementation((event, cb) => {
                        if (event === 'close') cb(0)
                    })
                }
            })
        }))

        // Silence console
        jest.spyOn(console, 'log').mockImplementation(() => {})
        jest.spyOn(console, 'error').mockImplementation(() => {})
        jest.spyOn(console, 'warn').mockImplementation(() => {})

        FileUtils = require('../../../../../../../app/assets/js/core/common/FileUtils')
        fsPromises = require('fs/promises')
        crypto = require('crypto')
        child_process = require('child_process')
        fs = require('fs')
    })

    beforeEach(() => {
        jest.clearAllMocks()
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })
    describe('validateLocalFile', () => {
        it('should return true if hash matches', async () => {
            const result = await FileUtils.validateLocalFile('path/to/file', 'sha1', 'abc123', 100)
            expect(result).toBe(true)
        })

        it('should return false if size mismatches', async () => {
            fsPromises.stat.mockResolvedValue({ size: 200 })
            const result = await FileUtils.validateLocalFile('path/to/file', 'sha1', 'abc123', 100)
            expect(result).toBe(false)
        })

        it('should return false if algorithm is unsupported', async () => {
            crypto.createHash.mockImplementationOnce(() => { throw new Error('Digest method not supported') })
            const result = await FileUtils.validateLocalFile('path/to/file', 'invalid-algo', 'abc123', 100)
            expect(result).toBe(false)
        })

        it('should handle missing hash and return true if requested', async () => {
            const result = await FileUtils.validateLocalFile('path/to/file', 'sha1', null, 100, false)
            expect(result).toBe(true)
        })

        it('should fail if hash is strictly required but missing', async () => {
            const result = await FileUtils.validateLocalFile('path/to/file', 'sha1', null, 100, true)
            expect(result).toBe(false)
        })
    })

    describe('calculateHashByBuffer', () => {
        it('should calculate hash correctly', () => {
            const result = FileUtils.calculateHashByBuffer(Buffer.from('test'), 'sha1')
            expect(result).toBe('abc123')
        })

        it('should return null on error', () => {
            crypto.createHash.mockImplementationOnce(() => { throw new Error('fail') })
            const result = FileUtils.calculateHashByBuffer(Buffer.from('test'), 'sha1')
            expect(result).toBeNull()
        })
    })

    describe('Directory and Path Helpers', () => {
        it('should ensure directory exists', async () => {
            await FileUtils.safeEnsureDir('/test/dir')
            expect(fsPromises.mkdir).toHaveBeenCalledWith('/test/dir', { recursive: true })
        })

        it('should return correct library dir', () => {
            expect(FileUtils.getLibraryDir('/common')).toBe(path.join('/common', 'libraries'))
        })

        it('should return correct version dir', () => {
            expect(FileUtils.getVersionDir('/common')).toBe(path.join('/common', 'versions'))
        })

        it('should return correct version json path', () => {
            expect(FileUtils.getVersionJsonPath('/common', '1.20.1')).toBe(path.join('/common', 'versions', '1.20.1', '1.20.1.json'))
        })

        it('should return correct version jar path', () => {
            expect(FileUtils.getVersionJarPath('/common', '1.20.1')).toBe(path.join('/common', 'versions', '1.20.1', '1.20.1.jar'))
        })
    })

    describe('extractZip', () => {
        it('should call onEntry with entries', async () => {
            Object.defineProperty(process, 'platform', { value: 'linux' })
            const onEntry = jest.fn()
            await FileUtils.extractZip('archive.zip', 'dest', onEntry)
            expect(onEntry).toHaveBeenCalled()
            const callArg = onEntry.mock.calls[0][0]
            const entries = callArg.entries()
            expect(entries['file1.txt']).toBeDefined()
        })

        it('should fallback to powershell for entry listing on windows', async () => {
            Object.defineProperty(process, 'platform', { value: 'win32' })
            child_process.spawn.mockImplementationOnce((cmd, args) => {
                return { // tar xf
                    stdout: { on: jest.fn() },
                    stderr: { on: jest.fn() },
                    on: jest.fn().mockImplementation((event, cb) => { if (event === 'close') cb(0) })
                }
            }).mockImplementationOnce((cmd, args) => {
                return { // tar tf (FAIL)
                    stdout: { on: jest.fn() },
                    stderr: { on: jest.fn() },
                    on: jest.fn().mockImplementation((event, cb) => { if (event === 'close') cb(1) })
                }
            }).mockImplementationOnce((cmd, args) => {
                return { // powershell (SUCCESS)
                    stdout: { on: jest.fn().mockImplementation((ev, cb) => cb(Buffer.from('ps-file1\nps-file2'))) },
                    stderr: { on: jest.fn() },
                    on: jest.fn().mockImplementation((event, cb) => { if (event === 'close') cb(0) })
                }
            })

            const onEntry = jest.fn()
            await FileUtils.extractZip('archive.zip', 'dest', onEntry)
            expect(onEntry).toHaveBeenCalled()
        })
    })

    describe('readFileFromZip', () => {
        it('should read file using tar on windows', async () => {
            Object.defineProperty(process, 'platform', { value: 'win32' })
            child_process.spawn.mockImplementation((cmd, args) => ({
                stdout: { on: jest.fn().mockImplementation((ev, cb) => cb(Buffer.from('file-content'))) },
                stderr: { on: jest.fn() },
                on: jest.fn().mockImplementation((event, cb) => { if (event === 'close') cb(0) })
            }))
            const res = await FileUtils.readFileFromZip('archive.zip', 'file.txt')
            expect(res.toString()).toBe('file-content')
        })

        it('should read file using unzip on linux', async () => {
            Object.defineProperty(process, 'platform', { value: 'linux' })
            child_process.spawn.mockImplementation((cmd, args) => ({
                stdout: { on: jest.fn().mockImplementation((ev, cb) => cb(Buffer.from('linux-content'))) },
                stderr: { on: jest.fn() },
                on: jest.fn().mockImplementation((event, cb) => { if (event === 'close') cb(0) })
            }))
            const res = await FileUtils.readFileFromZip('archive.zip', 'file.txt')
            expect(res.toString()).toBe('linux-content')
        })

        it('should throw if both tar and powershell fail on windows', async () => {
            Object.defineProperty(process, 'platform', { value: 'win32' })
            child_process.spawn.mockImplementation((cmd, args) => ({
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn().mockImplementation((ev, cb) => cb(Buffer.from('err'))) },
                on: jest.fn().mockImplementation((event, cb) => { if (event === 'close') cb(1) })
            }))
            await expect(FileUtils.readFileFromZip('archive.zip', 'file.txt')).rejects.toThrow('Failed to read file from zip')
        })
    })

    describe('extractTarGz', () => {
        it('should extract tar.gz and call onEntry', async () => {
            const onEntry = jest.fn()
            await FileUtils.extractTarGz('archive.tar.gz', onEntry)
            expect(child_process.spawn).toHaveBeenCalledWith('tar', expect.arrayContaining(['-xzf']), expect.any(Object))
            expect(onEntry).toHaveBeenCalledWith(expect.objectContaining({ name: 'file1.txt' }))
        })
    })
})
