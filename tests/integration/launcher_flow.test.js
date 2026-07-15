const DistroManager = require('../../app/assets/js/core/distromanager')
const ConfigManager = require('../../app/assets/js/core/configmanager')

// Mock the core dependencies
jest.mock('../../app/assets/js/core/dl/MojangIndexProcessor', () => ({
    MojangIndexProcessor: jest.fn().mockImplementation(() => ({
        getVersionJson: jest.fn().mockResolvedValue({})
    }))
}))
jest.mock('../../app/assets/js/core/dl/DistributionIndexProcessor', () => ({
    DistributionIndexProcessor: jest.fn().mockImplementation(() => ({
        loadModLoaderVersionJson: jest.fn().mockResolvedValue({})
    }))
}))
jest.mock('../../app/assets/js/core/processbuilder')

// Require LauncherService AFTER mocks are defined
const LauncherService = require('../../app/main/LauncherService')
const ProcessBuilder = require('../../app/assets/js/core/processbuilder')
const { MojangIndexProcessor } = require('../../app/assets/js/core/dl/MojangIndexProcessor')
const { DistributionIndexProcessor } = require('../../app/assets/js/core/dl/DistributionIndexProcessor')

describe('Launcher Integration Flow', () => {

    beforeEach(() => {
        jest.clearAllMocks()
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    it('should successfully orchestrate a game launch sequence', async () => {
        // 1. Setup Mock Distribution
        const mockServer = {
            rawServer: {
                minecraftVersion: '1.20.1'
            }
        }
        const mockDistro = {
            getServerById: jest.fn().mockReturnValue(mockServer)
        }
        jest.spyOn(DistroManager, 'getDistribution').mockResolvedValue(mockDistro)

        // 2. Setup Mock Config
        jest.spyOn(ConfigManager, 'getCommonDirectory').mockResolvedValue('/mock/common/dir')

        // 3. Setup Mock Event (Renderer communication)
        const mockEvent = {
            sender: {
                isDestroyed: jest.fn().mockReturnValue(false),
                send: jest.fn()
            }
        }

        // 4. Setup Mock Process
        const mockProcess = {
            stdout: { on: jest.fn() },
            stderr: { on: jest.fn() },
            on: jest.fn(),
            kill: jest.fn()
        }

        // Mock ProcessBuilder constructor and build method
        ProcessBuilder.prototype.build = jest.fn().mockResolvedValue(mockProcess)

        // 5. Execute Launch
        const authUser = { displayName: 'TestPlayer', uuid: '1234' }
        const result = await LauncherService.launch(mockEvent, 'test-server-id', authUser)

        // 6. Verifications
        expect(result.success).toBe(true)

        // Verify Distro was fetched and queried
        expect(DistroManager.getDistribution).toHaveBeenCalled()
        expect(mockDistro.getServerById).toHaveBeenCalledWith('test-server-id')

        // Verify Processors were instantiated
        expect(MojangIndexProcessor).toHaveBeenCalledWith('/mock/common/dir', '1.20.1')
        expect(DistributionIndexProcessor).toHaveBeenCalledWith('/mock/common/dir', mockDistro, 'test-server-id')

        // Verify ProcessBuilder was used
        expect(ProcessBuilder).toHaveBeenCalled()

        // Verify Log forwarding was set up
        expect(mockProcess.stdout.on).toHaveBeenCalledWith('data', expect.any(Function))
        expect(mockProcess.stderr.on).toHaveBeenCalledWith('data', expect.any(Function))
        expect(mockProcess.on).toHaveBeenCalledWith('close', expect.any(Function))
    })

    it('should throw an error if server is not found in distribution', async () => {
        const mockDistro = {
            getServerById: jest.fn().mockReturnValue(null)
        }
        jest.spyOn(DistroManager, 'getDistribution').mockResolvedValue(mockDistro)

        const mockEvent = { sender: { send: jest.fn() } }

        await expect(LauncherService.launch(mockEvent, 'invalid-server', {}))
            .rejects.toThrow('Server not found in distribution index.')
    })

    it('should throw an error if ProcessBuilder.build fails', async () => {
        const mockServer = { rawServer: { minecraftVersion: '1.20.1', id: 'serv' } }
        const mockDistro = { getServerById: jest.fn().mockReturnValue(mockServer) }
        
        jest.spyOn(DistroManager, 'getDistribution').mockResolvedValue(mockDistro)
        jest.spyOn(ConfigManager, 'getCommonDirectory').mockResolvedValue('/mock/common/dir')

        // Mock build failure
        ProcessBuilder.prototype.build.mockRejectedValueOnce(new Error('Java not found'))

        const mockEvent = { sender: { send: jest.fn() } }
        const authUser = { displayName: 'Player' }

        await expect(LauncherService.launch(mockEvent, 'serv', authUser))
            .rejects.toThrow('Java not found')
    })
})
