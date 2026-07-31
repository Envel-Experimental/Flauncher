const { BrowserWindow, app, Menu, shell } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')
const fs = require('fs')
const isDev = require('../assets/js/core/isdev')

class WindowManager {
    constructor() {
        this.win = null
        this.errorWin = null
        this.msftAuthWindow = null
        this.msftLogoutWindow = null
    }

    getMainWindow() {
        return this.win
    }

    createMainWindow() {
        this.win = new BrowserWindow({
            width: 980,
            height: 552,
            icon: this.getPlatformIcon('icon'),
            frame: false,
            webPreferences: {
                preload: path.join(__dirname, '..', 'assets', 'js', 'preloader.js'),
                nodeIntegration: false, // Security: Disabled
                contextIsolation: true,  // Security: Enabled
                sandbox: true,            // Security: Enabled
                webSecurity: true        // Security: Restored
            },
            backgroundColor: '#171614',
            show: false
        })

        const LaunchController = require('../assets/js/core/LaunchController')
        LaunchController.setWindow(this.win)

        this.win.loadFile(path.join(__dirname, '..', '..', 'app', 'index.html'))

        this.win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
            console.error(`[Main] Window failed to load: ${errorDescription} (${errorCode}) at ${validatedURL}`)
        })

        this.win.webContents.on('console-message', (event, level, message, line, sourceId) => {
            const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR']
            console.log(`[Renderer ${levels[level] || 'LOG'}] (${sourceId}:${line}) ${message}`)
        })

        this.win.on('closed', () => {
            this.win = null
        })

        return this.win
    }

    showCriticalError(err) {
        const SentryService = require('./SentryService')
        SentryService.captureException(err)

        if (this.errorWin && !this.errorWin.isDestroyed()) {
            return
        }

        if (this.win && !this.win.isDestroyed()) {
            this.win.hide()
        }

        this.errorWin = new BrowserWindow({
            width: 800,
            height: 600,
            frame: true,
            backgroundColor: '#0078d7',
            title: 'Critical Error',
            icon: this.getPlatformIcon('icon'),
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, '..', 'assets', 'js', 'errorPreload.js')
            }
        })
        this.errorWin.removeMenu()

        const errorMsg = err.stack || err.message || err.toString()
        const ConfigManager = require('../assets/js/core/configmanager')
        const supportUrl = ConfigManager.getSupportUrl()

        this.errorWin.loadURL(pathToFileURL(path.join(__dirname, '..', '..', 'app', 'error.html')).toString() +
            '?error=' + encodeURIComponent(errorMsg) +
            (supportUrl ? '&supportUrl=' + encodeURIComponent(supportUrl) : ''))

        this.errorWin.webContents.setWindowOpenHandler(({ url }) => {
            shell.openExternal(url)
            return { action: 'deny' }
        })

        this.errorWin.on('closed', () => {
            app.quit()
        })
    }

    createMicrosoftAuthWindow(title) {
        this.msftAuthWindow = new BrowserWindow({
            title: title,
            backgroundColor: '#222222',
            width: 520,
            height: 600,
            frame: true,
            icon: this.getPlatformIcon('icon')
        })

        this.msftAuthWindow.on('closed', () => {
            this.msftAuthWindow = null
        })

        this.msftAuthWindow.removeMenu()
        return this.msftAuthWindow
    }

    createMicrosoftLogoutWindow(title) {
        this.msftLogoutWindow = new BrowserWindow({
            title: title,
            backgroundColor: '#222222',
            width: 520,
            height: 600,
            frame: true,
            icon: this.getPlatformIcon('icon')
        })

        this.msftLogoutWindow.on('closed', () => {
            this.msftLogoutWindow = null
        })

        this.msftLogoutWindow.removeMenu()
        return this.msftLogoutWindow
    }

    getPlatformIcon(filename) {
        let ext = process.platform === 'win32' ? 'ico' : 'png'
        return path.join(__dirname, '..', '..', 'app', 'assets', 'images', `${filename}.${ext}`)
    }

    setupMenu() {
        if (process.platform === 'darwin') {
            const template = [
                {
                    label: 'Application',
                    submenu: [
                        { label: 'About Application', selector: 'orderFrontStandardAboutPanel:' },
                        { type: 'separator' },
                        { label: 'Quit', accelerator: 'Command+Q', click: () => app.quit() }
                    ]
                },
                {
                    label: 'Edit',
                    submenu: [
                        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', selector: 'undo:' },
                        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', selector: 'redo:' },
                        { type: 'separator' },
                        { label: 'Cut', accelerator: 'CmdOrCtrl+X', selector: 'cut:' },
                        { label: 'Copy', accelerator: 'CmdOrCtrl+C', selector: 'copy:' },
                        { label: 'Paste', accelerator: 'CmdOrCtrl+V', selector: 'paste:' },
                        { label: 'Select All', accelerator: 'CmdOrCtrl+A', selector: 'selectAll:' }
                    ]
                }
            ]
            const menu = Menu.buildFromTemplate(template)
            Menu.setApplicationMenu(menu)
        }
    }
}

module.exports = new WindowManager()
