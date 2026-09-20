const { contextBridge, ipcRenderer } = require('electron')

// Global error handling for Renderer Process
window.onerror = (message, source, lineno, colno, error) => {
    const errorMsg = error ? (error.stack || error.message) : message
    ipcRenderer.send('renderer-error', errorMsg)
}

// Global Error Boundary - Enterprise Diagnostics
window.addEventListener('error', (event) => {
    console.error('[Renderer Fatal Error]', event.error);
    const overlay = document.getElementById('loadingContainer');
    if (overlay) {
        overlay.innerHTML = `
            <div style="color: #ff5555; background: rgba(0,0,0,0.8); padding: 20px; border: 1px solid #ff5555; border-radius: 5px; font-family: sans-serif; max-width: 80%;">
                <h3 style="margin-top:0">Ошибка инициализации</h3>
                <p style="font-size: 14px; word-break: break-all;">${event.error ? event.error.stack : event.message}</p>
                <button onclick="location.reload()" style="background: #ff5555; color: white; border: none; padding: 5px 15px; cursor: pointer; border-radius: 3px;">Перезапустить</button>
            </div>
        `;
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
    }
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('[Renderer Async Fatal Error]', event.reason);
    const errorMsg = event.reason ? (event.reason.stack || event.reason.message || event.reason.toString()) : 'Unhandled Promise Rejection'
    ipcRenderer.send('renderer-error', errorMsg)
});

// Forward console logs to Main Process
const originalConsoleLog = console.log
const originalConsoleError = console.error
const originalConsoleWarn = console.warn

console.log = (...args) => {
    try {
        const msg = args.map(a => {
            try {
                return typeof a === 'object' ? JSON.stringify(a) : String(a)
            } catch (e) { return '[Complex Object]' }
        }).join(' ')
        ipcRenderer.send('renderer-log', msg)
    } catch (e) { /* Log forwarding failed */ }
    originalConsoleLog.apply(console, args)
}
console.error = (...args) => {
    try {
        const msg = args.map(a => {
            try {
                return (a instanceof Error) ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : String(a))
            } catch (e) { return '[Complex Object]' }
        }).join(' ')
        ipcRenderer.send('renderer-error', msg)
    } catch (e) { /* Error logging failed */ }
    originalConsoleError.apply(console, args)
}
console.warn = (...args) => {
    try {
        const msg = args.map(a => {
            try {
                return typeof a === 'object' ? JSON.stringify(a) : String(a)
            } catch (e) { return '[Complex Object]' }
        }).join(' ')
        ipcRenderer.send('renderer-warn', msg)
    } catch (e) { /* Warn logging failed */ }
    originalConsoleWarn.apply(console, args)
}

window.onunhandledrejection = (event) => {
    const errorMsg = event.reason ? (event.reason.stack || event.reason.message || event.reason.toString()) : 'Unhandled Promise Rejection'
    ipcRenderer.send('renderer-error', errorMsg)
}

// Enterprise Bridge API
contextBridge.exposeInMainWorld('HeliosAPI', {
    // Window Controls
    window: {
        close: () => ipcRenderer.send('window-action', 'close'),
        minimize: () => ipcRenderer.send('window-action', 'minimize'),
        maximize: () => ipcRenderer.send('window-action', 'maximize'),
        unmaximize: () => ipcRenderer.send('window-action', 'unmaximize'),
        isMaximized: () => ipcRenderer.sendSync('window-action', 'isMaximized'),
        setProgressBar: (val) => ipcRenderer.send('window-action', 'setProgressBar', val),
        toggleDevTools: () => ipcRenderer.send('window-action', 'toggleDevTools')
    },
    // App Info
    app: {
        getVersion: () => ipcRenderer.sendSync('app:getVersionSync'),
        getAppPath: () => ipcRenderer.sendSync('app:getAppPath'),
        isDev: () => ipcRenderer.sendSync('app:isDev'),
        getName: () => 'FLauncher'
    },
    // App & Shell
    shell: {
        openExternal: (url) => ipcRenderer.send('app:open-url', url),
        openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
        trashItem: (path) => ipcRenderer.invoke('shell:trashItem', path),
        beep: () => ipcRenderer.send('shell:beep')
    },
    // Launcher Logic
    launcher: {
        launch: (options) => ipcRenderer.invoke('launcher:launch', options),
        showOpenDialog: (options) => ipcRenderer.invoke('launcher:showOpenDialog', options),
        onLog: (callback) => {
            const listener = (e, data) => callback(data)
            ipcRenderer.on('launcher:log', listener)
            return () => ipcRenderer.removeListener('launcher:log', listener)
        },
        onLogError: (callback) => {
            const listener = (e, data) => callback(data)
            ipcRenderer.on('launcher:log-error', listener)
            return () => ipcRenderer.removeListener('launcher:log-error', listener)
        },
        onExit: (callback) => {
            const listener = (e, code) => callback(code)
            ipcRenderer.on('launcher:exit', listener)
            return () => ipcRenderer.removeListener('launcher:exit', listener)
        },
        terminate: () => ipcRenderer.send('launcher:terminate')
    },
    // System & OS Info (Safe versions)
    system: {
        getPlatform: () => process.platform,
        getArch: () => process.arch,
        getVersions: () => process.versions,
        getVersion: () => process.version,
        cwd: () => ipcRenderer.sendSync('system:cwdSync'),
        getEnv: () => {
            return { ...(process.env || {}) }
        },
        getSystemInfo: () => ipcRenderer.sendSync('system:getSystemInfoSync')
    },
    // IPC Utility
    ipc: {
        invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
        send: (channel, ...args) => ipcRenderer.send(channel, ...args),
        sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
        on: (channel, callback) => ipcRenderer.on(channel, (event, ...args) => callback(event, ...args)),
        removeListener: (channel, callback) => ipcRenderer.removeListener(channel, callback)
    }
})

console.log('HeliosAPI Bridge Initialized')
