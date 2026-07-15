const { ipcMain, app } = require('electron')
const path = require('path')
const ConfigManager = require('../assets/js/core/configmanager')
const ProcessBuilder = require('../assets/js/core/processbuilder')
const { MojangIndexProcessor } = require('../assets/js/core/dl/MojangIndexProcessor')
const { DistributionIndexProcessor } = require('../assets/js/core/dl/DistributionIndexProcessor')
const { LoggerUtil } = require('../assets/js/core/util/LoggerUtil')

const log = LoggerUtil.getLogger('LauncherService')

class LauncherService {
    constructor() {
        this.activeProcess = null
    }

    init() {
        ipcMain.handle('launcher:launch', async (event, { serverId, authUser }) => {
            return await this.launch(event, serverId, authUser)
        })
        ipcMain.on('launcher:terminate', () => {
            if (this.activeProcess) {
                this.activeProcess.kill()
                this.activeProcess = null
            }
        })
    }

    async launch(event, serverId, authUser) {
        log.info(`Preparing launch for server: ${serverId}`)
        
        const DistroManager = require('../assets/js/core/distromanager')
        const distro = await DistroManager.getDistribution()
        const serv = distro.getServerById(serverId)
        
        if (!serv) throw new Error('Server not found in distribution index.')

        const commonDir = await ConfigManager.getCommonDirectory()
        const mcVersion = serv.rawServer.minecraftVersion

        // 1. Initialize Processors
        const mojangProcessor = new MojangIndexProcessor(commonDir, mcVersion)
        const distroProcessor = new DistributionIndexProcessor(commonDir, distro, serverId)

        // 2. Load Manifests
        const modLoaderData = await distroProcessor.loadModLoaderVersionJson(serv)
        const versionData = await mojangProcessor.getVersionJson()

        // 3. Build Process
        const pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, app.getVersion())
        
        const { LogBatcher } = require('../assets/js/core/util/LogBatcher')
        
        log.info('Starting pb.build()...')
        try {
            this.activeProcess = await pb.build()
            log.info('pb.build() successful.')
            
            const logBatcher = new LogBatcher((combined) => {
                if (event && event.sender && !event.sender.isDestroyed()) {
                    event.sender.send('launcher:log', combined)
                }
            })

            // Inject Launch Context for the user to see in DevTools
            if (pb.args && pb.javaPath) {
                const sanitizedArgs = pb.args.map((arg, index, arr) => {
                    if (index > 0 && (arr[index - 1] === '--accessToken' || arr[index - 1] === '--uuid')) return '***'
                    return arg
                })
                const contextString = `====================================================\nLaunch Context:\nJava Path: ${pb.javaPath}\nArguments: ${sanitizedArgs.join(' ')}\n====================================================\n`
                logBatcher.enqueue(contextString)
            }
            
            if (this.activeProcess._hasClosed) {
                log.info(`Game process closed prematurely with code ${this.activeProcess._closeCode}`)
                if (event && event.sender && !event.sender.isDestroyed()) {
                    event.sender.send('launcher:exit', this.activeProcess._closeCode !== null ? this.activeProcess._closeCode : -1)
                }
                this.activeProcess = null
                return { success: true }
            }

            this.activeProcess.stdout.on('data', (data) => logBatcher.enqueue(data))
            this.activeProcess.stderr.on('data', (data) => logBatcher.enqueue(data))

            this.activeProcess.on('close', (code, signal) => {
                logBatcher.flush()
                logBatcher.destroy()
                log.info(`Game process closed with code ${code}`)
                if (event && event.sender && !event.sender.isDestroyed()) {
                    event.sender.send('launcher:exit', code !== null ? code : -1)
                }
                this.activeProcess = null
            })

            return { success: true }
        } catch (err) {
            log.error('Launch failed:', err)
            throw err
        }
    }
}

module.exports = new LauncherService()
