/**
 * @jest-environment node
 */
const path = require('path')

describe('PeerHandler Security', () => {
    let PeerHandler
    let ConfigManager
    let os
    
    // Standardize drive letters for Windows tests
    const dataDir = path.resolve('/game/data')
    const commonDir = path.resolve('/game/common')

    let mockSocket
    let mockEngine
    let peerHandler

    beforeEach(() => {
        jest.resetModules()
        
        // Mock os (required by PeerPersistence if it loads)
        jest.mock('os', () => ({
            userInfo: jest.fn(() => ({ username: 'testuser' })),
            hostname: jest.fn(() => 'testhost'),
            platform: jest.fn(() => 'win32')
        }))

        // Mock ConfigManager
        jest.mock('../../app/assets/js/core/configmanager', () => ({
            getDataDirectory: jest.fn(() => '/game/data'),
            getCommonDirectory: jest.fn(() => '/game/common'),
            getCommonDirectorySync: jest.fn(() => '/game/common'),
            getLauncherDirectorySync: jest.fn(() => '/game/launcher'),
            getP2PUploadEnabled: jest.fn(),
            getLocalOptimization: jest.fn(),
            getP2PUploadLimit: jest.fn()
        }))

        // Mock PeerPersistence to prevent real instantiation issues
        jest.mock('../../network/PeerPersistence', () => ({
            updatePeer: jest.fn(),
            getPeers: jest.fn(() => []),
            load: jest.fn().mockResolvedValue()
        }))

        PeerHandler = require('../../network/PeerHandler')
        ConfigManager = require('../../app/assets/js/core/configmanager')
        os = require('os')

        mockSocket = {
            on: jest.fn(),
            write: jest.fn(),
            destroy: jest.fn(),
            setTimeout: jest.fn(),
            remoteAddress: '127.0.0.1'
        }
        mockEngine = {
            on: jest.fn(),
            emit: jest.fn(),
            profile: { weight: 1 }
        }
        peerHandler = new PeerHandler(mockSocket, mockEngine, { client: true })
        
        // Explicitly set directories for security checks in test
        peerHandler.dataDir = dataDir
        peerHandler.commonDir = commonDir
    })

    test('_isPathSecure blocks traversal attacks', () => {
        const isPathSecure = peerHandler._isPathSecure.bind(peerHandler)
        const attackPath = path.join(dataDir, '../../config.js')
        const result = isPathSecure(attackPath)
        expect(result).toBe(false)
    })

    test('_isPathSecure allows valid assets', () => {
        const isPathSecure = peerHandler._isPathSecure.bind(peerHandler)
        const validPath = path.join(dataDir, 'assets/objects/abc/hash')
        expect(isPathSecure(validPath)).toBe(true)
    })

    test('_isPathSecure blocks strict blacklist files', () => {
        const isPathSecure = peerHandler._isPathSecure.bind(peerHandler)
        const blacklistedPath = path.join(dataDir, 'config.json')
        expect(isPathSecure(blacklistedPath)).toBe(false)
    })
})
