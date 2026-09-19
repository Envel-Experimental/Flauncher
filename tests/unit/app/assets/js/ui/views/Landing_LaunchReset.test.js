/**
 * @jest-environment jsdom
 */

describe('Launch UI Reset and Watchdog Tests', () => {
    let originalToggleLaunchArea
    let originalSetLaunchDetails
    let originalHeliosAPI

    beforeEach(() => {
        jest.useFakeTimers()

        document.body.innerHTML = `
            <div id="lower">
                <div id="left"><div id="content"></div></div>
                <div id="center"><div id="content"></div></div>
                <div id="right"><div id="launch_content"><button id="launch_button">ИГРАТЬ</button></div></div>
            </div>
            <div id="launch_details" style="display: none;">
                <span id="launch_details_text"></span>
                <progress id="launch_progress" value="0" max="100"></progress>
                <span id="launch_progress_label">0%</span>
            </div>
        `

        window.onReactLaunchDetails = jest.fn()
        window.onReactLaunchPercentage = jest.fn()
        window.onReactLaunchComplete = jest.fn()

        originalHeliosAPI = window.HeliosAPI
        window.HeliosAPI = {
            launcher: {
                launch: jest.fn(),
                onLog: jest.fn(),
                onLogError: jest.fn(),
                onExit: jest.fn(),
                terminate: jest.fn()
            }
        }

        const landing = require('@ui/views/landing.js')
        originalToggleLaunchArea = landing.toggleLaunchArea
        originalSetLaunchDetails = landing.setLaunchDetails
    })

    afterEach(() => {
        jest.runOnlyPendingTimers()
        jest.useRealTimers()
        window.HeliosAPI = originalHeliosAPI
    })

    test('toggleLaunchArea(false) clears launch_details_text and notifies React', () => {
        const detailsText = document.getElementById('launch_details_text')
        detailsText.innerHTML = 'Запуск игры...'

        originalToggleLaunchArea(false)

        expect(detailsText.innerHTML).toBe('')
        expect(window.onReactLaunchComplete).toHaveBeenCalledTimes(1)
        expect(document.getElementById('launch_details').style.display).toBe('none')
        expect(document.getElementById('lower').style.display).toBe('flex')
    })

    test('toggleLaunchArea(true) sets launch_details display to flex and hides lower contents', () => {
        originalToggleLaunchArea(true)

        expect(document.getElementById('launch_details').style.display).toBe('flex')
        expect(document.querySelector('#lower > #left #content').style.display).toBe('none')
        expect(document.querySelector('#lower > #center #content').style.display).toBe('none')
        expect(document.querySelector('#lower > #right #launch_content').style.display).toBe('none')
    })

    test('setLaunchDetails updates DOM and calls window.onReactLaunchDetails', () => {
        originalSetLaunchDetails('Загрузка модов...')

        const detailsText = document.getElementById('launch_details_text')
        expect(detailsText.innerHTML).toBe('Загрузка модов...')
        expect(window.onReactLaunchDetails).toHaveBeenCalledWith('Загрузка модов...')
    })

    test('onExit callback cleans up launch details and resets launch UI', () => {
        let exitCallback = null
        window.HeliosAPI.launcher.onExit.mockImplementation((cb) => {
            exitCallback = cb
        })

        const detailsText = document.getElementById('launch_details_text')
        originalSetLaunchDetails('Запуск игры...')
        expect(detailsText.innerHTML).toBe('Запуск игры...')

        // Simulate onExit trigger
        originalSetLaunchDetails('')
        originalToggleLaunchArea(false)

        expect(detailsText.innerHTML).toBe('')
        expect(window.onReactLaunchComplete).toHaveBeenCalled()
    })
})
