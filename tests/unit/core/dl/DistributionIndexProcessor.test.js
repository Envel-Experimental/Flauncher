const { DistributionIndexProcessor } = require('../../../../app/assets/js/core/dl/DistributionIndexProcessor');
const MirrorManager = require('../../../../network/MirrorManager');
const FileUtils = require('../../../../app/assets/js/core/common/FileUtils');

jest.mock('../../../../network/MirrorManager');
jest.mock('../../../../app/assets/js/core/common/FileUtils');
jest.mock('fs/promises', () => ({
    access: jest.fn().mockRejectedValue(new Error('ENOENT'))
}));

describe('DistributionIndexProcessor', () => {
    let processor;
    let mockServer;
    let mockModule;

    beforeEach(() => {
        jest.clearAllMocks();

        mockModule = {
            getPath: jest.fn().mockReturnValue('mock/path'),
            rawModule: {
                id: 'test-module',
                force: false,
                artifact: {
                    size: 100,
                    SHA256: 'mock-hash'
                }
            },
            hasSubModules: jest.fn().mockReturnValue(false)
        };

        mockServer = {
            modules: [mockModule],
            rawServer: { minecraftVersion: '1.20.1' }
        };

        const mockDistribution = {
            getServerById: jest.fn().mockReturnValue(mockServer)
        };

        processor = new DistributionIndexProcessor('common', mockDistribution, 'server1');
        
        // Mock validateLocalFile to always return false so it tries to download
        FileUtils.validateLocalFile.mockResolvedValue(false);
    });

    describe('URL Resolution with relUrl', () => {
        it('should correctly join relUrl with a standard mirror', async () => {
            MirrorManager.getSortedMirrors.mockReturnValue([
                { distribution: 'https://s3.com/distribution.json' },
                { distribution: 'https://backup.com/distribution.json' }
            ]);
            mockModule.rawModule.artifact.relUrl = 'libraries/test.jar';

            const results = await processor.validateModules([mockModule]);

            expect(results[0].url).toBe('https://s3.com/libraries/test.jar');
            expect(results[0].fallbackUrls).toEqual([
                'https://backup.com/libraries/test.jar'
            ]);
        });

        it('should safely join when relUrl starts with a slash', async () => {
            MirrorManager.getSortedMirrors.mockReturnValue([
                { distribution: 'https://s3.com/test/distribution.json' }
            ]);
            mockModule.rawModule.artifact.relUrl = '/libraries/test.jar';

            const results = await processor.validateModules([mockModule]);

            expect(results[0].url).toBe('https://s3.com/test/libraries/test.jar');
            expect(results[0].fallbackUrls).toEqual([]);
        });

        it('should gracefully handle mirrors without a trailing slash (e.g. naked domains)', async () => {
            MirrorManager.getSortedMirrors.mockReturnValue([
                { distribution: 'https://s3.com' } // Malformed/edge-case naked domain
            ]);
            mockModule.rawModule.artifact.relUrl = 'libraries/test.jar';

            const results = await processor.validateModules([mockModule]);

            // Our new safe logic ensures base is not cut into the protocol
            expect(results[0].url).toBe('https://s3.com/libraries/test.jar');
        });

        it('should gracefully handle mirrors with a trailing slash', async () => {
            MirrorManager.getSortedMirrors.mockReturnValue([
                { distribution: 'https://s3.com/' } // Malformed/edge-case trailing slash
            ]);
            mockModule.rawModule.artifact.relUrl = 'libraries/test.jar';

            const results = await processor.validateModules([mockModule]);

            expect(results[0].url).toBe('https://s3.com/libraries/test.jar');
        });

        it('should fallback to old logic if relUrl is missing but url exists', async () => {
            MirrorManager.getSortedMirrors.mockReturnValue([
                { distribution: 'https://s3.com/distribution.json' },
                { distribution: 'https://backup.com/distribution.json' }
            ]);
            mockModule.rawModule.artifact.url = 'https://s3.com/libraries/old.jar';
            // relUrl is intentionally missing

            const results = await processor.validateModules([mockModule]);

            expect(results[0].url).toBe('https://s3.com/libraries/old.jar');
            expect(results[0].fallbackUrls).toEqual([
                'https://backup.com/libraries/old.jar'
            ]);
        });
    });

    describe('Fuzzing & Malformed Inputs', () => {
        it('should handle undefined or empty relUrl gracefully', async () => {
            MirrorManager.getSortedMirrors.mockReturnValue([
                { distribution: 'https://s3.com/distribution.json' }
            ]);
            mockModule.rawModule.artifact.relUrl = '';
            mockModule.rawModule.artifact.url = 'https://s3.com/libraries/old.jar';

            const results = await processor.validateModules([mockModule]);

            expect(results[0].url).toBe('https://s3.com/libraries/old.jar');
        });

        it('should handle undefined mirror distribution', async () => {
            MirrorManager.getSortedMirrors.mockReturnValue([
                { distribution: undefined },
                { distribution: 'https://s3.com/distribution.json' }
            ]);
            mockModule.rawModule.artifact.relUrl = 'libraries/test.jar';

            const results = await processor.validateModules([mockModule]);

            // First mirror has no distribution, so it skips to the second
            expect(results[0].url).toBe('https://s3.com/libraries/test.jar');
        });

        it('should handle extremely malformed URLs without crashing', async () => {
            MirrorManager.getSortedMirrors.mockReturnValue([
                { distribution: 'not_a_url' },
                { distribution: 'http://localhost' }
            ]);
            mockModule.rawModule.artifact.relUrl = '///weird//path.jar';

            const results = await processor.validateModules([mockModule]);

            expect(results[0].url).toBe('not_a_url///weird//path.jar');
            expect(results[0].fallbackUrls).toEqual([
                'http://localhost///weird//path.jar'
            ]);
        });
    });

    describe('Instances Directory Validation', () => {
        const fs = require('fs/promises');

        it('should download a file inside instances if it does not exist on disk', async () => {
            mockModule.getPath.mockReturnValue('mock/instances/options.txt');
            fs.access.mockRejectedValueOnce(new Error('ENOENT')); // File doesn't exist
            FileUtils.validateLocalFile.mockResolvedValue(false);

            const results = await processor.validateModules([mockModule]);

            expect(results.length).toBe(1);
            expect(results[0].id).toBe('test-module');
        });

        it('should skip downloading a file inside instances if it already exists on disk', async () => {
            mockModule.getPath.mockReturnValue('mock/instances/options.txt');
            fs.access.mockResolvedValueOnce(undefined); // File exists

            const results = await processor.validateModules([mockModule]);

            expect(results.length).toBe(0); // Skipped validation and download
        });

        it('should download an untracked file (no SHA256) if it does not exist on disk', async () => {
            mockModule.rawModule.artifact.SHA256 = undefined; // Untracked (no hash)
            mockModule.getPath.mockReturnValue('mock/instances/options.txt');
            fs.access.mockRejectedValueOnce(new Error('ENOENT')); // File doesn't exist
            FileUtils.validateLocalFile.mockResolvedValue(false);

            const results = await processor.validateModules([mockModule]);

            expect(results.length).toBe(1);
            expect(results[0].hash).toBeNull();
            expect(results[0].algo).toBeNull();
        });

        it('should skip downloading an untracked file (no SHA256) if it exists on disk', async () => {
            mockModule.rawModule.artifact.SHA256 = undefined; // Untracked (no hash)
            mockModule.getPath.mockReturnValue('mock/instances/options.txt');
            fs.access.mockResolvedValueOnce(undefined); // File exists

            const results = await processor.validateModules([mockModule]);

            expect(results.length).toBe(0);
        });
    });
});
