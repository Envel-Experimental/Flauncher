const Sentry = require('@sentry/electron/main')

class SentryService {
    init() {
        if (this.initialized) return
        this.initialized = true

        const { app } = require('electron')
        const isProd = app.isPackaged || process.env.NODE_ENV === 'production'

        if (app.isReady()) {
            console.warn('[SentryService] Sentry was initialized AFTER app ready. This is not recommended.')
        }

        try {
            let release = undefined
            try {
                const versionData = require('../assets/version.json')
                release = versionData.release
            } catch (e) {
                // Fallback if version.json is missing (e.g. dev without bundle)
            }

            Sentry.init({
                dsn: 'https://f02442d2a0733ac2c810b8d8d7f4a21e@o4508545424359424.ingest.de.sentry.io/4508545432027216',
                enabled: isProd,
                release: release,
                beforeSend(event, hint) {
                    const error = hint.originalException
                    const message = (error && error.message) || event.message || ''
                    const code = (error && error.code) || ''
                    
                    if (typeof message === 'string') {
                        if (
                            message.includes('is not signed by the application owner') ||
                            message.includes('fs:statfs') ||
                            message.includes('ERR_CONNECTION_RESET') ||
                            message.includes('ENOSPC') ||
                            message.includes('EPERM') ||
                            message.includes('EBUSY') ||
                            message.includes('No distribution file found') ||
                            code === 'EPERM' ||
                            code === 'EBUSY' ||
                            code === 'ENOSPC'
                        ) {
                            return null
                        }
                    }

                    // Sanitize huge error messages to prevent them from becoming massive titles
                    if (event.exception && event.exception.values && event.exception.values.length > 0) {
                        for (let ex of event.exception.values) {
                            if (ex.value && typeof ex.value === 'string') {
                                let cleanValue = ex.value
                                if (cleanValue.includes('Require stack:')) cleanValue = cleanValue.split('Require stack:')[0]
                                if (cleanValue.includes('--- Log Tail ---')) cleanValue = cleanValue.split('--- Log Tail ---')[0]
                                if (cleanValue.includes('\n')) cleanValue = cleanValue.split('\n')[0]
                                cleanValue = cleanValue.trim()
                                if (cleanValue.length > 150) cleanValue = cleanValue.substring(0, 150) + '...'
                                ex.value = cleanValue
                            }
                        }
                    }
                    if (event.message && typeof event.message === 'string') {
                        let cleanMessage = event.message
                        if (cleanMessage.includes('Require stack:')) cleanMessage = cleanMessage.split('Require stack:')[0]
                        if (cleanMessage.includes('--- Log Tail ---')) cleanMessage = cleanMessage.split('--- Log Tail ---')[0]
                        if (cleanMessage.includes('\n')) cleanMessage = cleanMessage.split('\n')[0]
                        cleanMessage = cleanMessage.trim()
                        if (cleanMessage.length > 150) cleanMessage = cleanMessage.substring(0, 150) + '...'
                        event.message = cleanMessage
                    }

                    // Duplicate Sentry events to FortenLog (Client DSN)
                    try {
                        const eventStr = JSON.stringify(event)
                        const envelopeHeader = JSON.stringify({
                            event_id: event.event_id,
                            sent_at: new Date().toISOString()
                        })
                        const itemHeader = JSON.stringify({
                            type: 'event',
                            length: Buffer.byteLength(eventStr, 'utf8')
                        })
                        const envelope = `${envelopeHeader}\n${itemHeader}\n${eventStr}`

                        fetch('https://fortenlog.nikita.best/api/flauncher/envelope/', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-sentry-envelope',
                                'X-Sentry-Auth': 'Sentry sentry_version=7, sentry_key=fl_d11d7795cb144b569026b61f6f22bf1c'
                            },
                            body: envelope
                        }).catch(err => {
                            if (!isProd) {
                                console.error('[SentryService] Failed to duplicate event to FortenLog:', err)
                            }
                        })
                    } catch (err) {
                        if (!isProd) {
                            console.error('[SentryService] Error triggering duplicate event fetch:', err)
                        }
                    }

                    return event
                },
                beforeBreadcrumb(breadcrumb) {
                    if (breadcrumb.category === 'console' && breadcrumb.level === 'error') {
                        const message = breadcrumb.message || ''
                        if (message.includes('is not signed by the application owner')) {
                            return null
                        }
                    }
                    return breadcrumb
                }
            })
        } catch (e) {
            console.error('[SentryService] Failed to initialize Sentry:', e)
        }
    }

    captureMessage(message, level = 'info') {
        Sentry.captureMessage(message, level)
    }

    captureException(error) {
        if (typeof error === 'string') {
            let messagePart = error
            let logTailPart = ''
            
            if (error.includes('\n\n--- Log Tail ---\n')) {
                const parts = error.split('\n\n--- Log Tail ---\n')
                messagePart = parts[0]
                logTailPart = parts[1]
            }

            if (messagePart.includes('\n') && messagePart.includes('at ')) {
                const firstLine = messagePart.split('\n')[0]
                const msg = firstLine.replace(/^[a-zA-Z_$][a-zA-Z0-9_$]*Error:\s*/, '')
                const reconstructedError = new Error(msg)
                reconstructedError.stack = error
                
                const match = firstLine.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*Error):/)
                if (match) {
                    reconstructedError.name = match[1]
                }
                
                Sentry.captureException(reconstructedError)
                return
            } else {
                const reconstructedError = new Error(messagePart)
                if (logTailPart) {
                    reconstructedError.stack = error
                }
                Sentry.captureException(reconstructedError)
                return
            }
        }
        Sentry.captureException(error)
    }
}

module.exports = new SentryService()
