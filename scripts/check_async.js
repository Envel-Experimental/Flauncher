const fs = require('fs');
const path = require('path');

const ASYNC_FUNCTIONS = [
    'getInstanceDirectory',
    'getCommonDirectory',
    'getLauncherDirectory',
    'ConfigManager.save',
    'ConfigManager.load',
    'DistroAPI.init',
    'DistroAPI.getDistribution',
    'ipcRenderer.invoke',
    'window.HeliosAPI.ipc.invoke'
];

const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', 'libraries', 'coverage'];
const INCLUDE_EXTS = ['.js', '.jsx', '.ts', '.tsx'];

let errorCount = 0;

function checkFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Skip comments and strings (basic check)
        if (line.trim().startsWith('//') || line.trim().startsWith('/*') || line.trim().startsWith('*')) continue;

        for (const fn of ASYNC_FUNCTIONS) {
            // Check if the line contains the function name
            if (line.includes(fn.split('.').pop())) {
                // If it already has await on the line, assume it's fine for now (simplification)
                if (line.includes('await ') || line.includes('yield ') || line.includes('.then(') || line.includes('return ')) {
                    continue;
                }

                // Match function call: fn(...) or Object.fn(...)
                // Must be followed by (
                const parts = fn.split('.');
                const lastPart = parts[parts.length - 1];
                const escapedFn = fn.replace(/\./g, '\\.');
                
                // Regex to find the function call
                const regex = new RegExp(`\\b${escapedFn}\\s*\\(`, 'g');
                
                if (regex.test(line)) {
                    // Additional check: if it's an assignment to a promise, it might be fine
                    if (line.includes('Promise') || line.includes('promise')) continue;
                    // If the line ends with a comma, it's likely an object property returning a promise (common in bridges)
                    if (line.trim().endsWith(',')) continue;
                    // If it's an arrow function directly returning the call: (args) => fn(args)
                    if (line.includes('=>')) continue;
                    
                    console.error(`[ASYNC ERROR] Potential missing await for "${fn}" at ${filePath}:${i + 1}`);
                    console.error(`  > ${line.trim()}`);
                    errorCount++;
                }
            }
        }
    }
}

function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const stat = fs.statSync(dir);
    if (stat.isDirectory()) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (!IGNORE_DIRS.includes(file)) {
                walk(fullPath);
            }
        }
    } else if (INCLUDE_EXTS.includes(path.extname(dir))) {
        checkFile(dir);
    }
}

console.log('Starting async call check...');
walk('./app');
walk('./network');
walk('./index.js');

if (errorCount > 0) {
    console.log(`\nFound ${errorCount} potential async errors.`);
    process.exit(1);
} else {
    console.log('\nNo async errors found.');
    process.exit(0);
}
