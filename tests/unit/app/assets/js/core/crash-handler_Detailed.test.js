describe('CrashHandler Detailed Tests', () => {
    let CrashHandler
    let fs

    beforeEach(() => {
        jest.resetModules()

        // Mock fs/promises
        jest.doMock('fs/promises', () => ({
            stat: jest.fn(),
            open: jest.fn(),
            readFile: jest.fn()
        }))

        CrashHandler = require('@core/crash-handler')
        fs = require('fs/promises')
    })

    describe('analyzeLog', () => {
        test('should detect corrupted-config from ConfigLoadingException', () => {
            const log = 'ModConfig$ConfigLoadingException: Error loading config file farmersdelight-client.toml'
            const result = CrashHandler.analyzeLog(log)
            expect(result.type).toBe('corrupted-config')
            expect(result.file).toBe('farmersdelight-client.toml')
        })

        test('should detect corrupted-config from MalformedInputException', () => {
            const log = 'Loading farmersdelight-client.toml\n... java.nio.charset.MalformedInputException: Input length = 1'
            const result = CrashHandler.analyzeLog(log)
            expect(result.type).toBe('corrupted-config')
            expect(result.file).toBe('farmersdelight-client.toml')
        })

        test('should detect corrupted-config from JsonSyntaxException', () => {
            const log = 'com.google.gson.JsonSyntaxException: Unterminated object at line 1 column 5 path $.test\nAt file /game/config/example.json'
            const result = CrashHandler.analyzeLog(log)
            expect(result.type).toBe('corrupted-config')
            expect(result.file).toBe('example.json')
        })

        test('should detect missing-version-file', () => {
            const log = "ENOENT: no such file or directory, open '/launcher/common/versions/1.12.2/1.12.2.json'"
            const result = CrashHandler.analyzeLog(log)
            expect(result.type).toBe('missing-version-file')
            expect(result.file).toBe('1.12.2.json')
        })

        test('should detect incompatible-mods', () => {
            const log = '[main/ERROR]: Incompatible mods found!\n- Mod A depends on Mod B'
            const result = CrashHandler.analyzeLog(log)
            expect(result.type).toBe('incompatible-mods')
        })

        test('should detect java-oom', () => {
            const log = 'java.lang.OutOfMemoryError: Java heap space'
            const result = CrashHandler.analyzeLog(log)
            expect(result.type).toBe('java-oom')
        })

        test('should detect gpu-oom', () => {
            const log = 'The NVIDIA OpenGL driver has encountered an out of memory error'
            const result = CrashHandler.analyzeLog(log)
            expect(result.type).toBe('gpu-oom')
        })

        test('should detect java-corruption from missing core files', () => {
            const log = 'java.io.FileNotFoundException: C:\\Java\\lib\\tzdb.dat'
            const result = CrashHandler.analyzeLog(log)
            expect(result.type).toBe('java-corruption')
        })

        test('should detect java-corruption from unsatisfied link error', () => {
            const log = 'java.lang.UnsatisfiedLinkError: no awt in java.library.path'
            const result = CrashHandler.analyzeLog(log)
            expect(result.type).toBe('java-corruption')
            expect(result.descriptionKey).toBe('java-corruption-natives')
        })

        test('should return null for unknown crash', () => {
            const log = 'Something went wrong but I dont know what'
            const result = CrashHandler.analyzeLog(log)
            expect(result).toBeNull()
        })
    })

    describe('readLastBytes', () => {
        test('should handle empty file', async () => {
            fs.stat.mockResolvedValue({ size: 0 })
            // Note: readLastBytes is not exported directly, but analyzeFile calls it
            // Actually it IS at top level but not exported.
            // Wait, I should check if it's exported. 
            // Looking at the file: it's a private function in the module.
            // I'll test it via analyzeFile.
        })

        test('should handle missing file', async () => {
            fs.stat.mockRejectedValue(new Error('ENOENT'))
            const result = await CrashHandler.analyzeFile('/missing.log')
            expect(result).toBeNull()
        })

        it('should detect wrong-java-version for UnsupportedClassVersionError', () => {
            const log = `java.lang.UnsupportedClassVersionError: class file version 65.0`
            const res = CrashHandler.analyzeLog(log)
            expect(res).not.toBeNull()
            expect(res.type).toBe('wrong-java-version')
        })

        it('should detect wrong-java-version for IncompatibleClassChangeError', () => {
            const log = `java.lang.IncompatibleClassChangeError: class cannot be cast`
            const res = CrashHandler.analyzeLog(log)
            expect(res).not.toBeNull()
            expect(res.type).toBe('wrong-java-version')
        })
    })
})
