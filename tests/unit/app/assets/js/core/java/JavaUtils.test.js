const JavaUtils = require('../../../../../../../app/assets/js/core/java/JavaUtils')
const path = require('path')

describe('JavaUtils', () => {
    const originalPlatform = process.platform

    afterEach(() => {
        Object.defineProperty(process, 'platform', {
            value: originalPlatform
        })
    })

    const setPlatform = (platform) => {
        Object.defineProperty(process, 'platform', {
            value: platform,
            configurable: true
        })
    }

    describe('javaExecFromRoot', () => {
        it('should return correct path for win32', () => {
            setPlatform('win32')
            const result = JavaUtils.javaExecFromRoot('C:\\java')
            expect(result).toBe(path.join('C:\\java', 'bin', 'javaw.exe'))
        })

        it('should return correct path for darwin', () => {
            setPlatform('darwin')
            const result = JavaUtils.javaExecFromRoot('/Library/Java')
            expect(result).toBe(path.join('/Library/Java', 'Contents', 'Home', 'bin', 'java'))
        })

        it('should return correct path for linux', () => {
            setPlatform('linux')
            const result = JavaUtils.javaExecFromRoot('/usr/lib/java')
            expect(result).toBe(path.join('/usr/lib/java', 'bin', 'java'))
        })

        it('should return rootDir for unknown platform', () => {
            setPlatform('freebsd')
            const result = JavaUtils.javaExecFromRoot('/java')
            expect(result).toBe('/java')
        })
    })

    describe('ensureJavaDirIsRoot', () => {
        it('should strip Contents/Home for darwin', () => {
            setPlatform('darwin')
            const result = JavaUtils.ensureJavaDirIsRoot('/Library/Java/Contents/Home')
            expect(result).toBe('/Library/Java')
        })

        it('should return original dir for darwin if not in Home', () => {
            setPlatform('darwin')
            const result = JavaUtils.ensureJavaDirIsRoot('/Library/Java')
            expect(result).toBe('/Library/Java')
        })

        it('should strip bin/java for linux', () => {
            setPlatform('linux')
            const javaDir = path.normalize('/usr/lib/java')
            const fullPath = path.join(javaDir, 'bin', 'java')
            const result = JavaUtils.ensureJavaDirIsRoot(fullPath)
            expect(result).toBe(javaDir)
        })

        it('should strip bin/javaw.exe for win32', () => {
            setPlatform('win32')
            const javaDir = 'C:\\java'
            const fullPath = path.join(javaDir, 'bin', 'javaw.exe')
            const result = JavaUtils.ensureJavaDirIsRoot(fullPath)
            expect(result).toBe(javaDir)
        })

        it('should return original dir if no bin found', () => {
            setPlatform('linux')
            const result = JavaUtils.ensureJavaDirIsRoot('/usr/lib/java')
            expect(result).toBe('/usr/lib/java')
        })

        it('should handle null and undefined safely', () => {
            expect(JavaUtils.ensureJavaDirIsRoot(null)).toBeNull()
            expect(JavaUtils.ensureJavaDirIsRoot(undefined)).toBeUndefined()
            expect(JavaUtils.ensureJavaDirIsRoot('')).toBe('')
        })
    })
})
