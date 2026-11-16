function getMojangOS() {
    const opSys = process.platform;
    switch (opSys) {
        case 'darwin':
            return 'osx';
        case 'win32':
            return 'windows';
        case 'linux':
            return 'linux';
        default:
            return opSys;
    }
}

const os = require('os')

function validateLibraryRules(rules) {
    if (rules == null) return false
    if (rules.length === 0) return true

    // Mojang spec: if there are rules, the initial state is 'false' if there is an 'allow' rule,
    // but if there are only 'disallow' rules, it effectively starts as 'true'.
    let allowed = !rules.some(r => r.action === 'allow')

    for (const rule of rules) {
        let match = true
        if (rule.os != null) {
            if (rule.os.name && rule.os.name !== getMojangOS()) match = false
            if (rule.os.arch && rule.os.arch !== process.arch) {
                // Support aarch64 synonym for arm64
                if (!(rule.os.arch === 'aarch64' && process.arch === 'arm64')) {
                    match = false
                }
            }
            if (rule.os.version && !new RegExp(rule.os.version).test(os.release())) {
                match = false
            }
        }
        
        if (match) {
            allowed = (rule.action === 'allow')
        }
    }
    return allowed
}

function validateLibraryNatives(natives) {
    return natives == null ? true : Object.prototype.hasOwnProperty.call(natives, getMojangOS());
}

function isLibraryCompatible(rules, natives, name = null) {
    if (name && name.includes(':natives-')) {
        const regex = /.+:natives-([^-]+)(?:-(.+))?/.exec(name);
        if (regex) {
            const osName = regex[1];
            const arch = regex[2] ?? 'x64';
            const currentMojangOS = getMojangOS();
            const osMatches = osName === currentMojangOS || 
                (osName === 'osx' && currentMojangOS === 'osx') ||
                (osName === 'macos' && currentMojangOS === 'osx') ||
                (osName === 'windows' && currentMojangOS === 'windows') ||
                (osName === 'linux' && currentMojangOS === 'linux');
            if (!osMatches) return false;
            const currentArch = process.arch;
            const archMatches = arch === currentArch || (arch === 'aarch64' && currentArch === 'arm64');
            if (!archMatches) return false;
        }
    }
    if (rules == null && natives == null) return true;
    if (rules != null) return validateLibraryRules(rules);
    return validateLibraryNatives(natives);
}

function mcVersionAtLeast(desired, actual) {
    if (!desired || !actual) {
        return false;
    }
    const des = desired.split('.');
    const act = actual.split('.');
    if (act.length < des.length) {
        for (let i = act.length; i < des.length; i++) {
            act[i] = '0';
        }
    }
    for (let i = 0; i < des.length; i++) {
        const parsedDesired = parseInt(des[i]);
        const parsedActual = parseInt(act[i]);
        if (parsedActual > parsedDesired) {
            return true;
        }
        else if (parsedActual < parsedDesired) {
            return false;
        }
    }
    return true;
}

module.exports = { getMojangOS, validateLibraryRules, validateLibraryNatives, isLibraryCompatible, mcVersionAtLeast }
