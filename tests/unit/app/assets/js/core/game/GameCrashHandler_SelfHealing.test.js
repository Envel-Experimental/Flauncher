const path = require('path')
const fs = require('fs')
const os = require('os')
const GameCrashHandler = require('../../../../../../../app/assets/js/core/game/GameCrashHandler')

describe('GameCrashHandler Self-Healing & Lock Resistance', () => {
    let tmpDir

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gch-test-'))
    })

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        } catch (e) { }
    })

    test('safeRemoveOrResetConfig should successfully rename normal corrupted config to .disabled', async () => {
        const configDir = path.join(tmpDir, 'config')
        fs.mkdirSync(configDir, { recursive: true })
        const targetFile = path.join(configDir, 'forgeconfigapiport.toml')
        fs.writeFileSync(targetFile, 'corrupted_content')

        const handler = new GameCrashHandler(tmpDir, tmpDir, { rawServer: { id: 'test' } }, [])
        const res = await handler.safeRemoveOrResetConfig('forgeconfigapiport.toml')

        expect(res.success).toBe(true)
        expect(fs.existsSync(targetFile)).toBe(false)
        expect(fs.existsSync(targetFile + '.disabled')).toBe(true)
    })

    test('safeRemoveOrResetConfig should fallback to truncating if rename and unlink are locked', async () => {
        const configDir = path.join(tmpDir, 'config')
        fs.mkdirSync(configDir, { recursive: true })
        const targetFile = path.join(configDir, 'forgeconfigapiport.toml')
        fs.writeFileSync(targetFile, 'broken_data')

        const handler = new GameCrashHandler(tmpDir, tmpDir, { rawServer: { id: 'test' } }, [])

        const originalRenameSync = fs.renameSync
        const originalUnlinkSync = fs.unlinkSync
        try {
            fs.renameSync = jest.fn(() => {
                const err = new Error('File locked')
                err.code = 'EBUSY'
                throw err
            })
            fs.unlinkSync = jest.fn(() => {
                const err = new Error('File locked')
                err.code = 'EPERM'
                throw err
            })

            const res = await handler.safeRemoveOrResetConfig('forgeconfigapiport.toml')

            expect(res.success).toBe(true)
            expect(fs.readFileSync(targetFile, 'utf8')).toBe('')
        } finally {
            fs.renameSync = originalRenameSync
            fs.unlinkSync = originalUnlinkSync
        }
    })

    test('safeRemoveOrResetConfig should return locked status when all attempts fail', async () => {
        const configDir = path.join(tmpDir, 'config')
        fs.mkdirSync(configDir, { recursive: true })
        const targetFile = path.join(configDir, 'forgeconfigapiport.toml')
        fs.writeFileSync(targetFile, 'broken_data')

        const handler = new GameCrashHandler(tmpDir, tmpDir, { rawServer: { id: 'test' } }, [])

        const originalRenameSync = fs.renameSync
        const originalUnlinkSync = fs.unlinkSync
        const originalWriteFileSync = fs.writeFileSync
        try {
            fs.renameSync = jest.fn(() => {
                const err = new Error('File locked')
                err.code = 'EBUSY'
                throw err
            })
            fs.unlinkSync = jest.fn(() => {
                const err = new Error('File locked')
                err.code = 'EPERM'
                throw err
            })
            fs.writeFileSync = jest.fn(() => {
                const err = new Error('Access denied')
                err.code = 'EACCES'
                throw err
            })

            const res = await handler.safeRemoveOrResetConfig('forgeconfigapiport.toml')

            expect(res.success).toBe(false)
            expect(res.reason).toBe('locked')
        } finally {
            fs.renameSync = originalRenameSync
            fs.unlinkSync = originalUnlinkSync
            fs.writeFileSync = originalWriteFileSync
        }
    })

    test('handleCrashFix shows locked file overlay when safeRemoveOrResetConfig fails', async () => {
        const handler = new GameCrashHandler(tmpDir, tmpDir, { rawServer: { id: 'test' } }, [])
        handler.safeRemoveOrResetConfig = jest.fn().mockResolvedValue({ success: false, reason: 'locked' })
        handler.showLockedFileOverlay = jest.fn().mockResolvedValue()
        handler.restartGame = jest.fn().mockResolvedValue()

        await handler.handleCrashFix({ type: 'corrupted-config', file: 'forgeconfigapiport.toml' })

        expect(handler.showLockedFileOverlay).toHaveBeenCalledWith('forgeconfigapiport.toml')
        expect(handler.restartGame).not.toHaveBeenCalled()
    })

    test('handleCrashFix restarts game when safeRemoveOrResetConfig succeeds', async () => {
        const handler = new GameCrashHandler(tmpDir, tmpDir, { rawServer: { id: 'test' } }, [])
        handler.safeRemoveOrResetConfig = jest.fn().mockResolvedValue({ success: true })
        handler.showLockedFileOverlay = jest.fn().mockResolvedValue()
        handler.restartGame = jest.fn().mockResolvedValue()

        await handler.handleCrashFix({ type: 'corrupted-config', file: 'forgeconfigapiport.toml' })

        expect(handler.restartGame).toHaveBeenCalled()
        expect(handler.showLockedFileOverlay).not.toHaveBeenCalled()
    })
})
