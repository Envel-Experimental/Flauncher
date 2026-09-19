const path = require('path')
describe('ConfigManager Detailed Tests', () => {
    let ConfigManager
    let fs
    let os
    let SecurityUtils
    let util
    let pathutil

    beforeEach(() => {
        jest.resetModules()

        // Mock Dependencies
        jest.doMock('fs/promises', () => ({
            mkdir: jest.fn().mockResolvedValue(),
            access: jest.fn().mockResolvedValue()
        }))

        jest.doMock('os', () => ({
            totalmem: jest.fn().mockReturnValue(16 * 1024 * 1024 * 1024), // 16GB
            platform: jest.fn().mockReturnValue('win32'),
            homedir: jest.fn().mockReturnValue('C:\\Users\\Mock'),
            arch: jest.fn().mockReturnValue('x64')
        }))

        jest.doMock('electron', () => ({
            app: {
                getPath: jest.fn().mockReturnValue('C:\\MockUserData'),
                getName: jest.fn().mockReturnValue('Flauncher')
            }
        }), { virtual: true })

        jest.doMock('@core/util/SecurityUtils', () => ({
            encryptString: jest.fn((s) => 'encrypted_' + s),
            decryptString: jest.fn((s) => s.replace('encrypted_', ''))
        }))

        const utilPath = path.resolve(__dirname, '../../../../../../app/assets/js/core/util')
        const normalizedUtilPath = utilPath.charAt(0).toUpperCase() + utilPath.slice(1).replace(/\\/g, '/')
        const lowercaseUtilPath = utilPath.charAt(0).toLowerCase() + utilPath.slice(1).replace(/\\/g, '/')
        const winNormalizedUtilPath = utilPath.charAt(0).toUpperCase() + utilPath.slice(1).replace(/\//g, '\\')
        const winLowercaseUtilPath = utilPath.charAt(0).toLowerCase() + utilPath.slice(1).replace(/\//g, '\\')

        // Also mock the exact relative path from configmanager.js which is located in app/assets/js/core/
        const relativeUtilPath = path.resolve(__dirname, '../../../../../../app/assets/js/core/util')

        const mockUtil = {
            retry: jest.fn((fn) => fn()),
            move: jest.fn().mockResolvedValue(),
            safeReadJson: jest.fn(),
            safeWriteJson: jest.fn().mockResolvedValue()
        }

        jest.doMock(normalizedUtilPath, () => mockUtil, { virtual: true })
        jest.doMock(lowercaseUtilPath, () => mockUtil, { virtual: true })
        jest.doMock(winNormalizedUtilPath, () => mockUtil, { virtual: true })
        jest.doMock(winLowercaseUtilPath, () => mockUtil, { virtual: true })
        jest.doMock('@core/util', () => mockUtil, { virtual: true })
        jest.doMock('@app/assets/js/core/util', () => mockUtil, { virtual: true })
        jest.doMock('./util', () => mockUtil, { virtual: true })
        // Add exact relative path mock for relative require('./util') inside configmanager.js
        const cmDir = path.resolve(__dirname, '../../../../../../app/assets/js/core')
        jest.doMock(path.join(cmDir, 'util').replace(/\\/g, '/'), () => mockUtil, { virtual: true })
        jest.doMock(path.join(cmDir, 'util').charAt(0).toUpperCase() + path.join(cmDir, 'util').slice(1).replace(/\\/g, '/'), () => mockUtil, { virtual: true })
        jest.doMock(path.join(cmDir, 'util').charAt(0).toLowerCase() + path.join(cmDir, 'util').slice(1).replace(/\\/g, '/'), () => mockUtil, { virtual: true })

        jest.doMock('@core/pathutil', () => ({
            resolveDataPathSync: jest.fn().mockReturnValue('C:\\MockLauncherDir')
        }))

        jest.doMock('@core/util/LoggerUtil', () => ({
            LoggerUtil: {
                getLogger: jest.fn(() => ({
                    info: jest.fn(),
                    warn: jest.fn(),
                    error: jest.fn(),
                    debug: jest.fn()
                }))
            }
        }))

        // Mock global fetch
        global.fetch = jest.fn()

        ConfigManager = require('@core/configmanager')
        fs = require('fs/promises')
        os = require('os')
        SecurityUtils = require('@core/util/SecurityUtils')
        util = require('@core/util')
        pathutil = require('@core/pathutil')
    })

    describe('RAM Calculation', () => {
        test('getAbsoluteMaxRAM should cap at 70% of total RAM and 12GB', () => {
            // 16GB total -> 70% is ~11.2GB. Limit is 12GB. Should return 11.
            expect(ConfigManager.getAbsoluteMaxRAM()).toBe(11)

            // 32GB total -> 70% is 22.4GB. Limit is 12GB. Should return 12.
            os.totalmem.mockReturnValue(32 * 1024 * 1024 * 1024)
            expect(ConfigManager.getAbsoluteMaxRAM()).toBe(12)
        })

        test('getAbsoluteMaxRAM should respect serverMax if provided', () => {
            os.totalmem.mockReturnValue(32 * 1024 * 1024 * 1024)
            // serverMax 4096MB = 4GB. Limit is 12GB. Should return 4.
            expect(ConfigManager.getAbsoluteMaxRAM(4096)).toBe(4)
        })
    })

    describe('Config Loading (Main)', () => {
        test('load should migrate legacy config if it exists', async () => {
            const fsSync = require('fs')
            const mockLauncherDir = path.join('MockLauncherDir', 'config.json')
            const mockUserData = path.join('MockUserData', 'config.json')

            jest.spyOn(fsSync, 'existsSync').mockImplementation((p) => {
                const normalizedP = p.replace(/\\/g, '/')
                if (normalizedP.includes('MockLauncherDir/config.json')) return false
                if (normalizedP.includes('MockUserData/config.json')) return true
                return false
            })
            util.safeReadJson.mockResolvedValue({ settings: {} })

            await ConfigManager.load()

            expect(util.move).toHaveBeenCalledWith(
                expect.stringContaining('MockUserData'),
                expect.stringContaining('MockLauncherDir')
            )
        })

        test('load should decrypt authenticationDatabase', async () => {
            const fsSync = require('fs')
            jest.spyOn(fsSync, 'existsSync').mockReturnValue(true)
            util.safeReadJson.mockResolvedValue({
                authenticationDatabase: {
                    'uuid1': { accessToken: 'encrypted_secret' }
                }
            })

            await ConfigManager.load()

            const accounts = ConfigManager.getAuthAccounts()
            expect(accounts['uuid1'].accessToken).toBe('secret')
            expect(SecurityUtils.decryptString).toHaveBeenCalledWith('encrypted_secret')
        })
    })

    describe('Config Saving', () => {
        test('save should encrypt authenticationDatabase', async () => {
            const fsSync = require('fs')
            jest.spyOn(fsSync, 'existsSync').mockReturnValue(true)
            util.safeReadJson.mockResolvedValue({ settings: {} })
            await ConfigManager.load()

            ConfigManager.setConfig({
                authenticationDatabase: {
                    'uuid1': { accessToken: 'secret' }
                }
            })

            await ConfigManager.save()

            expect(util.safeWriteJson).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    authenticationDatabase: {
                        'uuid1': expect.objectContaining({ accessToken: 'encrypted_secret' })
                    }
                })
            )
        })
    })

    describe('Getters/Setters', () => {
        test('should handle missing config in getters', () => {
            ConfigManager.setConfig(null)
            expect(ConfigManager.getSettings()).toBeDefined()
            expect(ConfigManager.getSelectedServer()).toBeNull()
            expect(ConfigManager.getAuthAccounts()).toEqual({})
            const expectedCompat = process.platform === 'darwin' && process.arch === 'arm64'
            expect(ConfigManager.getMacOSCompatibility()).toBe(expectedCompat)
        })

        test('should remember and save macOSCompatibility toggle setting', () => {
            ConfigManager.setConfig({
                settings: {
                    game: {
                        macOSCompatibility: false
                    }
                }
            })
            expect(ConfigManager.getMacOSCompatibility()).toBe(false)
            ConfigManager.setMacOSCompatibility(true)
            expect(ConfigManager.getMacOSCompatibility()).toBe(true)
            expect(ConfigManager.getConfig().settings.game.macOSCompatibility).toBe(true)
            ConfigManager.setMacOSCompatibility(false)
            expect(ConfigManager.getMacOSCompatibility()).toBe(false)
            expect(ConfigManager.getConfig().settings.game.macOSCompatibility).toBe(false)
        })

        test('should default macOSCompatibility to true on Apple Silicon (darwin arm64)', () => {
            const origPlatform = process.platform
            const origArch = process.arch
            try {
                Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
                Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
                ConfigManager.setConfig(null)
                expect(ConfigManager.getMacOSCompatibility()).toBe(true)

                ConfigManager.setConfig({
                    settings: {
                        game: {}
                    }
                })
                expect(ConfigManager.getMacOSCompatibility()).toBe(true)

                // User explicit override to false must be respected
                ConfigManager.setMacOSCompatibility(false)
                expect(ConfigManager.getMacOSCompatibility()).toBe(false)
            } finally {
                Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
                Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
            }
        })

        test('should update selected account when removing current', () => {
            ConfigManager.setConfig({
                selectedAccount: 'acc1',
                authenticationDatabase: {
                    'acc1': { uuid: 'acc1' },
                    'acc2': { uuid: 'acc2' }
                }
            })

            ConfigManager.removeAuthAccount('acc1')
            expect(ConfigManager.getSelectedAccount().uuid).toBe('acc2')
        })
    })

    describe('fetchWithTimeout', () => {
        test('should reject on timeout', async () => {
            global.fetch.mockReturnValue(new Promise(() => { })) // Never resolves

            await expect(ConfigManager.fetchWithTimeout('http://test', {}, 100))
                .rejects.toThrow('timeout')
        })
    })
})
