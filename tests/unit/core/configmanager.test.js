const fs = require('fs/promises')
const path = require('path')

// Mock Electron
jest.mock('electron', () => ({
    app: {
        getPath: jest.fn().mockReturnValue('/mock/user/data'),
        getVersion: jest.fn().mockReturnValue('1.0.0')
    }
}))

// Mock util
jest.mock('../../../app/assets/js/core/util', () => ({
    retry: jest.fn(async (fn) => await fn()),
    move: jest.fn().mockResolvedValue(),
    safeReadJson: jest.fn(),
    safeWriteJson: jest.fn(),
    LoggerUtil: {
        getLogger: jest.fn().mockReturnValue({
            info: jest.fn(),
            error: jest.fn()
        })
    }
}))

// Mock pathutil
jest.mock('../../../app/assets/js/core/pathutil', () => ({
    resolveDataPathSync: jest.fn().mockReturnValue('/mock/launcher/dir')
}))

// Mock SecurityUtils
jest.mock('../../../app/assets/js/core/util/SecurityUtils', () => ({
    decryptString: jest.fn(s => s),
    encryptString: jest.fn(s => s)
}))

// Mock OS
jest.mock('os', () => ({
    hostname: jest.fn().mockReturnValue('test-host'),
    totalmem: jest.fn().mockReturnValue(16 * 1024 * 1024 * 1024), // 16GB
    userInfo: jest.fn().mockReturnValue({ username: 'mock' })
}))

// Mock AvatarCache
const mockRemoveCachedAvatar = jest.fn()
jest.mock('../../../app/assets/js/core/util/AvatarCache', () => ({
    removeCachedAvatar: mockRemoveCachedAvatar
}))

const ConfigManager = require('../../../app/assets/js/core/configmanager')

describe('ConfigManager', () => {
    
    beforeEach(() => {
        jest.clearAllMocks()
        ConfigManager.setConfig(null)
    })

    it('should return launcher directory', async () => {
        const dir = await ConfigManager.getLauncherDirectory()
        expect(dir).toBe('/mock/launcher/dir')
    })

    it('should calculate RAM limits', () => {
        expect(ConfigManager.getAbsoluteMaxRAM()).toBe(11)
        expect(ConfigManager.getAbsoluteMinRAM()).toBe(1)
        expect(ConfigManager.getAbsoluteMaxRAM(2048)).toBe(2) // Server limit
    })

    it('should handle fetchWithTimeout', async () => {
        global.fetch = jest.fn().mockResolvedValue('ok')
        const res = await ConfigManager.fetchWithTimeout('url', {}, 1000)
        expect(res).toBe('ok')
    })

    it('should manage auth accounts', () => {
        ConfigManager.setConfig({ authenticationDatabase: {}, selectedAccount: null })
        ConfigManager.addMojangAuthAccount('u1', 't1', 'n1', 'd1')
        expect(ConfigManager.getSelectedAccount().uuid).toBe('u1')
        
        ConfigManager.removeAuthAccount('u1')
        expect(ConfigManager.getSelectedAccount()).toBeNull()
        expect(mockRemoveCachedAvatar).toHaveBeenCalledWith('u1')

        ConfigManager.addMicrosoftAuthAccount('u2', 't2', 'n2', 100, 'ms1', 'ms2', 200)
        expect(ConfigManager.getAuthAccount('u2').type).toBe('microsoft')
        
        ConfigManager.updateMicrosoftAuthAccount('u2', 't3', 'ms3', 'ms4', 300, 400)
        expect(ConfigManager.getAuthAccount('u2').accessToken).toBe('t3')
    })

    it('should handle Java config', () => {
        ConfigManager.setConfig({ javaConfig: { minRAM: '1G' } })
        expect(ConfigManager.getMinRAM()).toBe('1G')
        
        ConfigManager.setJavaExecutable('id1', '/bin/java')
        expect(ConfigManager.getJavaExecutable('id1')).toBe('/bin/java')
        
        ConfigManager.setJVMOptions('id1', ['-Xmx'])
        expect(ConfigManager.getJVMOptions('id1')).toEqual(['-Xmx'])
    })

    it('should handle mod configurations', () => {
        ConfigManager.setConfig({ modConfigurations: {} })
        ConfigManager.setModConfiguration('srv1', { mods: { 'm1': true } })
        expect(ConfigManager.getModConfiguration('srv1').mods.m1).toBe(true)
    })
});
