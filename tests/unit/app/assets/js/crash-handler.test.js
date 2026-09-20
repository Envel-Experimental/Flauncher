describe('CrashHandler', () => {
    let CrashHandler
    let fs

    beforeEach(() => {
        jest.resetModules()
        
        // Mock fs/promises
        const mockFs = {
            stat: jest.fn(),
            open: jest.fn(),
        }
        jest.mock('fs/promises', () => mockFs)

        // Correct path: tests/unit/app/assets/js/crash-handler.test.js -> app/assets/js/core/crash-handler
        CrashHandler = require('../../../../../app/assets/js/core/crash-handler')
        fs = require('fs/promises')
        
        jest.clearAllMocks()
    })

    describe('analyzeLog (synchronous)', () => {
        it('should detect corrupted TOML config files', () => {
            const log = 'Some log\nFailed loading config file example.toml\nMore log';
            const result = CrashHandler.analyzeLog(log);
            expect(result).toEqual({
                type: 'corrupted-config',
                file: 'example.toml',
                descriptionKey: 'corrupted-config',
                descriptionArgs: { file: 'example.toml' }
            });
        });

        it('should detect missing version json file (ENOENT)', () => {
            const log = "ENOENT: no such file or directory, open 'C:\\Users\\Dns11\\AppData\\Roaming\\.foxford\\common\\versions\\1.20.1-fabric-0.16.10\\1.20.1-fabric-0.16.10.json'";
            const result = CrashHandler.analyzeLog(log);
            expect(result).toEqual({
                type: 'missing-version-file',
                file: '1.20.1-fabric-0.16.10.json',
                descriptionKey: 'missing-version-file'
            });
        });

        it('should detect macOS architecture mismatch and dlopen errors', () => {
            const log = "java.lang.UnsatisfiedLinkError: /path/to/lib.dylib (mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64'))";
            const result = CrashHandler.analyzeLog(log);
            expect(result).toEqual({
                type: 'arch-mismatch',
                file: 'Native Architecture',
                descriptionKey: 'arch-mismatch'
            });
        });
    });

    describe('analyzeFile (asynchronous with partial read)', () => {
        const filePath = '/mock/path/to/latest.log';
        let mockFileHandle;

        beforeEach(() => {
            mockFileHandle = {
                read: jest.fn(),
                close: jest.fn()
            };
            fs.open.mockResolvedValue(mockFileHandle);
        });

        it('should read the file tail and detect crash', async () => {
            const crashLog = 'Some log content\nFailed loading config file corrupted.toml\nEnd of log';
            const fileSize = 2000;
            const buffer = Buffer.from(crashLog);

            fs.stat.mockResolvedValue({ size: fileSize });

            mockFileHandle.read.mockImplementation(async (buf, offset, length, position) => {
                buffer.copy(buf);
                return { bytesRead: buffer.length, buffer: buf };
            });

            const result = await CrashHandler.analyzeFile(filePath);

            expect(fs.stat).toHaveBeenCalledWith(filePath);
            expect(fs.open).toHaveBeenCalledWith(filePath, 'r');
            expect(mockFileHandle.read).toHaveBeenCalled();
            expect(mockFileHandle.close).toHaveBeenCalled();

            expect(result).toEqual({
                type: 'corrupted-config',
                file: 'corrupted.toml',
                descriptionKey: 'corrupted-config',
                descriptionArgs: { file: 'corrupted.toml' }
            });
        });
    });
});
