export const os = require('os')
export const semver = require('semver')
export const fs = require('fs').promises
export const sysPath = require('path')
const { ipcRenderer, shell } = require('electron')

export const DropinModUtil = require('@core/dropinmodutil')
const { Type } = require('@core/common/DistributionClasses')
const ConfigManager = require('@core/configmanager')
const DistroAPI = require('@core/distromanager')

const { MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR } = require('@core/ipcconstants')
var { ensureJavaDirIsRoot } = require('@core/java/JavaUtils')

export const settingsState = {
    invalid: new Set()
}

export function formatSpeed(bytesPerSec) {
    if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s'
    const k = 1024
    const sizes = ['KB/s', 'MB/s', 'GB/s']
    const i = Math.floor(Math.log(bytesPerSec) / Math.log(k)) - 1
    return parseFloat((bytesPerSec / Math.pow(k, i + 1)).toFixed(2)) + ' ' + sizes[i]
}

export function bindSettingsSelect() {
    for (let ele of document.getElementsByClassName('settingsSelectContainer')) {
        const selectedDiv = ele.getElementsByClassName('settingsSelectSelected')[0]

        if (selectedDiv) {
            selectedDiv.onclick = (e) => {
                e.stopPropagation()
                closeSettingsSelect(e.target)
                if (e.target.nextElementSibling) {
                    e.target.nextElementSibling.toggleAttribute('hidden')
                }
                e.target.classList.toggle('select-arrow-active')
            }
        }
    }
}

export function closeSettingsSelect(el) {
    for (let ele of document.getElementsByClassName('settingsSelectContainer')) {
        const selectedDiv = ele.getElementsByClassName('settingsSelectSelected')[0]
        const optionsDiv = ele.getElementsByClassName('settingsSelectOptions')[0]

        if (!(selectedDiv === el)) {
            selectedDiv.classList.remove('select-arrow-active')
            optionsDiv.setAttribute('hidden', '')
        }
    }
}

/* If the user clicks anywhere outside the select box,
then close all select boxes: */
document.addEventListener('click', closeSettingsSelect)

document.addEventListener('DOMContentLoaded', () => {
    bindSettingsSelect()
})


export function bindFileSelectors() {
    for (let ele of document.getElementsByClassName('settingsFileSelButton')) {

        ele.onclick = async e => {
            const isJavaExecSel = ele.id === 'settingsJavaExecSel'
            const directoryDialog = ele.hasAttribute('dialogDirectory') && ele.getAttribute('dialogDirectory') == 'true'
            const properties = directoryDialog ? ['openDirectory', 'createDirectory'] : ['openFile']

            const options = {
                properties
            }

            if (ele.hasAttribute('dialogTitle')) {
                options.title = ele.getAttribute('dialogTitle')
            }

            if (isJavaExecSel && process.platform === 'win32') {
                options.filters = [
                    { name: Lang.queryJS('settings.fileSelectors.executables'), extensions: ['exe'] },
                    { name: Lang.queryJS('settings.fileSelectors.allFiles'), extensions: ['*'] }
                ]
            }

            const res = await window.HeliosAPI.launcher.showOpenDialog(options)
            if (!res.canceled) {
                const selectedPath = res.filePaths[0]
                if (isJavaExecSel) {
                    const selectEl = document.getElementById('settingsJavaExecVal')
                    if (selectEl) {
                        let found = false
                        for (let i = 0; i < selectEl.options.length; i++) {
                            if (selectEl.options[i].value === selectedPath) {
                                found = true
                                break
                            }
                        }
                        if (!found) {
                            const opt = document.createElement('option')
                            opt.value = selectedPath
                            opt.textContent = `Custom: ${selectedPath}`
                            selectEl.appendChild(opt)
                        }
                        selectEl.value = selectedPath
                        selectEl.dispatchEvent(new Event('change'))
                    }
                } else {
                    ele.previousElementSibling.value = selectedPath
                }
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    bindFileSelectors()
})


/**
 * General Settings Functions
 */

/**
  * Bind value validators to the settings UI elements. These will
  * validate against the criteria defined in the ConfigManager (if
  * any). If the value is invalid, the UI will reflect this and saving
  * will be disabled until the value is corrected. This is an automated
  * process. More complex UI may need to be bound separately.
  */
export function initSettingsValidators() {
    const sEls = document.getElementById('settingsContainer').querySelectorAll('[cValue]')
    Array.from(sEls).map((v, index, arr) => {
        const vFn = ConfigManager['validate' + v.getAttribute('cValue')]
        if (typeof vFn === 'function') {
            if (v.tagName === 'INPUT') {
                if (v.type === 'number' || v.type === 'text') {
                    v.addEventListener('keyup', (e) => {
                        const v = e.target
                        if (!vFn(v.value)) {
                            settingsState.invalid.add(v.id)
                            v.setAttribute('error', '')
                            settingsSaveDisabled(true)
                        } else {
                            if (v.hasAttribute('error')) {
                                v.removeAttribute('error')
                                settingsState.invalid.delete(v.id)
                                if (settingsState.invalid.size === 0) {
                                    settingsSaveDisabled(false)
                                }
                            }
                        }
                    })
                }
            }
        }

    })
}

/**
 * Load configuration values onto the UI. This is an automated process.
 */
async function initSettingsValues() {
    const sEls = document.getElementById('settingsContainer').querySelectorAll('[cValue]')

    for (const v of sEls) {
        const cVal = v.getAttribute('cValue')
        const serverDependent = v.hasAttribute('serverDependent') // Means the first argument is the server id.
        const gFn = ConfigManager['get' + cVal]
        const gFnOpts = []
        if (serverDependent) {
            gFnOpts.push(ConfigManager.getSelectedServer())
        }
        if (typeof gFn === 'function') {
            if (v.tagName === 'INPUT') {
                if (v.type === 'number' || v.type === 'text') {
                    // Special Conditions
                    let rawVal = gFn.apply(null, gFnOpts)
                    let safeVal = (rawVal === 'null' || rawVal === 'undefined' || rawVal == null) ? '' : rawVal;

                    if (cVal === 'JavaExecutable') {
                        v.value = safeVal
                        // Instead of populating details directly, we will let prepareJavaTab handle it with dropdown
                    } else if (cVal === 'DataDirectory') {
                        v.value = safeVal
                    } else if (cVal === 'JVMOptions') {
                        const opts = rawVal
                        v.value = Array.isArray(opts) ? opts.join(' ') : (typeof opts === 'string' ? (opts === 'null' ? '' : opts) : '')
                    } else {
                        v.value = safeVal
                    }
                } else if (v.type === 'checkbox') {
                    v.checked = gFn.apply(null, gFnOpts)
                }
            } else if (v.tagName === 'DIV') {
                if (v.classList.contains('rangeSlider')) {
                    // Special Conditions
                    if (cVal === 'MinRAM' || cVal === 'MaxRAM') {
                        let val = gFn.apply(null, gFnOpts)
                        if (val.endsWith('M')) {
                            val = Number(val.substring(0, val.length - 1)) / 1024
                        } else {
                            val = Number.parseFloat(val)
                        }

                        v.setAttribute('value', val)
                    } else if (cVal === 'P2PUploadLimit') {
                        const val = gFn.apply(null, gFnOpts)
                        v.setAttribute('value', val)
                        document.getElementById('settingsP2PUploadLabel').innerHTML = val + ' Mbit/s'
                    } else {
                        v.setAttribute('value', Number.parseFloat(gFn.apply(null, gFnOpts)))
                    }
                }
            }
        }
    }

    // Update P2P Profile Label
    try {
        /** @type {any} */
        const p2pInfo = await ipcRenderer.invoke('p2p:getInfo')
        const profileEl = document.getElementById('settingsP2PProfileLabel')
        if (profileEl && p2pInfo && p2pInfo.profile) {
            const profiles = {
                'LOW': 'Экономный (Пассивный)',
                'MID': 'Сбалансированный',
                'HIGH': 'Высокопроизводительный'
            }
            profileEl.textContent = profiles[p2pInfo.profile] || p2pInfo.profile
        }
    } catch (e) { /* ignore */ }
}

export function bindP2PSlider() {
    const slider = document.getElementById('settingsP2PUploadRange')
    const label = document.getElementById('settingsP2PUploadLabel')

    if (!slider || !label) return

    // Observer for value change
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'value') {
                label.textContent = slider.getAttribute('value') + ' Mbit/s'
            }
        })
    })
    observer.observe(slider, { attributes: true })
}
document.addEventListener('DOMContentLoaded', () => {
    bindP2PSlider()
})


export const getP2PStatsMarkup = (info) => {
    const spinner = '<span class="p2p-status-spinner"></span>'
    let statusText = 'Отключен'
    let statusColor = '#ff4444'
    if (info.listening && ConfigManager.getLocalOptimization()) {
        if (ConfigManager.getP2PUploadEnabled()) {
            statusText = 'Активен'
            statusColor = '#7dbb00'
        } else {
            statusText = 'Активен (Только скачивание)'
            statusColor = '#ffbb00'
        }
    }



    let globalStatusText = 'Отключен'
    let globalStatusColor = '#ff4444'
    if (info.running) {
        globalStatusText = 'Активен'
        globalStatusColor = '#7dbb00'
        if (info.mode && info.mode.includes('Passive')) {
            globalStatusText = 'Активен (Режим экономии)'
            globalStatusColor = '#ffbb00'
        }
    }

    return `
        <style>
            @keyframes p2p-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .p2p-stats-wrapper {
                display: flex;
                gap: 15px;
                background: rgba(20, 20, 20, 0.85);
                padding: 20px;
                border-radius: 18px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                box-shadow: 0 12px 45px rgba(0,0,0,0.45);
                width: 100%;
                max-width: 740px;
                max-height: 65vh;
                overflow-y: auto;
                overflow-x: hidden;
                box-sizing: border-box;
                font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            }
            .p2p-stats-wrapper::-webkit-scrollbar {
                width: 4px;
            }
            .p2p-stats-wrapper::-webkit-scrollbar-track {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 10px;
            }
            .p2p-stats-wrapper::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.2);
                border-radius: 10px;
            }
            .p2p-column {
                flex: 1;
                display: flex;
                flex-direction: column;
                gap: 8px;
                min-width: 280px;
            }
            .p2p-divider {
                width: 1px;
                background: linear-gradient(to bottom, transparent, rgba(255,255,255,0.12), transparent);
                flex-shrink: 0;
            }
            .p2p-title {
                font-size: 11px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 1.5px;
                color: #888;
                margin-bottom: 2px;
            }
            .p2p-data-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 0;
                border-bottom: 1px solid rgba(255,255,255,0.05);
            }
            .p2p-data-label {
                font-size: 13.5px;
                color: #aaa;
            }
            .p2p-data-value {
                font-size: 14.5px;
                font-weight: 600;
                color: #fff;
                display: flex;
                align-items: center;
            }
            .p2p-status-spinner {
                display: inline-block;
                width: 12px;
                height: 12px;
                border: 2px solid rgba(255,255,255,0.1);
                border-top: 2px solid #7dbb00;
                border-radius: 50%;
                animation: p2p-spin 1s linear infinite;
                margin-left: 8px;
            }
            .p2p-topic-tag {
                font-family: monospace;
                background: rgba(255,255,255,0.05);
                padding: 2px 6px;
                border-radius: 4px;
                color: #999;
            }
        </style>
        <div id="p2pInfoStats" class="p2p-stats-wrapper">
            <div class="p2p-column">
                <div class="p2p-title">Локальная сеть (LAN)</div>
                <div class="p2p-data-row">
                    <span class="p2p-data-label">Статус</span>
                    <span id="p2p-local-status" class="p2p-data-value" style="color: ${statusColor}">
                        ${statusText} ${info.listening ? spinner : ''}
                    </span>
                </div>
                <div class="p2p-data-row">
                    <span class="p2p-data-label">Локальные пиры</span>
                    <span id="p2p-local-peers" class="p2p-data-value">${info.localPeers || 0}</span>
                </div>
                <div class="p2p-data-row">
                    <span class="p2p-data-label">Скорость (Загр/Отд)</span>
                    <span class="p2p-data-value">
                        <span id="p2p-local-dl-speed" style="color: #7dbb00;">${formatSpeed(info.downloadSpeedLocal || 0)}</span>
                        <span style="margin: 0 4px; color: #444;">/</span>
                        <span id="p2p-local-ul-speed" style="color: #0088ff;">${formatSpeed(info.uploadSpeedLocal || 0)}</span>
                    </span>
                </div>
                <div class="p2p-data-row">
                    <span class="p2p-data-label">Отдано</span>
                    <span id="p2p-local-uploaded" class="p2p-data-value">${((info.uploadedLocal || 0) / 1024 / 1024).toFixed(2)} MB</span>
                </div>
                <div class="p2p-data-row">
                    <span class="p2p-data-label">Принято</span>
                    <span id="p2p-local-downloaded" class="p2p-data-value">${((info.downloadedLocal || 0) / 1024 / 1024).toFixed(2)} MB</span>
                </div>
            </div>

            <div class="p2p-divider"></div>

            <div id="p2p-global-container" class="p2p-column">
                <div class="p2p-title">Глобальная сеть (WAN)</div>
                <div class="p2p-data-row">
                    <span class="p2p-data-label">Статус</span>
                    <span id="p2p-global-status" class="p2p-data-value" style="color: ${globalStatusColor}">
                        ${globalStatusText} ${info.running ? spinner : ''}
                    </span>
                </div>
                
                <div id="p2p-global-details" style="display: ${info.running ? 'block' : 'none'}">
                    <div class="p2p-data-row">
                        <span class="p2p-data-label">Топик</span>
                        <span class="p2p-data-value"><span id="p2p-global-topic" class="p2p-topic-tag">${info.topic}</span></span>
                    </div>
                    <div class="p2p-data-row">
                        <span class="p2p-data-label">DHT Узлы</span>
                        <span id="p2p-global-dht" class="p2p-data-value" style="color: ${info.dhtNodes > 0 ? '#7dbb00' : '#ff4444'}">
                            ${info.dhtNodes || 0} <span style="color: ${info.bootstrapped ? '#7dbb00' : '#666'}; margin-left: 4px; font-weight: normal;">(${info.bootstrapNodes})</span>
                        </span>
                    </div>
                    <div class="p2p-data-row">
                        <span class="p2p-data-label">Глобальные пиры</span>
                        <span id="p2p-global-peers" class="p2p-data-value">${info.globalPeers || 0}</span>
                    </div>
                    <div class="p2p-data-row">
                        <span class="p2p-data-label">Скорость (Загр/Отд)</span>
                        <span class="p2p-data-value">
                            <span id="p2p-global-dl-speed" style="color: #7dbb00;">${formatSpeed(info.downloadSpeed || 0)}</span>
                            <span style="margin: 0 4px; color: #444;">/</span>
                            <span id="p2p-global-ul-speed" style="color: #0088ff;">${formatSpeed(info.uploadSpeed || 0)}</span>
                        </span>
                    </div>
                    <div class="p2p-data-row">
                        <span class="p2p-data-label">Активные сессии</span>
                        <span id="p2p-global-sessions" class="p2p-data-value">
                            ${info.uploads} <span style="color: #666; font-size: 11px; margin-left: 4px;">(Upload)</span>
                            ${info.uploads > 0 ? spinner : ''}
                        </span>
                    </div>
                    <div class="p2p-data-row">
                        <span class="p2p-data-label">Сетевой статус</span>
                        <span id="p2p-global-mode" class="p2p-data-value" style="color: ${info.mode && info.mode.includes('Active') ? '#7dbb00' : '#ffbb00'}">
                            ${info.mode && info.mode.includes('Active') ? 'Активный (Полный)' : 'Ограниченный (Загрузка)'}
                        </span>
                    </div>
                    <div class="p2p-data-row">
                        <span class="p2p-data-label">Отдано</span>
                        <span id="p2p-global-uploaded" class="p2p-data-value">${((info.uploadedGlobal || 0) / 1024 / 1024).toFixed(2)} MB</span>
                    </div>
                    <div class="p2p-data-row">
                        <span class="p2p-data-label">Принято</span>
                        <span id="p2p-global-downloaded" class="p2p-data-value">${((info.downloadedGlobal || 0) / 1024 / 1024).toFixed(2)} MB</span>
                    </div>
                </div>
                <div id="p2p-global-disabled" style="display: ${info.running ? 'none' : 'flex'}; flex: 1; align-items: center; justify-content: center; color: #555; font-style: italic; font-size: 13px; text-align: center;">
                    Глобальная оптимизация<br>отключена в настройках
                </div>
            </div>
        </div>
    `
}

export const updateP2PStatsUI = (info) => {
    const el = id => document.getElementById(id)
    if (!el('p2pInfoStats')) return false

    const spinner = '<span class="p2p-status-spinner"></span>'

    // Local
    let statusText = 'Отключен', statusColor = '#ff4444'
    if (info.listening && ConfigManager.getLocalOptimization()) {
        if (ConfigManager.getP2PUploadEnabled()) {
            statusText = 'Активен', statusColor = '#7dbb00'
        } else {
            statusText = 'Активен (Только скачивание)', statusColor = '#ffbb00'
        }
    }
    const lStatus = el('p2p-local-status')
    if (lStatus) {
        lStatus.innerHTML = `${statusText} ${info.listening ? spinner : ''}`
        lStatus.style.color = statusColor
    }
    if (el('p2p-local-peers')) el('p2p-local-peers').innerText = info.localPeers || 0
    if (el('p2p-local-dl-speed')) el('p2p-local-dl-speed').innerText = formatSpeed(info.downloadSpeedLocal || 0)
    if (el('p2p-local-ul-speed')) el('p2p-local-ul-speed').innerText = formatSpeed(info.uploadSpeedLocal || 0)
    if (el('p2p-local-uploaded')) el('p2p-local-uploaded').innerText = `${((info.uploadedLocal || 0) / 1024 / 1024).toFixed(2)} MB`
    if (el('p2p-local-downloaded')) el('p2p-local-downloaded').innerText = `${((info.downloadedLocal || 0) / 1024 / 1024).toFixed(2)} MB`

    // Global
    let globalStatusText = 'Отключен', globalStatusColor = '#ff4444'
    if (info.running) {
        globalStatusText = 'Активен', globalStatusColor = '#7dbb00'
        if (info.mode && info.mode.includes('Passive')) {
            globalStatusText = 'Активен (Режим экономии)', globalStatusColor = '#ffbb00'
        }
    }
    const gStatus = el('p2p-global-status')
    if (gStatus) {
        gStatus.innerHTML = `${globalStatusText} ${info.running ? spinner : ''}`
        gStatus.style.color = globalStatusColor
    }

    const details = el('p2p-global-details')
    const disabled = el('p2p-global-disabled')
    if (details && disabled) {
        details.style.display = info.running ? 'block' : 'none'
        disabled.style.display = info.running ? 'none' : 'flex'
    }



    if (info.running) {
        if (el('p2p-global-topic')) el('p2p-global-topic').innerText = info.topic
        if (el('p2p-global-dl-speed')) el('p2p-global-dl-speed').innerText = formatSpeed(info.downloadSpeed || 0)
        if (el('p2p-global-ul-speed')) el('p2p-global-ul-speed').innerText = formatSpeed(info.uploadSpeed || 0)
        const gDht = el('p2p-global-dht')
        if (gDht) {
            gDht.innerHTML = `${info.dhtNodes || 0} <span style="color: ${info.bootstrapped ? '#7dbb00' : '#666'}; margin-left: 4px; font-weight: normal;">(${info.bootstrapNodes})</span>`
            gDht.style.color = info.dhtNodes > 0 ? '#7dbb00' : '#ff4444'
        }
        if (el('p2p-global-peers')) el('p2p-global-peers').innerText = info.globalPeers || 0
        const gSessions = el('p2p-global-sessions')
        if (gSessions) {
            gSessions.innerHTML = `${info.uploads} <span style="color: #666; font-size: 11px; margin-left: 4px;">(Upload)</span> ${info.uploads > 0 ? spinner : ''}`
        }
        const gMode = el('p2p-global-mode')
        if (gMode) {
            gMode.innerText = info.mode && info.mode.includes('Active') ? 'Активный (Полный)' : 'Ограниченный (Загрузка)'
            gMode.style.color = info.mode && info.mode.includes('Active') ? '#7dbb00' : '#ffbb00'
        }
        if (el('p2p-global-uploaded')) el('p2p-global-uploaded').innerText = `${((info.uploadedGlobal || 0) / 1024 / 1024).toFixed(2)} MB`
        if (el('p2p-global-downloaded')) el('p2p-global-downloaded').innerText = `${((info.downloadedGlobal || 0) / 1024 / 1024).toFixed(2)} MB`
    }
    return true
}

// Bind P2P Info Button
export function bindP2PInfoButton() {
    const p2pInfoBtn = document.getElementById('settingsP2PInfoButton')
    if (p2pInfoBtn) {
        // Clone to remove existing listeners if any, then re-add
        const newBtn = p2pInfoBtn.cloneNode(true)
        p2pInfoBtn.parentNode.replaceChild(newBtn, p2pInfoBtn)

        newBtn.onclick = async () => {
            let intervalId = null
            try {
                // Initial fetch
                let info = {
                    connected: false,
                    connections: 0,
                    downloaded: 0,
                    uploaded: 0,
                    downloadSpeed: 0,
                    uploadSpeed: 0,
                    mode: 'Unknown'
                }

                try {
                    info = await ipcRenderer.invoke('p2p:getInfo')
                } catch (e) {
                    console.error('Failed to get initial P2P info', e)
                }

                const closeOverlay = () => {
                    if (intervalId) clearInterval(intervalId)
                    toggleOverlay(false)
                }

                setOverlayContent(
                    'Статистика P2P Сети',
                    '',
                    'Закрыть'
                )
                document.getElementById('overlayDesc').innerHTML = getP2PStatsMarkup(info)

                setOverlayHandler(closeOverlay)
                setDismissHandler(closeOverlay)

                // Button handler for 'Update' (Middle button) if we wanted one, 
                // but here we used 'Закрыть' as the primary action.
                // The overlay function signature is (title, html, dismissText, [confirmText])
                // We'll just rely on the interval for updates.

                toggleOverlay(true)

                // Update loop
                intervalId = setInterval(async () => {
                    // Check if overlay is still open
                    if (!document.getElementById('p2pInfoStats') || !isOverlayVisible()) {
                        clearInterval(intervalId)
                        return
                    }
                    try {
                        /** @type {any} */
                        const newInfo = await ipcRenderer.invoke('p2p:getInfo')
                        updateP2PStatsUI(newInfo)
                    } catch (e) {
                        console.error('Failed to update P2P stats', e)
                    }
                }, 1000)

            } catch (err) {
                console.error('Info Error', err)
                setOverlayContent('Ошибка', 'Не удалось загрузить статистику P2P.', 'Закрыть')
                setOverlayHandler(() => toggleOverlay(false))
                toggleOverlay(true)
            }
        }
    } else {
        console.error('bindP2PInfoButton: Button not found!')
    }
}

/**
 * Bind the P2P statistics button to open the global stats overlay.
 */
function bindP2PStatsButton() {
    const btn = document.getElementById('settingsP2PStatsButton')
    if (btn) {
        if (btn.hasAttribute('bound')) return
        btn.setAttribute('bound', 'true')

        btn.addEventListener('click', async () => {
            console.log('[Settings] P2P Stats button clicked')
            try {
                // 10s timeout for IPC
                const statsPromise = ipcRenderer.invoke('p2p:getStats')
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('IPC Timeout')), 10000))

                const stats = await Promise.race([statsPromise, timeoutPromise])
                console.log('[Settings] Stats received:', stats)

                setOverlayContent(
                    'Общая статистика P2P',
                    '',
                    'Закрыть'
                )

                document.getElementById('overlayDesc').innerHTML = getP2PGlobalStatsMarkup(stats)

                const filter = document.getElementById('p2pStatsFilter')
                if (filter) {
                    filter.onchange = (e) => {
                        const period = e.target.value
                        document.getElementById('p2pStatsContent').innerHTML = getP2PStatsPeriodContent(stats, period)
                    }
                }

                setOverlayHandler(() => toggleOverlay(false))
                setDismissHandler(() => toggleOverlay(false))
                toggleOverlay(true)

            } catch (err) {
                console.error('[Settings] Failed to load P2P stats:', err)
                setOverlayContent('Ошибка', 'Не удалось загрузить статистику P2P: ' + err.message, 'Закрыть')
                setOverlayHandler(() => toggleOverlay(false))
                toggleOverlay(true)
            }
        })
    }
}

function getP2PGlobalStatsMarkup(stats) {
    return `
        <div id="p2pGlobalStats" style="text-align: left; padding: 10px;">
            <div style="margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;">
                <span style="color: #ccc;">Период статистики:</span>
                <select id="p2pStatsFilter" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; padding: 5px; border-radius: 4px;">
                    <option value="all" style="background: #2a2a2a; color: white;">За все время</option>
                    <option value="month" style="background: #2a2a2a; color: white;">За месяц</option>
                    <option value="week" style="background: #2a2a2a; color: white;">За неделю</option>
                </select>
            </div>
            <div id="p2pStatsContent">
                ${getP2PStatsPeriodContent(stats, 'all')}
            </div>
        </div>
    `
}

function getP2PStatsPeriodContent(stats, period) {
    const data = stats[period] || { up: 0, down: 0 }

    // Calculate total as a sum if it's not present (should be present but for safety)
    const up = data.up || 0
    const down = data.down || 0

    return `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 10px;">
            <div style="background: rgba(0,0,0,0.3); padding: 15px; border-radius: 8px; border-left: 4px solid #7dbb00;">
                <div style="font-size: 12px; color: #888; margin-bottom: 5px;">ОТДАНО ВСЕГО</div>
                <div style="font-size: 24px; font-weight: bold; color: #7dbb00;">${(up / 1073741824).toFixed(2)} GB</div>
            </div>
            <div style="background: rgba(0,0,0,0.3); padding: 15px; border-radius: 8px; border-left: 4px solid #00aaff;">
                <div style="font-size: 12px; color: #888; margin-bottom: 5px;">ПОЛУЧЕНО ВСЕГО</div>
                <div style="font-size: 24px; font-weight: bold; color: #00aaff;">${(down / 1073741824).toFixed(2)} GB</div>
            </div>
        </div>
        <div style="margin-top: 20px; font-size: 12px; color: #666; text-align: center;">
            Статистика обновляется каждые 2 секунды во время активной сессии.
        </div>
    `
}

/**
 * Save the settings values.
 */
async function saveSettingsValues() {
    const sEls = document.getElementById('settingsContainer').querySelectorAll('[cValue]')
    Array.from(sEls).map((v, index, arr) => {
        const cVal = v.getAttribute('cValue')
        const serverDependent = v.hasAttribute('serverDependent') // Means the first argument is the server id.
        const sFn = ConfigManager['set' + cVal]
        const sFnOpts = []
        if (serverDependent) {
            sFnOpts.push(ConfigManager.getSelectedServer())
        }
        if (typeof sFn === 'function') {
            if (v.tagName === 'INPUT') {
                if (v.type === 'number' || v.type === 'text') {
                    // Special Conditions
                    if (cVal === 'JVMOptions') {
                        if (!v.value.trim()) {
                            sFnOpts.push([])
                            sFn.apply(null, sFnOpts)
                        } else {
                            const opts = v.value.trim().split(/\s+/)
                            // Simple validation: check if options start with -
                            const invalid = opts.filter(o => !o.startsWith('-'))
                            if (invalid.length > 0) {
                                console.warn('Invalid JVM options detected:', invalid)
                            }
                            sFnOpts.push(opts)
                            sFn.apply(null, sFnOpts)
                        }
                    } else {
                        sFnOpts.push(v.value)
                        sFn.apply(null, sFnOpts)
                    }
                } else if (v.type === 'checkbox') {
                    sFnOpts.push(v.checked)
                    sFn.apply(null, sFnOpts)
                    // Special Conditions
                    if (cVal === 'AllowPrerelease') {
                        changeAllowPrerelease(v.checked)
                    }
                }
            } else if (v.tagName === 'DIV') {
                if (v.classList.contains('rangeSlider')) {
                    // Special Conditions
                    if (cVal === 'MinRAM' || cVal === 'MaxRAM') {
                        let val = Number(v.getAttribute('value'))
                        if (val % 1 > 0) {
                            val = val * 1024 + 'M'
                        } else {
                            val = val + 'G'
                        }

                        sFnOpts.push(val)
                        sFn.apply(null, sFnOpts)
                    } else {
                        sFnOpts.push(v.getAttribute('value'))
                        sFn.apply(null, sFnOpts)
                    }
                }
            }
        }
    })

    try {
        await ConfigManager.save()
    } catch (err) {
        console.error('Failed to save settings:', err)
        if (err.message && (err.message.includes('ENOSPC') || err.message.includes('no space left'))) {
            setOverlayContent(
                'Ошибка сохранения',
                'Не удалось сохранить настройки: на диске недостаточно места.',
                'Понятно'
            )
            setOverlayHandler(() => toggleOverlay(false))
            toggleOverlay(true)
            return
        }
    }

    // Track important setting changes
    if (typeof Analytics !== 'undefined') {
        const javaConfig = ConfigManager.getJavaConfig()
        Analytics.capture('Settings Changed', {
            java_max_ram: javaConfig.maxRAM,
            p2p_enabled: ConfigManager.getP2PUploadEnabled(),
            p2p_limit: ConfigManager.getP2PUploadLimit()
        })
    }

    // Apply P2P Settings immediately


    // Notify Main Process to update P2P Engine
    await ipcRenderer.invoke('p2p:configUpdate')
}

export let selectedSettingsTab = 'settingsTabAccount'

async function populateMirrorStatus(refresh = false) {
    console.log('[Settings] populateMirrorStatus called (refresh:', refresh, ')')
    const container = document.getElementById('settingsMirrorStatusContainer')
    if (!container) return

    const btn = document.getElementById('settingsMirrorStatusRefresh')
    if (refresh && btn) btn.classList.add('spinning')

    if (refresh) {
        container.innerHTML = '<div style="text-align: center; color: #aaa; padding: 10px;">Обновление статуса...</div>'
    }

    try {
        /** @type {any[]} */
        const mirrors = await ipcRenderer.invoke(refresh ? 'mirrors:refresh' : 'mirrors:getStatus')
        console.log('[Settings] Mirror status received:', mirrors)
        if (!mirrors || mirrors.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #888; padding: 10px;">Зеркала не настроены или отключены.</div>'
            return
        }

        let html = ''
        mirrors.forEach(m => {
            let statusColor = '#888'
            let statusText = 'Неизвестно'
            if (m.status === 'active') { statusColor = '#7dbb00'; statusText = 'Активно' }
            else if (m.status === 'slow') { statusColor = '#ffbb00'; statusText = 'Медленно' }
            else if (m.status === 'down') { statusColor = '#ff4444'; statusText = 'Недоступно' }
            else if (m.status === 'invalid') { statusColor = '#ff4444'; statusText = 'Ошибка конф.' }

            html += `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                <div style="font-weight: 600; color: #eee;">${m.name}</div>
                <div style="display: flex; gap: 15px; align-items: center;">
                    <span style="color: #aaa; font-size: 13px;">${m.latency >= 0 && m.latency < 9999 ? m.latency + ' ms' : '--'}</span>
                    <span style="color: ${statusColor}; font-size: 13px; font-weight: bold;">${statusText}</span>
                </div>
            </div>`
        })
        container.innerHTML = html
    } catch (e) {
        console.error('Failed to load mirror status', e)
        container.innerHTML = '<div style="text-align: center; color: #ff4444; padding: 10px;">Ошибка загрузки статуса зеркал.</div>'
    } finally {
        if (refresh && btn) btn.classList.remove('spinning')
    }
}

async function populateBootstrapStatus(refresh = false) {
    console.log('[Settings] populateBootstrapStatus called (refresh:', refresh, ')')
    const container = document.getElementById('settingsBootstrapStatusContainer')
    if (!container) return

    const btn = document.getElementById('settingsBootstrapStatusRefresh')
    if (refresh && btn) btn.classList.add('spinning')

    try {
        /** @type {any[]} */
        const nodes = await ipcRenderer.invoke('p2p:getBootstrapStatus')
        console.log('[Settings] Bootstrap status received:', nodes)
        if (!nodes || nodes.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #888; padding: 10px;">Bootstrap узлы не найдены.</div>'
            return
        }

        let html = ''
        nodes.forEach(n => {
            let statusColor
            let statusText
            let latencyText = '--'

            if (n.status === 'online') {
                statusColor = '#7dbb00' // Green
                statusText = 'Онлайн'
                latencyText = n.latency + ' ms'
            } else if (n.status === 'timeout') {
                statusColor = '#ffbb00' // Orange/Yellow
                statusText = 'Тайм-аут'
            } else {
                statusColor = '#ff4444' // Red
                statusText = 'Ошибка'
                if (n.error) latencyText = n.error
            }

            const nodeName = n.isPrivate ? `Приватный узел #${n.index + 1}` : `Публичный узел #${n.index + 1}`

            html += `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                <div style="font-weight: 600; color: #eee; font-family: monospace;">${nodeName}</div>
                <div style="display: flex; gap: 15px; align-items: center;">
                    <span style="color: #aaa; font-size: 13px;">${latencyText}</span>
                    <span style="color: ${statusColor}; font-size: 13px; font-weight: bold;">${statusText}</span>
                </div>
            </div>`
        })
        container.innerHTML = html
    } catch (e) {
        console.error('Failed to load bootstrap status', e)
        container.innerHTML = '<div style="text-align: center; color: #ff4444; padding: 10px;">Ошибка загрузки статуса Bootstrap узлов.</div>'
    } finally {
        if (refresh && btn) btn.classList.remove('spinning')
    }
}

async function updateConnectivityStatus(refresh = false) {
    console.log('[Settings] updateConnectivityStatus called (refresh:', refresh, ')')
    const btn = document.getElementById('settingsConnectivityRefresh')
    if (refresh && btn) btn.classList.add('spinning')

    try {
        const res = await ipcRenderer.invoke('connectivity:check')
        console.log(`Connectivity check results: ${JSON.stringify(res)}`);
        const ghInd = document.getElementById('deliveryIndicatorGitHub')
        const ghStat = document.getElementById('deliveryStatusGitHub')
        const mjInd = document.getElementById('deliveryIndicatorMojang')
        const mjStat = document.getElementById('deliveryStatusMojang')

        if (ghInd && ghStat) {
            ghInd.style.background = res.github ? '#7dbb00' : '#ff4444'
            ghStat.innerHTML = res.github ? 'Онлайн' : 'Оффлайн'
            ghStat.style.color = res.github ? '#7dbb00' : '#ff4444'
        }
        if (mjInd && mjStat) {
            mjInd.style.background = res.mojang ? '#7dbb00' : '#ff4444'
            mjStat.innerHTML = res.mojang ? 'Онлайн' : 'Оффлайн'
            mjStat.style.color = res.mojang ? '#7dbb00' : '#ff4444'
        }
    } catch (e) {
        console.error('Connectivity check failed', e)
    } finally {
        if (refresh && btn) btn.classList.remove('spinning')
    }
}

export function bindRefreshButtons() {
    console.log('[Settings] Binding refresh buttons...')
    const mirrorBtn = document.getElementById('settingsMirrorStatusRefresh')
    if (mirrorBtn) {
        mirrorBtn.onclick = () => {
            console.log('[Settings] Mirror refresh clicked')
            populateMirrorStatus(true)
        }
    }
    const bootstrapBtn = document.getElementById('settingsBootstrapStatusRefresh')
    if (bootstrapBtn) {
        bootstrapBtn.onclick = () => {
            console.log('[Settings] Bootstrap refresh clicked')
            populateBootstrapStatus(true)
        }
    }
    const connectivityBtn = document.getElementById('settingsConnectivityRefresh')
    if (connectivityBtn) {
        connectivityBtn.onclick = () => {
            console.log('[Settings] Connectivity refresh clicked')
            updateConnectivityStatus(true)
        }
    }
}

/**
 * Modify the settings container UI when the scroll threshold reaches
 * a certain poin.
 *
 * @param {UIEvent} e The scroll event.
 */
export function settingsTabScrollListener(e) {
    if (e.target.scrollTop > Number.parseFloat(getComputedStyle(e.target.firstElementChild).marginTop)) {
        document.getElementById('settingsContainer').setAttribute('scrolled', '')
    } else {
        document.getElementById('settingsContainer').removeAttribute('scrolled')
    }
}

/**
 * Bind functionality for the settings navigation items.
 */
export function setupSettingsTabs() {
    Array.from(document.getElementsByClassName('settingsNavItem')).map((val) => {
        if (val.hasAttribute('rSc')) {
            val.onclick = () => {
                settingsNavItemListener(val)
            }
        }
    })
}

/**
 * Settings nav item onclick lisener. Function is exposed so that
 * other UI elements can quickly toggle to a certain tab from other views.
 *
 * @param {Element} ele The nav item which has been clicked.
 * @param {boolean} fade Optional. True to fade transition.
 */
export function settingsNavItemListener(ele, fade = true) {
    const nextTab = ele.getAttribute('rSc')
    if (ele.hasAttribute('selected')) {
        // If already selected, just ensure it's visible.
        const tab = document.getElementById(nextTab)
        if (tab && (tab.style.display === 'none' || getComputedStyle(tab).display === 'none')) {
            if (fade) {
                fadeIn(tab, 250, () => {
                    settingsTabScrollListener({ target: tab })
                })
            } else {
                show(tab)
                settingsTabScrollListener({ target: tab })
            }
        }
        return
    }
    const navItems = document.getElementsByClassName('settingsNavItem')
    for (let i = 0; i < navItems.length; i++) {
        if (navItems[i].hasAttribute('selected')) {
            navItems[i].removeAttribute('selected')
        }
    }
    ele.setAttribute('selected', '')
    let prevTab = selectedSettingsTab
    selectedSettingsTab = nextTab

    if (selectedSettingsTab === 'settingsTabDelivery') {
        populateMirrorStatus()
        populateBootstrapStatus()
        updateConnectivityStatus()
    } else if (selectedSettingsTab === 'settingsTabAccount') {
        prepareAccountsTab()
    }

    if (prevTab && document.getElementById(prevTab)) {
        document.getElementById(prevTab).onscroll = null
    }
    document.getElementById(selectedSettingsTab).onscroll = settingsTabScrollListener

    if (fade) {
        if (prevTab && document.getElementById(prevTab)) {
            fadeOut(document.getElementById(prevTab), 250, () => {
                fadeIn(document.getElementById(selectedSettingsTab), 250, () => {
                    settingsTabScrollListener({
                        target: document.getElementById(selectedSettingsTab)
                    })
                })
            })
        } else {
            fadeIn(document.getElementById(selectedSettingsTab), 250, () => {
                settingsTabScrollListener({
                    target: document.getElementById(selectedSettingsTab)
                })
            })
        }
    } else {
        if (prevTab && document.getElementById(prevTab)) {
            hide(document.getElementById(prevTab))
        }
        show(document.getElementById(selectedSettingsTab))
        settingsTabScrollListener({
            target: document.getElementById(selectedSettingsTab)
        })
    }
}

export const settingsNavDone = document.getElementById('settingsNavDone')

/**
 * Set if the settings save (done) button is disabled.
 *
 * @param {boolean} v True to disable, false to enable.
 */
export function settingsSaveDisabled(v) {
    settingsNavDone.disabled = v
}

export async function fullSettingsSave() {
    await saveSettingsValues()
    saveModConfiguration()
    await ConfigManager.save()
    await saveDropinModConfiguration()
    await saveShaderpackSettings()
    await ipcRenderer.invoke('p2p:configUpdate')
}

/* Closes the settings view and saves all data. */
settingsNavDone.onclick = async () => {
    await fullSettingsSave()
    switchView(getCurrentView(), VIEWS.landing)
}

/**
 * Account Management Tab
 */

export const msftLoginLogger = LoggerUtil.getLogger('Microsoft Login')
export const msftLogoutLogger = LoggerUtil.getLogger('Microsoft Logout')

// Bind the add mojang account button.
document.getElementById('settingsAddMojangAccount').onclick = (e) => {
    switchView(getCurrentView(), VIEWS.login, 500, 500, () => {
        loginViewOnCancel = VIEWS.settings
        loginViewOnSuccess = VIEWS.settings
        loginCancelEnabled(true)
    })
}

// Bind the add microsoft account button.
document.getElementById('settingsAddMicrosoftAccount').onclick = (e) => {
    switchView(getCurrentView(), VIEWS.waiting, 500, 500, () => {
        ipcRenderer.send(MSFT_OPCODE.OPEN_LOGIN, VIEWS.settings, VIEWS.settings)
    })
}

// Bind reply for Microsoft Login.
/**
 * @param {import('electron').IpcRendererEvent} _
 * @param {any[]} arguments_
 */
ipcRenderer.on(MSFT_OPCODE.REPLY_LOGIN, (_, ...arguments_) => {
    if (arguments_[0] === MSFT_REPLY_TYPE.ERROR) {

        const viewOnClose = arguments_[2]
        console.log(arguments_)
        switchView(getCurrentView(), viewOnClose, 500, 500, () => {

            if (arguments_[1] === MSFT_ERROR.NOT_FINISHED) {
                // User cancelled.
                msftLoginLogger.info('Login cancelled by user.')
                return
            }

            // Unexpected error.
            setOverlayContent(
                Lang.queryJS('settings.msftLogin.errorTitle'),
                Lang.queryJS('settings.msftLogin.errorMessage'),
                Lang.queryJS('settings.msftLogin.okButton')
            )
            setOverlayHandler(() => {
                toggleOverlay(false)
            })
            toggleOverlay(true)
        })
    } else if (arguments_[0] === MSFT_REPLY_TYPE.SUCCESS) {
        const queryMap = arguments_[1]
        const viewOnClose = arguments_[2]

        // Error from request to Microsoft.
        if (Object.prototype.hasOwnProperty.call(queryMap, 'error')) {
            switchView(getCurrentView(), viewOnClose, 500, 500, () => {
                // TODO Dont know what these errors are. Just show them I guess.
                // This is probably if you messed up the app registration with Azure.
                let error = queryMap.error // Error might be 'access_denied' ?
                let errorDesc = queryMap.error_description
                console.log('Error getting authCode, is Azure application registered correctly?')
                console.log(error)
                console.log(errorDesc)
                console.log('Full query map: ', queryMap)
                setOverlayContent(
                    error,
                    errorDesc,
                    Lang.queryJS('settings.msftLogin.okButton')
                )
                setOverlayHandler(() => {
                    toggleOverlay(false)
                })
                toggleOverlay(true)

            })
        } else {

            msftLoginLogger.info('Acquired authCode, proceeding with authentication.')

            const authCode = queryMap.code
            AuthManager.addMicrosoftAccount(authCode).then(value => {
                updateSelectedAccount(value)
                switchView(getCurrentView(), viewOnClose, 500, 500, async () => {
                    if (viewOnClose === VIEWS.settings) {
                        await prepareSettings()
                    }
                })
            })
                .catch((displayableError) => {

                    let actualDisplayableError
                    if (isDisplayableError(displayableError)) {
                        msftLoginLogger.error('Error while logging in.', displayableError)
                        actualDisplayableError = displayableError
                    } else {
                        // Uh oh.
                        msftLoginLogger.error('Unhandled error during login.', displayableError)
                        actualDisplayableError = Lang.queryJS('login.error.unknown')
                    }

                    switchView(getCurrentView(), viewOnClose, 500, 500, () => {
                        setOverlayContent(actualDisplayableError.title, actualDisplayableError.desc, Lang.queryJS('login.tryAgain'))
                        setOverlayHandler(() => {
                            toggleOverlay(false)
                        })
                        toggleOverlay(true)
                    })
                })
        }
    }
})

/**
 * Bind functionality for the account selection buttons. If another account
 * is selected, the UI of the previously selected account will be updated.
 */
export function bindAuthAccountSelect() {
    Array.from(document.getElementsByClassName('settingsAuthAccountSelect')).map((val) => {
        val.onclick = (e) => {
            if (val.hasAttribute('selected')) {
                return
            }
            const selectBtns = document.getElementsByClassName('settingsAuthAccountSelect')
            for (let i = 0; i < selectBtns.length; i++) {
                if (selectBtns[i].hasAttribute('selected')) {
                    selectBtns[i].removeAttribute('selected')
                    selectBtns[i].innerHTML = Lang.queryJS('settings.authAccountSelect.selectButton') || 'Выбрать аккаунт'
                }
            }
            val.setAttribute('selected', '')
            val.innerHTML = Lang.queryJS('settings.authAccountSelect.selectedButton') || 'Выбран'
            ConfigManager.setSelectedAccount(val.closest('.settingsAuthAccount').getAttribute('uuid'))
        }
    })
}

/**
 * Bind functionality for the log out button. If the logged out account was
 * the selected account, another account will be selected and the UI will
 * be updated accordingly.
 */
export function bindAuthAccountLogOut() {
    Array.from(document.getElementsByClassName('settingsAuthAccountLogOut')).map((val) => {
        val.onclick = (e) => {
            let isLastAccount = false
            if (Object.keys(ConfigManager.getAuthAccounts()).length === 1) {
                isLastAccount = true
                setOverlayContent(
                    Lang.queryJS('settings.authAccountLogout.lastAccountWarningTitle'),
                    Lang.queryJS('settings.authAccountLogout.lastAccountWarningMessage'),
                    Lang.queryJS('settings.authAccountLogout.confirmButton'),
                    Lang.queryJS('settings.authAccountLogout.cancelButton')
                )
                setOverlayHandler(() => {
                    processLogOut(val, isLastAccount)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false)
                })
                toggleOverlay(true, true)
            } else {
                processLogOut(val, isLastAccount)
            }

        }
    })
}

export let msAccDomElementCache
/**
 * Process a log out.
 *
 * @param {Element} val The log out button element.
 * @param {boolean} isLastAccount If this logout is on the last added account.
 */
export function processLogOut(val, isLastAccount) {
    const parent = val.closest('.settingsAuthAccount')
    const uuid = parent.getAttribute('uuid')
    const prevSelAcc = ConfigManager.getSelectedAccount()
    const targetAcc = ConfigManager.getAuthAccount(uuid)
    if (targetAcc.type === 'microsoft') {
        msAccDomElementCache = parent
        switchView(getCurrentView(), VIEWS.waiting, 500, 500, () => {
            ipcRenderer.send(MSFT_OPCODE.OPEN_LOGOUT, uuid, isLastAccount)
        })
    } else {
        AuthManager.removeMojangAccount(uuid).then(() => {
            if (!isLastAccount && uuid === prevSelAcc.uuid) {
                const selAcc = ConfigManager.getSelectedAccount()
                refreshAuthAccountSelected(selAcc.uuid)
                updateSelectedAccount(selAcc)
                validateSelectedAccount()
            }
            if (isLastAccount) {
                loginOptionsCancelEnabled(false)
                window.loginViewOnSuccess = VIEWS.settings
                window.loginViewOnCancel = VIEWS.login
                switchView(getCurrentView(), VIEWS.login)
            }
        })
        fadeOut(parent, 250, () => {
            parent.remove()
        })
    }
}

// Bind reply for Microsoft Logout.
/**
 * @param {import('electron').IpcRendererEvent} _
 * @param {any[]} arguments_
 */
ipcRenderer.on(MSFT_OPCODE.REPLY_LOGOUT, (_, ...arguments_) => {
    if (arguments_[0] === MSFT_REPLY_TYPE.ERROR) {
        switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {

            if (arguments_.length > 1 && arguments_[1] === MSFT_ERROR.NOT_FINISHED) {
                // User cancelled.
                msftLogoutLogger.info('Logout cancelled by user.')
                return
            }

            // Unexpected error.
            setOverlayContent(
                Lang.queryJS('settings.msftLogout.errorTitle'),
                Lang.queryJS('settings.msftLogout.errorMessage'),
                Lang.queryJS('settings.msftLogout.okButton')
            )
            setOverlayHandler(() => {
                toggleOverlay(false)
            })
            toggleOverlay(true)
        })
    } else if (arguments_[0] === MSFT_REPLY_TYPE.SUCCESS) {

        const uuid = arguments_[1]
        const isLastAccount = arguments_[2]
        const prevSelAcc = ConfigManager.getSelectedAccount()

        msftLogoutLogger.info('Logout Successful. uuid:', uuid)

        AuthManager.removeMicrosoftAccount(uuid)
            .then(() => {
                if (!isLastAccount && uuid === prevSelAcc.uuid) {
                    const selAcc = ConfigManager.getSelectedAccount()
                    refreshAuthAccountSelected(selAcc.uuid)
                    updateSelectedAccount(selAcc)
                    validateSelectedAccount()
                }
                if (isLastAccount) {
                    loginOptionsCancelEnabled(false)
                    window.loginViewOnSuccess = VIEWS.settings
                    window.loginViewOnCancel = VIEWS.login
                    switchView(getCurrentView(), VIEWS.login)
                }
                if (msAccDomElementCache) {
                    msAccDomElementCache.remove()
                    msAccDomElementCache = null
                }
            })
            .finally(() => {
                if (!isLastAccount) {
                    switchView(getCurrentView(), VIEWS.settings, 500, 500)
                }
            })

    }
})

/**
 * Refreshes the status of the selected account on the auth account
 * elements.
 *
 * @param {string} uuid The UUID of the new selected account.
 */
export function refreshAuthAccountSelected(uuid) {
    Array.from(document.getElementsByClassName('settingsAuthAccount')).map((val) => {
        const selBtn = val.getElementsByClassName('settingsAuthAccountSelect')[0]
        if (uuid === val.getAttribute('uuid')) {
            selBtn.setAttribute('selected', '')
            selBtn.innerHTML = Lang.queryJS('settings.authAccountSelect.selectedButton')
        } else {
            if (selBtn.hasAttribute('selected')) {
                selBtn.removeAttribute('selected')
            }
            selBtn.innerHTML = Lang.queryJS('settings.authAccountSelect.selectButton')
        }
    })
}

export const settingsCurrentMicrosoftAccounts = document.getElementById('settingsCurrentMicrosoftAccounts')
export const settingsCurrentMojangAccounts = document.getElementById('settingsCurrentMojangAccounts')

/**
 * Add auth account elements for each one stored in the authentication database.
 */
export function populateAuthAccounts() {
    const authAccounts = ConfigManager.getAuthAccounts()
    const authKeys = Object.keys(authAccounts)
    if (authKeys.length === 0) {
        return
    }
    const selectedUUID = ConfigManager.getSelectedAccount().uuid

    let microsoftAuthAccountStr = ''
    let mojangAuthAccountStr = ''

    authKeys.forEach((val) => {
        const acc = authAccounts[val]

        const accHtml = `<div class="settingsAuthAccount" uuid="${acc.uuid}">
            <div class="settingsAuthAccountLeft">
                <img class="settingsAuthAccountImage" alt="${acc.displayName}" src="https://mc-heads.net/body/${acc.uuid}/60">
            </div>
            <div class="settingsAuthAccountRight">
                <div class="settingsAuthAccountDetails">
                    <div class="settingsAuthAccountDetailPane">
                        <div class="settingsAuthAccountDetailTitle">Имя пользователя</div>
                        <div class="settingsAuthAccountDetailValue">${acc.displayName}</div>
                    </div>
                    <div class="settingsAuthAccountDetailPane">
                        <div class="settingsAuthAccountDetailTitle">UUID</div>
                        <div class="settingsAuthAccountDetailValue">${acc.uuid.replace(/-/g, '')}</div>
                    </div>
                </div>
                <div class="settingsAuthAccountActions">
                    <button class="settingsAuthAccountSelect" ${selectedUUID === acc.uuid ? 'selected>Выбран' : '>Выбрать аккаунт'}</button>
                    <div class="settingsAuthAccountWrapper">
                        <button class="settingsAuthAccountLogOut">Удалить аккаунт</button>
                    </div>
                </div>
            </div>
        </div>`

        if (acc.type === 'microsoft') {
            microsoftAuthAccountStr += accHtml
        } else {
            mojangAuthAccountStr += accHtml
        }

    })

    settingsCurrentMicrosoftAccounts.innerHTML = microsoftAuthAccountStr
    settingsCurrentMojangAccounts.innerHTML = mojangAuthAccountStr
}

/**
 * Prepare the accounts tab for display.
 */
export function prepareAccountsTab() {
    populateAuthAccounts()
    bindAuthAccountSelect()
    bindAuthAccountLogOut()
}

/**
 * Minecraft Tab
 */

/**
  * Disable decimals, negative signs, and scientific notation.
  */
document.getElementById('settingsGameWidth').addEventListener('keydown', (e) => {
    if (/^[-.eE]$/.test(e.key)) {
        e.preventDefault()
    }
})
document.getElementById('settingsGameHeight').addEventListener('keydown', (e) => {
    if (/^[-.eE]$/.test(e.key)) {
        e.preventDefault()
    }
})

/**
 * Mods Tab
 */

let _settingsModsContainer = null
function getSettingsModsContainer() {
    if (!_settingsModsContainer) {
        _settingsModsContainer = document.getElementById('settingsModsContainer')
    }
    return _settingsModsContainer
}

/**
 * Resolve and update the mods on the UI.
 */
export async function resolveModsForUI() {
    const serv = ConfigManager.getSelectedServer()
    console.log('[resolveModsForUI] Selected Server ID:', serv)

    const distro = await DistroAPI.getDistribution()
    if (!distro) {
        console.error('[resolveModsForUI] Distribution is null!')
        return
    }

    console.log('[resolveModsForUI] Distro servers:', distro.servers.map(s => s.rawServer.id))

    const serverObj = distro.getServerById(serv)
    if (!serverObj) {
        console.error('[resolveModsForUI] Server object not found for ID:', serv)
        return
    }

    const servConf = ConfigManager.getModConfiguration(serv)
    const modStr = parseModulesForUI(serverObj.modules, false, servConf.mods)

    const reqContainer = document.getElementById('settingsReqModsContent')
    const optContainer = document.getElementById('settingsOptModsContent')

    if (reqContainer) reqContainer.innerHTML = modStr.reqMods
    if (optContainer) optContainer.innerHTML = modStr.optMods

    console.log('[resolveModsForUI] UI Updated with mods.')
}

/**
 * Recursively build the mod UI elements.
 *
 * @param {Object[]} mdls An array of modules to parse.
 * @param {boolean} submodules Whether or not we are parsing submodules.
 * @param {Object} servConf The server configuration object for this module level.
 */
export function parseModulesForUI(mdls, submodules, servConf) {
    console.log(`[parseModulesForUI] Processing ${mdls.length} modules. IDs:`, mdls.map(m => m.rawModule.id));
    let reqMods = ''
    let optMods = ''

    for (const mdl of mdls) {

        if (mdl.rawModule.type === Type.ForgeMod || mdl.rawModule.type === Type.LiteMod || mdl.rawModule.type === Type.LiteLoader || mdl.rawModule.type === Type.FabricMod) {

            if (mdl.getRequired().value) {

                const mdlID = mdl.getVersionlessMavenIdentifier()
                const subConf = (servConf && typeof servConf === 'object') ? servConf[mdlID] : undefined
                const mdlName = (typeof mdl.rawModule.name === 'string' ? mdl.rawModule.name : (mdl.rawModule.name?.value || 'Unknown Mod'))
                const mdlVersion = (typeof mdl.mavenComponents.version === 'string' ? mdl.mavenComponents.version : (mdl.mavenComponents.version?.value || '0.0.0'))

                reqMods += `<div id="${mdlID}" class="settingsBaseMod settings${submodules ? 'Sub' : ''}Mod" enabled>
                    <div class="settingsModContent">
                        <div class="settingsModMainWrapper">
                            <div class="settingsModStatus"></div>
                            <div class="settingsModDetails">
                                <span class="settingsModName">${mdlName}</span>
                                <span class="settingsModVersion">v${mdlVersion}</span>
                            </div>
                        </div>
                        <label class="toggleSwitch" reqmod>
                            <input type="checkbox" checked disabled>
                            <span class="toggleSwitchSlider"></span>
                        </label>
                    </div>
                    ${mdl.subModules.length > 0 ? `<div class="settingsSubModContainer">
                        ${Object.values(parseModulesForUI(mdl.subModules, true, subConf && typeof subConf === 'object' ? subConf.mods : subConf)).join('')}
                    </div>` : ''}
                </div>`

            } else {

                const mdlID = mdl.getVersionlessMavenIdentifier()
                const defVal = mdl.getRequired().def
                const conf = (servConf && typeof servConf === 'object') ? servConf[mdlID] : undefined
                const val = typeof conf === 'object' ? (conf.value !== undefined ? conf.value : defVal) : (typeof conf === 'boolean' ? conf : defVal)
                const mdlName = (typeof mdl.rawModule.name === 'string' ? mdl.rawModule.name : (mdl.rawModule.name?.value || 'Unknown Mod'))
                const mdlVersion = (typeof mdl.mavenComponents.version === 'string' ? mdl.mavenComponents.version : (mdl.mavenComponents.version?.value || '0.0.0'))

                optMods += `<div id="${mdlID}" class="settingsBaseMod settingsMod ${submodules ? 'settingsSubMod' : ''}" ${val ? 'enabled' : ''}>
                    <div class="settingsModContent">
                        <div class="settingsModMainWrapper">
                            <div class="settingsModStatus"></div>
                            <div class="settingsModDetails">
                                <span class="settingsModName">${mdlName}</span>
                                <span class="settingsModVersion">v${mdlVersion}</span>
                            </div>
                        </div>
                        <label class="toggleSwitch">
                            <input type="checkbox" formod="${mdlID}" ${val ? 'checked' : ''}>
                            <span class="toggleSwitchSlider"></span>
                        </label>
                    </div>
                    ${mdl.subModules.length > 0 ? `<div class="settingsSubModContainer">
                        ${Object.values(parseModulesForUI(mdl.subModules, true, (conf && typeof conf === 'object') ? conf.mods : undefined)).join('')}
                    </div>` : ''}
                </div>`

            }
        }
    }

    return {
        reqMods,
        optMods
    }

}

/**
 * Bind functionality to mod config toggle switches. Switching the value
 * will also switch the status color on the left of the mod UI.
 */
export function bindModsToggleSwitch() {
    const container = getSettingsModsContainer()
    if (!container) return
    const sEls = container.querySelectorAll('[formod]')
    Array.from(sEls).map((v, index, arr) => {
        v.onchange = () => {
            if (v.checked) {
                document.getElementById(v.getAttribute('formod')).setAttribute('enabled', '')
            } else {
                document.getElementById(v.getAttribute('formod')).removeAttribute('enabled')
            }
        }
    })
}

/**
 * Save the mod configuration based on the UI values.
 */
export function saveModConfiguration() {
    const serv = ConfigManager.getSelectedServer()
    const modConf = ConfigManager.getModConfiguration(serv)
    const container = getSettingsModsContainer()

    if (!container) return

    // Helper to recursively collect values from the DOM
    const saveFromDOM = (currentMods, parentElement) => {
        parentElement.querySelectorAll('.settingsBaseMod').forEach(modEl => {
            const subContainers = parentElement.querySelectorAll('.settingsSubModContainer');
            let isNestedDeeply = false;
            for (let sc of subContainers) {
                if (sc !== parentElement && sc.contains(modEl)) {
                    isNestedDeeply = true;
                    break;
                }
            }
            if (isNestedDeeply) return;

            const input = modEl.querySelector('.settingsModContent input[formod]:not([dropin])')
            if (!input) return

            const id = input.getAttribute('formod')
            const value = input.checked
            const subContainer = modEl.querySelector('.settingsSubModContainer')

            if (subContainer) {
                // Ensure parent object structure for mods with sub-modules
                if (typeof currentMods[id] !== 'object' || currentMods[id] === null) {
                    currentMods[id] = { value: value, mods: {} }
                } else {
                    currentMods[id].value = value
                    if (!currentMods[id].mods) currentMods[id].mods = {}
                }
                saveFromDOM(currentMods[id].mods, subContainer)
            } else {
                // Leaf mod: simple boolean if not already an object
                if (typeof currentMods[id] === 'object' && currentMods[id] !== null) {
                    currentMods[id].value = value
                } else {
                    currentMods[id] = value
                }
            }
        })
    }

    saveFromDOM(modConf.mods, container)
    ConfigManager.setModConfiguration(serv, modConf)
}

// Drop-in mod elements.

export let CACHE_SETTINGS_MODS_DIR
export let CACHE_DROPIN_MODS

/**
 * Resolve any located drop-in mods for this server and
 * populate the results onto the UI.
 */
async function resolveDropinModsForUI() {
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
    if (!serv) {
        console.warn('[Settings] resolveDropinModsForUI: No server selected.')
        return
    }
    CACHE_SETTINGS_MODS_DIR = sysPath.join(await ConfigManager.getInstanceDirectory(), serv.rawServer.id, 'mods')
    CACHE_DROPIN_MODS = await DropinModUtil.scanForDropinMods(CACHE_SETTINGS_MODS_DIR, serv.rawServer.minecraftVersion)

    let dropinMods = ''

    for (let dropin of CACHE_DROPIN_MODS) {
        dropinMods += `<div id="${dropin.fullName}" class="settingsBaseMod settingsDropinMod" ${!dropin.disabled ? 'enabled' : ''}>
                    <div class="settingsModContent">
                        <div class="settingsModMainWrapper">
                            <div class="settingsModStatus"></div>
                            <div class="settingsModDetails">
                                <span class="settingsModName">${dropin.name}</span>
                                <div class="settingsDropinRemoveWrapper">
                                    <button class="settingsDropinRemoveButton" remmod="${dropin.fullName}">${Lang.queryJS('settings.dropinMods.removeButton')}</button>
                                </div>
                            </div>
                        </div>
                        <label class="toggleSwitch">
                            <input type="checkbox" formod="${dropin.fullName}" dropin ${!dropin.disabled ? 'checked' : ''}>
                            <span class="toggleSwitchSlider"></span>
                        </label>
                    </div>
                </div>`
    }

    document.getElementById('settingsDropinModsContent').innerHTML = dropinMods
}

/**
 * Bind the remove button for each loaded drop-in mod.
 */
export function bindDropinModsRemoveButton() {
    const container = getSettingsModsContainer()
    if (!container) return
    const sEls = container.querySelectorAll('[remmod]')
    Array.from(sEls).map((v, index, arr) => {
        v.onclick = async () => {
            const fullName = v.getAttribute('remmod')
            const res = await DropinModUtil.deleteDropinMod(CACHE_SETTINGS_MODS_DIR, fullName)
            if (res) {
                document.getElementById(fullName).remove()
            } else {
                setOverlayContent(
                    Lang.queryJS('settings.dropinMods.deleteFailedTitle', { fullName }),
                    Lang.queryJS('settings.dropinMods.deleteFailedMessage'),
                    Lang.queryJS('settings.dropinMods.okButton')
                )
                setOverlayHandler(null)
                toggleOverlay(true)
            }
        }
    })
}

/**
 * Bind functionality to the file system button for the selected
 * server configuration.
 */
export function bindDropinModFileSystemButton() {
    const fsBtn = document.getElementById('settingsDropinFileSystemButton')
    fsBtn.onclick = async () => {
        await ipcRenderer.invoke('fs:mkdir', CACHE_SETTINGS_MODS_DIR, { recursive: true })
        await ipcRenderer.invoke('shell:openPath', CACHE_SETTINGS_MODS_DIR)
    }
    fsBtn.ondragenter = e => {
        e.dataTransfer.dropEffect = 'move'
        fsBtn.setAttribute('drag', '')
        e.preventDefault()
    }
    fsBtn.ondragover = e => {
        e.preventDefault()
    }
    fsBtn.ondragleave = e => {
        fsBtn.removeAttribute('drag')
    }

    fsBtn.ondrop = async e => {
        fsBtn.removeAttribute('drag')
        e.preventDefault()

        await DropinModUtil.addDropinMods(e.dataTransfer.files, CACHE_SETTINGS_MODS_DIR)
        await reloadDropinMods()
    }
}

/**
 * Save drop-in mod states. Enabling and disabling is just a matter
 * of adding/removing the .disabled extension.
 */
export async function saveDropinModConfiguration() {
    if (!CACHE_DROPIN_MODS) return;
    for (let dropin of CACHE_DROPIN_MODS) {
        const dropinUI = document.getElementById(dropin.fullName)
        if (dropinUI != null) {
            const dropinUIEnabled = dropinUI.hasAttribute('enabled')
            if (DropinModUtil.isDropinModEnabled(dropin.fullName) != dropinUIEnabled) {
                try {
                    await DropinModUtil.toggleDropinMod(CACHE_SETTINGS_MODS_DIR, dropin.fullName, dropinUIEnabled)
                } catch (err) {
                    if (!isOverlayVisible()) {
                        setOverlayContent(
                            Lang.queryJS('settings.dropinMods.failedToggleTitle'),
                            err.message,
                            Lang.queryJS('settings.dropinMods.okButton')
                        )
                        setOverlayHandler(null)
                        toggleOverlay(true)
                    }
                }
            }
        }
    }
}

// Refresh the drop-in mods when F5 is pressed.
// Only active on the mods tab.
document.addEventListener('keydown', async (e) => {
    if (getCurrentView() === VIEWS.settings && selectedSettingsTab === 'settingsTabMods') {
        if (e.key === 'F5') {
            await reloadDropinMods()
            saveShaderpackSettings()
            await resolveShaderpacksForUI()
        }
    }
})

async function reloadDropinMods() {
    await resolveDropinModsForUI()
    bindDropinModsRemoveButton()
    bindDropinModFileSystemButton()
    bindModsToggleSwitch()
}

// Shaderpack

export let CACHE_SETTINGS_INSTANCE_DIR
export let CACHE_SHADERPACKS
export let CACHE_SELECTED_SHADERPACK

/**
 * Load shaderpack information.
 */
async function resolveShaderpacksForUI() {
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
    if (!serv) {
        console.warn('[Settings] resolveShaderpacksForUI: No server selected.')
        return
    }
    CACHE_SETTINGS_INSTANCE_DIR = sysPath.join(await ConfigManager.getInstanceDirectory(), serv.rawServer.id)
    CACHE_SHADERPACKS = await DropinModUtil.scanForShaderpacks(CACHE_SETTINGS_INSTANCE_DIR)
    CACHE_SELECTED_SHADERPACK = await DropinModUtil.getEnabledShaderpack(CACHE_SETTINGS_INSTANCE_DIR)

    setShadersOptions(CACHE_SHADERPACKS, CACHE_SELECTED_SHADERPACK)
}

export function setShadersOptions(arr, selected) {
    const cont = document.getElementById('settingsShadersOptions')
    cont.innerHTML = ''
    for (let opt of arr) {
        const d = document.createElement('DIV')
        d.innerHTML = opt.name
        d.setAttribute('value', opt.fullName)
        if (opt.fullName === selected) {
            d.setAttribute('selected', '')
            document.getElementById('settingsShadersSelected').innerHTML = opt.name
        }
        d.addEventListener('click', function (e) {
            this.parentNode.previousElementSibling.innerHTML = this.innerHTML
            for (let sib of this.parentNode.children) {
                sib.removeAttribute('selected')
            }
            this.setAttribute('selected', '')
            closeSettingsSelect()
        })
        cont.appendChild(d)
    }
}

export async function saveShaderpackSettings() {
    if (!CACHE_SETTINGS_INSTANCE_DIR) {
        console.warn('[Settings] saveShaderpackSettings: CACHE_SETTINGS_INSTANCE_DIR is undefined, skipping.')
        return
    }
    let sel = 'OFF'
    const optionsContainer = document.getElementById('settingsShadersOptions')
    if (optionsContainer) {
        for (let opt of optionsContainer.children) {
            if (opt.hasAttribute('selected')) {
                sel = opt.getAttribute('value')
            }
        }
    }
    await DropinModUtil.setEnabledShaderpack(CACHE_SETTINGS_INSTANCE_DIR, sel)
}

export function bindShaderpackButton() {
    const spBtn = document.getElementById('settingsShaderpackButton')
    spBtn.onclick = async () => {
        const p = sysPath.join(CACHE_SETTINGS_INSTANCE_DIR, 'shaderpacks')
        await ipcRenderer.invoke('fs:mkdir', p, { recursive: true })
        await ipcRenderer.invoke('shell:openPath', p)
    }
    spBtn.ondragenter = e => {
        e.dataTransfer.dropEffect = 'move'
        spBtn.setAttribute('drag', '')
        e.preventDefault()
    }
    spBtn.ondragover = e => {
        e.preventDefault()
    }
    spBtn.ondragleave = e => {
        spBtn.removeAttribute('drag')
    }

    spBtn.ondrop = async e => {
        spBtn.removeAttribute('drag')
        e.preventDefault()

        await DropinModUtil.addShaderpacks(e.dataTransfer.files, CACHE_SETTINGS_INSTANCE_DIR)
        await saveShaderpackSettings()
        await resolveShaderpacksForUI()
    }
}

// Server status bar functions.

/**
 * Load the currently selected server information onto the mods tab.
 */
async function loadSelectedServerOnModsTab() {
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
    if (!serv) {
        console.warn('[Settings] loadSelectedServerOnModsTab: No server selected.')
        return
    }

    for (const el of document.getElementsByClassName('settingsSelServContent')) {
        const safeName = (typeof serv.rawServer.name === 'string' ? serv.rawServer.name : (serv.rawServer.name?.value || 'Server')).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;")
        const safeDesc = (typeof serv.rawServer.description === 'string' ? serv.rawServer.description : (serv.rawServer.description?.value || '')).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;")

        el.innerHTML = `
            <img class="serverListingImg" src="${serv.rawServer.icon}"/>
            <div class="serverListingDetails">
                <span class="serverListingName">${safeName}</span>
                <span class="serverListingDescription">${safeDesc}</span>
                <div class="serverListingInfo">
                    <div class="serverListingVersion">${serv.rawServer.minecraftVersion}</div>
                    <div class="serverListingRevision">${serv.rawServer.version}</div>
                    ${serv.rawServer.mainServer ? `<div class="serverListingStarWrapper">
                        <svg id="Layer_1" viewBox="0 0 107.45 104.74" width="20px" height="20px">
                            <defs>
                                <style>.cls-1{fill:#fff;}.cls-2{fill:none;stroke:#fff;stroke-miterlimit:10;}</style>
                            </defs>
                            <path class="cls-1" d="M100.93,65.54C89,62,68.18,55.65,63.54,52.13c2.7-5.23,18.8-19.2,28-27.55C81.36,31.74,63.74,43.87,58.09,45.3c-2.41-5.37-3.61-26.52-4.37-39-.77,12.46-2,33.64-4.36,39-5.7-1.46-23.3-13.57-33.49-20.72,9.26,8.37,25.39,22.36,28,27.55C39.21,55.68,18.47,62,6.52,65.55c12.32-2,33.63-6.06,39.34-4.9-.16,5.87-8.41,26.16-13.11,37.69,6.1-10.89,16.52-30.16,21-33.9,4.5,3.79,14.93,23.09,21,34C70,86.84,61.73,66.48,61.59,60.65,67.36,59.49,88.64,63.52,100.93,65.54Z"/>
                            <circle class="cls-2" cx="53.73" cy="53.9" r="38"/>
                        </svg>
                        <span class="serverListingStarTooltip">${Lang.queryJS('settings.serverListing.mainServer')}</span>
                    </div>` : ''}
                </div>
            </div>
        `
    }
}

// Bind functionality to the server switch button.
Array.from(document.getElementsByClassName('settingsSwitchServerButton')).forEach(el => {
    el.addEventListener('click', async e => {
        e.target.blur()
        await toggleServerSelection(true)
    })
})

/**
 * Save mod configuration for the current selected server.
 */
export async function saveAllModConfigurations() {
    saveModConfiguration()
    await ConfigManager.save()
    await saveDropinModConfiguration()
}

/**
 * Function to refresh the current tab whenever the selected
 * server is changed.
 */
export function animateSettingsTabRefresh() {
    fadeOut(document.getElementById(selectedSettingsTab), 500, async () => {
        await prepareSettings()
        fadeIn(document.getElementById(selectedSettingsTab), 500)
    })
}

/**
 * Prepare the Mods tab for display.
 */
async function prepareModsTab(first) {
    await resolveModsForUI()
    await resolveDropinModsForUI()
    await resolveShaderpacksForUI()
    bindDropinModsRemoveButton()
    bindDropinModFileSystemButton()
    bindShaderpackButton()
    bindModsToggleSwitch()
    await loadSelectedServerOnModsTab()
}

/**
 * Java Tab
 */

// DOM Cache
export const settingsMaxRAMRange = document.getElementById('settingsMaxRAMRange')
export const settingsMinRAMRange = document.getElementById('settingsMinRAMRange')
export const settingsMaxRAMLabel = document.getElementById('settingsMaxRAMLabel')
export const settingsMinRAMLabel = document.getElementById('settingsMinRAMLabel')
export const settingsMemoryTotal = document.getElementById('settingsMemoryTotal')
export const settingsMemoryAvail = document.getElementById('settingsMemoryAvail')
export const settingsJavaExecDetails = document.getElementById('settingsJavaExecDetails')
export const settingsJavaReqDesc = document.getElementById('settingsJavaReqDesc')
export const settingsJvmOptsLink = document.getElementById('settingsJvmOptsLink')

// Bind on change event for min memory container.
settingsMinRAMRange.onchange = (e) => {

    // Current range values
    const sMaxV = Number(settingsMaxRAMRange.getAttribute('value'))
    const sMinV = Number(settingsMinRAMRange.getAttribute('value'))

    // Get reference to range bar.
    const bar = e.target.getElementsByClassName('rangeSliderBar')[0]
    // Calculate effective total memory.
    const max = os.totalmem() / 1073741824

    // Change range bar color based on the selected value.
    if (sMinV >= max / 2) {
        bar.style.background = '#e86060'
    } else if (sMinV >= max / 4) {
        bar.style.background = '#e8e18b'
    } else {
        bar.style.background = null
    }

    // Increase maximum memory if the minimum exceeds its value.
    if (sMaxV < sMinV) {
        const sliderMeta = calculateRangeSliderMeta(settingsMaxRAMRange)
        updateRangedSlider(settingsMaxRAMRange, sMinV,
            ((sMinV - sliderMeta.min) / sliderMeta.step) * sliderMeta.inc)
        settingsMaxRAMLabel.innerHTML = sMinV.toFixed(1) + 'G'
    }

    // Update label
    settingsMinRAMLabel.innerHTML = sMinV.toFixed(1) + 'G'
}

// Bind on change event for max memory container.
settingsMaxRAMRange.onchange = (e) => {
    // Current range values
    const sMaxV = Number(settingsMaxRAMRange.getAttribute('value'))
    const sMinV = Number(settingsMinRAMRange.getAttribute('value'))

    // Get reference to range bar.
    const bar = e.target.getElementsByClassName('rangeSliderBar')[0]
    // Calculate effective total memory.
    const max = os.totalmem() / 1073741824

    // Change range bar color based on the selected value.
    if (sMaxV >= max / 2) {
        bar.style.background = '#e86060'
    } else if (sMaxV >= max / 4) {
        bar.style.background = '#e8e18b'
    } else {
        bar.style.background = null
    }

    // Decrease the minimum memory if the maximum value is less.
    if (sMaxV < sMinV) {
        const sliderMeta = calculateRangeSliderMeta(settingsMaxRAMRange)
        updateRangedSlider(settingsMinRAMRange, sMaxV,
            ((sMaxV - sliderMeta.min) / sliderMeta.step) * sliderMeta.inc)
        settingsMinRAMLabel.innerHTML = sMaxV.toFixed(1) + 'G'
    }
    settingsMaxRAMLabel.innerHTML = sMaxV.toFixed(1) + 'G'
}

/**
 * Calculate common values for a ranged slider.
 *
 * @param {Element} v The range slider to calculate against.
 * @returns {Object} An object with meta values for the provided ranged slider.
 */
export function calculateRangeSliderMeta(v) {
    const val = {
        max: Number(v.getAttribute('max')),
        min: Number(v.getAttribute('min')),
        step: Number(v.getAttribute('step')),
    }
    val.ticks = (val.max - val.min) / val.step
    val.inc = 100 / val.ticks
    return val
}

/**
 * Binds functionality to the ranged sliders. They're more than
 * just divs now :').
 */
export function bindRangeSlider() {
    Array.from(document.getElementsByClassName('rangeSlider')).map((v) => {

        // Reference the track (thumb).
        const track = v.getElementsByClassName('rangeSliderTrack')[0]

        // Set the initial slider value.
        const value = v.getAttribute('value')
        const sliderMeta = calculateRangeSliderMeta(v)

        updateRangedSlider(v, value, ((value - sliderMeta.min) / sliderMeta.step) * sliderMeta.inc)

        // The magic happens when we click on the track.
        track.onmousedown = (e) => {

            // Stop moving the track on mouse up.
            document.onmouseup = (e) => {
                document.onmousemove = null
                document.onmouseup = null
            }

            // Move slider according to the mouse position.
            document.onmousemove = (e) => {

                // Distance from the beginning of the bar in pixels.
                const diff = e.pageX - v.offsetLeft - track.offsetWidth / 2

                // Don't move the track off the bar.
                if (diff >= 0 && diff <= v.offsetWidth - track.offsetWidth / 2) {

                    // Convert the difference to a percentage.
                    const perc = (diff / v.offsetWidth) * 100
                    // Calculate the percentage of the closest notch.
                    const notch = Number(perc / sliderMeta.inc).toFixed(0) * sliderMeta.inc

                    // If we're close to that notch, stick to it.
                    if (Math.abs(perc - notch) < sliderMeta.inc / 2) {
                        updateRangedSlider(v, sliderMeta.min + (sliderMeta.step * (notch / sliderMeta.inc)), notch)
                    }
                }
            }
        }
    })
}

/**
 * Update a ranged slider's value and position.
 *
 * @param {Element} element The ranged slider to update.
 * @param {string | number} value The new value for the ranged slider.
 * @param {number} notch The notch that the slider should now be at.
 */
export function updateRangedSlider(element, value, notch) {
    const oldVal = element.getAttribute('value')
    const bar = element.getElementsByClassName('rangeSliderBar')[0]
    const track = element.getElementsByClassName('rangeSliderTrack')[0]

    element.setAttribute('value', value)

    if (notch < 0) {
        notch = 0
    } else if (notch > 100) {
        notch = 100
    }

    const event = new MouseEvent('change', {
        target: element,
        type: 'change',
        bubbles: false,
        cancelable: true
    })

    let cancelled = !element.dispatchEvent(event)

    if (!cancelled) {
        track.style.left = notch + '%'
        bar.style.width = notch + '%'
    } else {
        element.setAttribute('value', oldVal)
    }
}

/**
 * Display the total and available RAM.
 */
export async function populateMemoryStatus() {
    if (typeof settingsMemoryTotal !== 'undefined' && settingsMemoryTotal != null) {
        settingsMemoryTotal.innerHTML = Number(os.totalmem() / 1073741824).toFixed(1) + 'G'
    }
    if (typeof settingsMemoryAvail !== 'undefined' && settingsMemoryAvail != null) {
        try {
            const sysutil = require('../../core/sysutil')
            const availGb = await sysutil.getAvailableRamGb()
            settingsMemoryAvail.innerHTML = availGb.toFixed(1) + 'G'
        } catch (e) {
            settingsMemoryAvail.innerHTML = Number(os.freemem() / 1073741824).toFixed(1) + 'G'
        }
    }
    await populateDiskStatus()
}

/**
 * Display the available disk space.
 */
export async function populateDiskStatus() {
    const diskEl = document.getElementById('settingsDiskAvail')
    if (diskEl) {
        try {
            const dataDir = await ConfigManager.getLauncherDirectory()
            const stats = await ipcRenderer.invoke('fs:statfs', dataDir)
            if (!stats || typeof stats.bsize === 'undefined') {
                diskEl.innerHTML = 'Calculating...'
                return
            }
            // bsize is block size, bavail is free blocks for unprivileged users
            const freeBytes = stats.bsize * stats.bavail
            diskEl.innerHTML = (freeBytes / 1073741824).toFixed(1) + 'G'
        } catch (e) {
            console.error('Failed to calculate disk space:', e)
            diskEl.innerHTML = 'N/A'
        }
    }
}

/**
 * Validate the provided executable path and display the data on
 * the UI.
 *
 * @param {string} execPath The executable path to populate against.
 */
async function populateJavaExecDetails(execPath) {
    const distro = await DistroAPI.getDistribution()
    if (!distro) return
    const server = distro.getServerById(ConfigManager.getSelectedServer())
    if (!server) return

    const details = await ipcRenderer.invoke('sys:validateJava', ensureJavaDirIsRoot(execPath), server.effectiveJavaOptions.supported)

    if (typeof settingsJavaExecDetails !== 'undefined' && settingsJavaExecDetails != null) {
        if (details != null) {
            const isAuto = !execPath || execPath === 'null' || String(execPath).trim() === '';
            const autoPrefix = isAuto ? 'Авто: ' : '';
            settingsJavaExecDetails.innerHTML = autoPrefix + Lang.queryJS('settings.java.selectedJava', { version: details.semverStr, vendor: details.vendor })
        } else {
            settingsJavaExecDetails.innerHTML = Lang.queryJS('settings.java.invalidSelection')
        }
    }
}
window.populateJavaExecDetails = populateJavaExecDetails;

function populateJavaExecDropdown(server) {
    const selectEl = document.getElementById('settingsJavaExecVal');
    if (!selectEl) return;

    // Preserve the current value
    const currentVal = ConfigManager.getJavaExecutable(server.rawServer.id);

    // Clear options right before appending, to avoid race conditions
    selectEl.innerHTML = '<option value="" data-lang="settings.java.autoSelected">Автоматический выбор (Рекомендуется)</option>';

    // Manual option placeholder if current is not in the list
    if (currentVal) {
        const opt = document.createElement('option');
        opt.value = currentVal;
        opt.textContent = `Custom: ${currentVal}`;
        selectEl.appendChild(opt);
        selectEl.value = currentVal;
    } else {
        selectEl.value = '';
    }

    // Add event listener to update config
    selectEl.onchange = async () => {
        const newVal = selectEl.value;
        ConfigManager.setJavaExecutable(server.rawServer.id, newVal === '' ? null : newVal);
        await ConfigManager.save();
        await populateJavaExecDetails(newVal === '' ? null : newVal);
    };

    // Trigger initial population (async, in background)
    populateJavaExecDetails(currentVal || null);

    // Load actual Java runtimes from system in background
    ipcRenderer.invoke('sys:getAllJavas', {
        version: server.effectiveJavaOptions.supported,
        suggestedMajor: server.effectiveJavaOptions.suggestedMajor
    }).then((javas) => {
        const innerSelectEl = document.getElementById('settingsJavaExecVal');
        if (!innerSelectEl) return;

        innerSelectEl.innerHTML = '<option value="" data-lang="settings.java.autoSelected">Автоматический выбор (Рекомендуется)</option>';

        if (javas && javas.length > 0) {
            javas.forEach(j => {
                const opt = document.createElement('option');
                opt.value = j.path;
                opt.textContent = `${j.vendor} Java ${j.semverStr} (${j.path})`;
                innerSelectEl.appendChild(opt);
            });
        }

        let found = false;
        for (let i = 0; i < innerSelectEl.options.length; i++) {
            if (innerSelectEl.options[i].value === currentVal) {
                found = true;
                break;
            }
        }

        if (currentVal && !found) {
            const opt = document.createElement('option');
            opt.value = currentVal;
            opt.textContent = `Custom: ${currentVal}`;
            innerSelectEl.appendChild(opt);
        }

        innerSelectEl.value = currentVal || '';
    }).catch((e) => {
        console.error('Failed to get all Javas:', e);
    });
}

export function populateJavaReqDesc(server) {
    if (typeof settingsJavaReqDesc !== 'undefined' && settingsJavaReqDesc != null) {
        settingsJavaReqDesc.innerHTML = Lang.queryJS('settings.java.requiresJava', { major: server.effectiveJavaOptions.suggestedMajor })
    }
}

export function populateJvmOptsLink(server) {
    const major = server.effectiveJavaOptions.suggestedMajor
    settingsJvmOptsLink.innerHTML = Lang.queryJS('settings.java.availableOptions', { major: major })
    if (major >= 12) {
        settingsJvmOptsLink.href = `https://docs.oracle.com/en/java/javase/${major}/docs/specs/man/java.html#extra-options-for-java`
    }
    else if (major >= 11) {
        settingsJvmOptsLink.href = 'https://docs.oracle.com/en/java/javase/11/tools/java.html#GUID-3B1CE181-CD30-4178-9602-230B800D4FAE'
    }
    else if (major >= 9) {
        settingsJvmOptsLink.href = `https://docs.oracle.com/javase/${major}/tools/java.htm`
    }
    else {
        settingsJvmOptsLink.href = `https://docs.oracle.com/javase/${major}/docs/technotes/tools/${process.platform === 'win32' ? 'windows' : 'unix'}/java.html`
    }
}

export function bindMinMaxRam(server) {
    if (!server || !server.rawServer) {
        console.warn('[Settings] bindMinMaxRam: server or rawServer is null')
        return
    }
    // Store maximum memory values.
    const SETTINGS_MAX_MEMORY = ConfigManager.getAbsoluteMaxRAM(server.rawServer.javaOptions?.ram)
    const SETTINGS_MIN_MEMORY = ConfigManager.getAbsoluteMinRAM(server.rawServer.javaOptions?.ram)

    // Set the max and min values for the ranged sliders.
    if (typeof settingsMaxRAMRange !== 'undefined' && settingsMaxRAMRange) {
        settingsMaxRAMRange.setAttribute('max', SETTINGS_MAX_MEMORY)
        settingsMaxRAMRange.setAttribute('min', SETTINGS_MIN_MEMORY)
    }
    if (typeof settingsMinRAMRange !== 'undefined' && settingsMinRAMRange) {
        settingsMinRAMRange.setAttribute('max', SETTINGS_MAX_MEMORY)
        settingsMinRAMRange.setAttribute('min', SETTINGS_MIN_MEMORY)
    }
}

/**
 * Prepare the Java tab for display.
 */
async function prepareJavaTab() {
    const serverId = ConfigManager.getSelectedServer()
    const distro = await DistroAPI.getDistribution()
    const server = distro.getServerById(serverId)

    if (server != null) {
        bindMinMaxRam(server)
        bindRangeSlider(server)
        populateMemoryStatus()
        populateJavaReqDesc(server)
        populateJvmOptsLink(server)
        await populateJavaExecDropdown(server)
    } else {
        console.warn('[Settings] prepareJavaTab: Server not found for ID:', serverId)
    }
}

/**
 * About Tab
 */

// About & Updates consolidated tab elements (Initialized lazily)
export let settingsTabAbout = null
export let settingsAboutChangelogTitle = null
export let settingsAboutChangelogText = null
export let settingsAboutChangelogButton = null

function initAboutTabElements() {
    settingsTabAbout = document.getElementById('settingsTabUpdate')
    if (settingsTabAbout) {
        settingsAboutChangelogTitle = settingsTabAbout.getElementsByClassName('settingsChangelogTitle')[0]
        settingsAboutChangelogText = settingsTabAbout.getElementsByClassName('settingsChangelogText')[0]
        settingsAboutChangelogButton = settingsTabAbout.getElementsByClassName('settingsChangelogButton')[0]
    }
}

// Bind the devtools toggle button.
if (typeof safeSetOnClick === 'function') {
    safeSetOnClick('settingsAboutDevToolsButton', (e) => {
        const win = window.currentWindow || currentWindow
        if (win && typeof win.toggleDevTools === 'function') {
            win.toggleDevTools()
        }
    })
}

/**
 * Return whether or not the provided version is a prerelease.
 *
 * @param {string} version The semver version to test.
 * @returns {boolean} True if the version is a prerelease, otherwise false.
 */
export function isPrerelease(version) {
    const preRelComp = semver.prerelease(version)
    return preRelComp != null && preRelComp.length > 0
}

/**
 * Utility method to display version information on the
 * About and Update settings tabs.
 *
 * @param {string} version The semver version to display.
 * @param {Element} valueElement The value element.
 * @param {Element} titleElement The title element.
 * @param {Element} checkElement The check mark element.
 */
export function populateVersionInformation(version, valueElement, titleElement, checkElement) {
    console.log('[Settings] populateVersionInformation:', version)
    version = version || window.appVersion || (window.HeliosAPI?.app?.getVersion ? window.HeliosAPI.app.getVersion() : '0.0.1')

    if (valueElement) {
        const semverEl = valueElement.querySelector('#settingsAboutCurrentVersionValueSemver') || valueElement
        const hashEl = valueElement.querySelector('#settingsAboutBuildHash')

        semverEl.innerHTML = version
        if (hashEl) {
            hashEl.innerHTML = process.env.BUILD_HASH ? `@${process.env.BUILD_HASH}` : ''
        }
    }

    if (isPrerelease(version)) {
        titleElement.innerHTML = Lang.queryJS('settings.about.preReleaseTitle')
        titleElement.style.color = '#ff886d'
        checkElement.style.background = '#ff886d'
    } else {
        titleElement.innerHTML = Lang.queryJS('settings.about.stableReleaseTitle')
        titleElement.style.color = null
        checkElement.style.background = null
    }
}

/**
 * Retrieve the version information and display it on the UI.
 */
export function populateAboutVersionInformation() {
    const version = window.appVersion || (window.HeliosAPI?.app?.getVersion ? window.HeliosAPI.app.getVersion() : '0.0.1')
    populateVersionInformation(version, document.getElementById('settingsAboutCurrentVersionValue'), document.getElementById('settingsAboutCurrentVersionTitle'), document.getElementById('settingsAboutCurrentVersionCheck'))
}

/**
 * Fetches the GitHub atom release feed and parses it for the release notes
 * of the current version. This value is displayed on the UI.
 */
export function populateReleaseNotes() {
    fetch('https://github.com/Envel-Experimental/Flauncher/releases.atom')
        .then(response => response.text())
        .then(data => {
            const version = 'v' + (window.appVersion || '0.0.1')
            const parser = new DOMParser()
            const xmlDoc = parser.parseFromString(data, 'text/xml')
            const entries = xmlDoc.getElementsByTagName('entry')

            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i]
                let id = entry.getElementsByTagName('id')[0].textContent
                id = id.substring(id.lastIndexOf('/') + 1)

                if (id === version) {
                    settingsAboutChangelogTitle.innerHTML = entry.getElementsByTagName('title')[0].textContent
                    settingsAboutChangelogText.innerHTML = entry.getElementsByTagName('content')[0].textContent
                    settingsAboutChangelogButton.href = entry.getElementsByTagName('link')[0].getAttribute('href')
                }
            }

        })
        .catch(err => {
            console.error('Failed to fetch release notes', err)
            settingsAboutChangelogText.innerHTML = Lang.queryJS('settings.about.releaseNotesFailed')
        })
}


/**
 * Prepare account tab for display.
 */
export function prepareAboutTab() {
    initAboutTabElements()
    populateAboutVersionInformation()
    populateReleaseNotes()
    updateConnectivityStatus()

    const supportBtn = document.getElementById('settingsAboutSupportButton')
    if (supportBtn) {
        supportBtn.onclick = () => {
            const supportUrl = ConfigManager.getSupportUrl() || 'https://t.me/+1THtTcDneY9iYTVi'
            const hAPI = window.HeliosAPI || {}
            if (hAPI.shell) {
                hAPI.shell.openExternal(supportUrl)
            } else {
                shell.openExternal(supportUrl)
            }
        }
    }
}


/**
 * Update Tab
 */

export function getUpdateTabElements() {
    const settingsTabUpdate = document.getElementById('settingsTabUpdate')
    if (!settingsTabUpdate) return null

    return {
        settingsTabUpdate,
        settingsUpdateTitle: document.getElementById('settingsUpdateTitle'),
        settingsUpdateVersionCheck: document.getElementById('settingsAboutCurrentVersionCheck'),
        settingsUpdateVersionTitle: document.getElementById('settingsAboutCurrentVersionTitle'),
        settingsUpdateVersionValue: document.getElementById('settingsAboutCurrentVersionValue'),
        settingsUpdateChangelogTitle: settingsTabUpdate.getElementsByClassName('settingsChangelogTitle')[0],
        settingsUpdateChangelogText: settingsTabUpdate.getElementsByClassName('settingsChangelogText')[0],
        settingsUpdateChangelogCont: settingsTabUpdate.getElementsByClassName('settingsChangelogContainer')[0],
        settingsUpdateActionButton: document.getElementById('settingsUpdateActionButton')
    }
}

/**
 * Update the properties of the update action button.
 *
 * @param {string} text The new button text.
 * @param {boolean} disabled Optional. Disable or enable the button
 * @param {function} handler Optional. New button event handler.
 */
export function settingsUpdateButtonStatus(text, disabled = false, handler = null) {
    const els = getUpdateTabElements()
    if (!els || !els.settingsUpdateActionButton) {
        console.warn('[Settings] settingsUpdateButtonStatus: elements not found!', !!els, !!els?.settingsUpdateActionButton)
        return
    }

    console.log('[Settings] settingsUpdateButtonStatus updating button text to:', text, 'disabled:', disabled, 'hasHandler:', !!handler)
    els.settingsUpdateActionButton.innerHTML = text
    els.settingsUpdateActionButton.disabled = disabled
    if (handler != null) {
        els.settingsUpdateActionButton.onclick = handler
    }
}

export function populateSettingsUpdateInformation(data) {
    const els = getUpdateTabElements()
    if (!els) return

    if (data != null) {
        els.settingsUpdateTitle.innerHTML = isPrerelease(data.version) ? 'Новая предрелизная версия' : 'Новое обновление'
        els.settingsUpdateChangelogCont.style.display = null
        els.settingsUpdateChangelogTitle.innerHTML = data.releaseName
        els.settingsUpdateChangelogText.innerHTML = data.releaseNotes
        populateVersionInformation(data.version, els.settingsUpdateVersionValue, els.settingsUpdateVersionTitle, els.settingsUpdateVersionCheck)

        if (process.platform === 'darwin') {
            settingsUpdateButtonStatus('Скачать обновление', false, () => {
                shell.openExternal(data.darwindownload)
            })
        } else {
            settingsUpdateButtonStatus('Скачивание...', true)
        }
    } else {
        els.settingsUpdateTitle.innerHTML = Lang.queryJS('settings.updates.latestVersionTitle') || 'Новейшая версия'
        els.settingsUpdateChangelogCont.style.display = 'none'
        populateVersionInformation(window.appVersion, els.settingsUpdateVersionValue, els.settingsUpdateVersionTitle, els.settingsUpdateVersionCheck)
        settingsUpdateButtonStatus('Проверить обновления', false, () => {
            const _isDev = window.isDev || false
            if (!_isDev) {
                ipcRenderer.send('autoUpdateAction', 'checkForUpdate', ConfigManager.getAllowPrerelease())
                settingsUpdateButtonStatus('Проверка...', true)

                // Safety timeout: reset button if no response within 15 seconds
                if (window._updateCheckTimeout) clearTimeout(window._updateCheckTimeout)
                window._updateCheckTimeout = setTimeout(() => {
                    const els = getUpdateTabElements()
                    if (els && els.settingsUpdateActionButton && els.settingsUpdateActionButton.innerHTML === Lang.queryJS('settings.updates.checkingForUpdatesButton')) {
                        console.warn('[Settings] Update check timed out.')
                        settingsUpdateButtonStatus(Lang.queryJS('settings.updates.checkForUpdatesButton'), false)
                    }
                }, 15000)
            } else {
                console.log('Update check skipped in dev mode.')
                settingsUpdateButtonStatus('Dev Mode: No Updates', true)
                setTimeout(() => settingsUpdateButtonStatus('Проверить обновления', false), 2000)
            }
        })
    }
}

/**
 * Prepare update tab for display.
 *
 * @param {Object} data The update data.
 */
export function prepareUpdateTab(data = null) {
    populateSettingsUpdateInformation(data)
}

/**
 * Settings preparation functions.
 */

/**
  * Prepare the entire settings UI.
  *
  * @param {boolean} first Whether or not it is the first load.
  */
export async function prepareSettings(first = false) {
    console.log('[Settings] prepareSettings starting (first:', first, ')')
    try {
        if (first) {
            console.log('[Settings] First load: setup tabs, validators, and update tab.')
            try { setupSettingsTabs() } catch (e) { console.error('Failed to setup settings tabs:', e) }
            try { initSettingsValidators() } catch (e) { console.error('Failed to init settings validators:', e) }
            try { prepareUpdateTab() } catch (e) { console.error('Failed to prepare update tab:', e) }
        }

        console.log('[Settings] Preparing tabs...')
        try { await prepareModsTab() } catch (e) { console.error('Failed to prepare mods tab:', e) }
        try { await initSettingsValues() } catch (e) { console.error('Failed to init settings values:', e) }
        try { prepareAccountsTab() } catch (e) { console.error('Failed to prepare accounts tab:', e) }
        try { await prepareJavaTab() } catch (e) { console.error('Failed to prepare java tab:', e) }
        try { prepareAboutTab() } catch (e) { console.error('Failed to prepare about tab:', e) }
        try { bindP2PInfoButton() } catch (e) { console.error('Failed to bind P2P info button:', e) }
        try { bindP2PStatsButton() } catch (e) { console.error('Failed to bind P2P stats button:', e) }
        try { bindRefreshButtons() } catch (e) { console.error('Failed to bind Refresh buttons:', e) }

        console.log('[Settings] prepareSettings complete.')
    } catch (err) {
        console.error('[Settings] Critical error in prepareSettings:', err)
    }
}

let isResetting = false
window.isResetting = false
window.prepareSettings = prepareSettings

/**
 * Bind Factory Reset Buttons
 */
export function bindFactoryReset() {
    const btn = document.getElementById('settingsFactoryResetButton')
    if (btn) {
        btn.onclick = () => {
            if (isResetting) return
            setOverlayContent(
                Lang.query('ejs.settings.factoryReset.confirmTitle'),
                Lang.query('ejs.settings.factoryReset.confirmDesc'),
                Lang.query('ejs.settings.factoryReset.confirmButton'),
                Lang.query('ejs.settings.factoryReset.cancelButton')
            )
            setOverlayHandler(() => {
                factoryReset()
            })
            setMiddleButtonHandler(() => {
                toggleOverlay(false)
            })
            toggleOverlay(true)
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    bindFactoryReset()
})

async function factoryReset() {
    isResetting = true
    window.isResetting = true
    const dataDir = ConfigManager.getDataDirectory()

    // Whitelist of files/folders to KEEP.
    const whitelist = [
        'options.txt',
        'optionsof.txt',
        'servers.dat',
        'servers.dat_old',
        'usercache.json',
        'launcher_profiles.json',
        'saves',
        'screenshots',
        'resourcepacks',
        'shaderpacks',
        'logs',
        'schematics'
    ]

    try {
        const files = await fs.readdir(dataDir)

        // Show loading
        setOverlayContent(
            Lang.query('ejs.settings.factoryReset.title'),
            'Очистка файлов лаунчера... Пожалуйста, подождите.',
            '',
            null,
            null
        )
        toggleOverlay(true)

        // Wait a bit for overlay to show
        await new Promise(resolve => setTimeout(resolve, 150))

        // Disable ConfigManager saving during reset
        if (ConfigManager.setSaveEnabled) {
            ConfigManager.setSaveEnabled(false)
        }

        // Start deletion loop
        for (const file of files) {
            if (whitelist.includes(file)) {
                continue
            }

            const fullPath = sysPath.join(dataDir, file)
            try {
                const stat = await fs.stat(fullPath)
                // Robust check for directory
                let isDir = false
                if (stat && typeof stat.isDirectory === 'function') {
                    isDir = stat.isDirectory()
                } else if (stat && typeof stat.isDirectory === 'boolean') {
                    isDir = stat.isDirectory
                } else if (stat && stat.mode) {
                    isDir = (stat.mode & 0o040000) !== 0
                }

                if (isDir) {
                    if (typeof fs.rm === 'function') {
                        await fs.rm(fullPath, { recursive: true, force: true })
                    } else {
                        await fs.rmdir(fullPath, { recursive: true })
                    }
                } else {
                    await fs.unlink(fullPath)
                }
                // Deleted
            } catch (err) {
                console.warn('Factory Reset: Failed to delete', fullPath, err)
            }
        }

        // Loop finished

        const successTitle = Lang.queryEJS('settings.factoryReset.title') || 'Сброс завершен'
        const successDesc = Lang.queryEJS('settings.factoryReset.success') || 'Лаунчер будет перезапущен.'

        // Success & Restart
        setOverlayContent(
            successTitle,
            successDesc,
            'Перезапустить',
            null,
            null
        )

        setOverlayHandler(() => {
            const ackBtn = document.getElementById('overlayAcknowledge')
            if (ackBtn) {
                ackBtn.style.backgroundColor = '#ff4444'
                ackBtn.innerHTML = 'Перезапуск...'
            }
            ipcRenderer.send('app:restart')
        })

        // Re-toggle overlay to ensure it's on top and visible
        toggleOverlay(true)

    } catch (err) {
        isResetting = false
        window.isResetting = false
        console.error('Factory Reset Error', err)
        setOverlayContent(
            Lang.query('ejs.settings.factoryReset.title'),
            Lang.query('ejs.settings.factoryReset.failed', { error: err.message }),
            Lang.queryJS('settings.msftLogin.okButton')
        )
        setOverlayHandler(() => {
            toggleOverlay(false)
        })
    }
}

// Prepare the settings UI on startup.
//prepareSettings(true)

// FIX: Ensure accounts are populated if settings.js loads after uibinder's init
if (document.readyState === 'interactive' || document.readyState === 'complete') {
    bindSettingsSelect()
    bindFileSelectors()
    bindFactoryReset()
    if (typeof prepareAccountsTab === 'function') {
        prepareAccountsTab()
    }
}
