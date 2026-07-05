const fs = require('fs/promises')
const { createReadStream } = require('fs')
const crypto = require('crypto')
const path = require('path')
const { spawn } = require('child_process')

/**
 * Execute a command using spawn.
 * @param {string} cmd Command to run
 * @param {string[]} args Arguments
 * @param {object} options Spawn options
 * @returns {Promise<{stdout: Buffer}>}
 */
async function runCommand(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        const { input, ...spawnOptions } = options;
        const process = spawn(cmd, args, {
            ...spawnOptions,
            shell: false
        });

        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);

        if (input) {
            if (Buffer.isBuffer(input) || typeof input === 'string') {
                process.stdin.write(input);
                process.stdin.end();
            } else if (typeof input.pipe === 'function') {
                input.pipe(process.stdin);
            }
        }

        process.stdout.on('data', (data) => { stdout = Buffer.concat([stdout, data]); });
        process.stderr.on('data', (data) => { stderr = Buffer.concat([stderr, data]); });

        process.on('close', (code) => {
            if (code === 0) resolve({ stdout });
            else reject(new Error(`Command ${cmd} failed with code ${code}: ${stderr.toString()}`));
        });

        process.on('error', (err) => {
            reject(err)
        })
    });
}

async function validateLocalFile(filePath, algo, hash, expectedSize, requireHash = false) {
    if (hash == null) {
        if (requireHash) {
            // console.debug(`[Security] No hash provided for ${filePath}. Skipping validation.`);
            return false;
        }
        
        try {
            const stat = await fs.stat(filePath);
            if (expectedSize && stat.size !== expectedSize) {
                return false;
            }
        } catch (e) {
            return false;
        }
        
        return true;
    }

    try {
        const stat = await fs.stat(filePath);
        if (expectedSize && stat.size !== expectedSize) {
            // console.debug(`[FileUtils] Size mismatch for ${path.basename(filePath)}: Expected ${expectedSize}, Got ${stat.size}`);
            return false;
        }
    } catch (e) {
        return false;
    }

    return new Promise((resolve, reject) => {
        let algorithm;
        try {
            if (typeof algo !== 'string') {
                throw new Error('Algorithm must be a string');
            }
            algorithm = algo.toLowerCase().replace('-', '');
            crypto.createHash(algorithm); // Test if available
        } catch (e) {
            console.error(`[FileUtils] Unsupported or missing hash algorithm: ${algo}`);
            return resolve(false);
        }

        const stream = createReadStream(filePath);
        const hashStream = crypto.createHash(algorithm);

        stream.on('error', err => {
            resolve(false);
        });

        hashStream.on('error', err => {
            resolve(false);
        });

        stream.pipe(hashStream).on('finish', () => {
            const computedHash = hashStream.read().toString('hex');
            const isValid = computedHash === hash.toLowerCase();
            if (!isValid) {
                console.warn(`[FileUtils] Validation Failed for ${filePath}\n  Expected: ${hash}\n  Actual:   ${computedHash}`);
            }
            resolve(isValid);
        });
    });
}

async function safeEnsureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true })
}

function getLibraryDir(commonDir) {
    return path.join(commonDir, 'libraries');
}

function getVersionDir(commonDir) {
    return path.join(commonDir, 'versions');
}

function getVersionJsonPath(commonDir, version) {
    return path.join(getVersionDir(commonDir), version, `${version}.json`);
}

function getVersionJarPath(commonDir, version) {
    return path.join(getVersionDir(commonDir), version, `${version}.jar`);
}

function calculateHashByBuffer(buffer, algo) {
    try {
        if (typeof algo !== 'string') throw new Error('Algorithm must be a string');
        const algorithm = algo.toLowerCase().replace('-', '');
        return crypto.createHash(algorithm).update(buffer).digest('hex');
    } catch (e) {
        console.error(`[FileUtils] Failed to calculate hash: ${e.message}`);
        return null;
    }
}

async function extractZip(archivePath, destDir, onEntry) {
    // Support legacy signature: extractZip(archivePath, onEntry)
    if (typeof destDir === 'function') {
        onEntry = destDir;
        destDir = null;
    }
    if (!destDir) destDir = path.dirname(archivePath);

    const isWin = process.platform === 'win32';

    if (isWin) {
        await safeEnsureDir(destDir);
        const tempName = `temp_extract_${crypto.randomBytes(6).toString('hex')}.zip`;
        const tempPath = path.join(destDir, tempName);
        try {
            await fs.copyFile(archivePath, tempPath);
            await runCommand('tar', ['-xf', tempName], { cwd: destDir });
        } catch (e) {
            console.error('[FileUtils] tar extraction failed:', e.message);
            const psCmd = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
            const encodedCmd = Buffer.from(psCmd, 'utf16le').toString('base64');
            try {
                await runCommand('powershell', ['-NoProfile', '-EncodedCommand', encodedCmd]);
            } catch (psErr) {
                throw new Error(`[FileUtils] Failed to extract zip. Both 'tar' and 'powershell' failed or are unavailable. PowerShell Error: ${psErr.message}`, { cause: psErr });
            }
        } finally {
            try {
                await fs.unlink(tempPath);
            } catch (err) {}
        }
    } else {
        await runCommand('unzip', ['-o', archivePath, '-d', destDir]);
    }

    // Mock 'onEntry' for JavaGuard compatibility
    if (onEntry) {
        let entries = [];
        try {
            if (isWin) {
                const tempName = `temp_list_${crypto.randomBytes(6).toString('hex')}.zip`;
                const tempPath = path.join(destDir, tempName);
                try {
                    await fs.copyFile(archivePath, tempPath);
                    const { stdout } = await runCommand('tar', ['-tf', tempName], { cwd: destDir });
                    entries = stdout.toString().split(/\r?\n/).filter(l => l.trim().length > 0);
                } catch (e) {
                    const psCmd = `
                        Add-Type -AssemblyName System.IO.Compression.FileSystem;
                        [System.IO.Compression.ZipFile]::OpenRead('${archivePath.replace(/'/g, "''")}').Entries | Select-Object -ExpandProperty FullName
                     `;
                    const encodedCmd = Buffer.from(psCmd, 'utf16le').toString('base64');
                    try {
                        const { stdout } = await runCommand('powershell', ['-NoProfile', '-EncodedCommand', encodedCmd]);
                        entries = stdout.toString().split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
                    } catch (psErr) {
                        throw new Error(`[FileUtils] Failed to read zip entries. Both 'tar' and 'powershell' failed or are unavailable. Error: ${psErr.message}`, { cause: psErr });
                    }
                } finally {
                    try {
                        await fs.unlink(tempPath);
                    } catch (err) {}
                }
            } else {
                const { stdout } = await runCommand('unzip', ['-Z1', archivePath]);
                entries = stdout.toString().split('\n').filter(l => l.trim().length > 0);
            }
        } catch (e) {
            console.warn('[FileUtils] Failed to list zip entries, JavaGuard detection might fail.', e);
        }

        const entriesObj = {};
        entries.forEach(name => {
            const n = name.replace(/\\/g, '/');
            if (n) entriesObj[n] = { entryName: n };
        });

        await onEntry({ entries: () => entriesObj });
    }
}

async function extractTarGz(archivePath, onEntry) {
    const destDir = path.dirname(archivePath);
    if (process.platform === 'win32') {
        const tempName = `temp_extract_${crypto.randomBytes(6).toString('hex')}.tar.gz`;
        const tempPath = path.join(destDir, tempName);
        try {
            await fs.copyFile(archivePath, tempPath);
            await runCommand('tar', ['-xzf', tempName], { cwd: destDir });
        } finally {
            try {
                await fs.unlink(tempPath);
            } catch (err) {}
        }
    } else {
        const args = ['-xzf', archivePath, '-C', destDir];
        if (process.platform === 'darwin') {
            args.push('--no-mac-metadata', '--no-xattrs');
        }
        await runCommand('tar', args);
    }

    if (onEntry) {
        let lines;
        if (process.platform === 'win32') {
            const tempName = `temp_list_${crypto.randomBytes(6).toString('hex')}.tar.gz`;
            const tempPath = path.join(destDir, tempName);
            try {
                await fs.copyFile(archivePath, tempPath);
                const { stdout } = await runCommand('tar', ['-tf', tempName], { cwd: destDir });
                lines = stdout.toString().split('\n').filter(l => l.trim().length > 0);
            } finally {
                try {
                    await fs.unlink(tempPath);
                } catch (err) {}
            }
        } else {
            const { stdout } = await runCommand('tar', ['-tf', archivePath]);
            lines = stdout.toString().split('\n').filter(l => l.trim().length > 0);
        }
        await onEntry({ name: lines[0] });
    }
}

async function readFileFromZip(archivePath, entryName) {
    const isWin = process.platform === 'win32';
    const entryPath = entryName.replace(/\\/g, '/');

    if (isWin) {
        const destDir = path.dirname(archivePath);
        const tempName = `temp_read_${crypto.randomBytes(6).toString('hex')}.zip`;
        const tempPath = path.join(destDir, tempName);
        try {
            await fs.copyFile(archivePath, tempPath);
            const { stdout } = await runCommand('tar', ['-xOf', tempName, entryPath], { cwd: destDir });
            return stdout;
        } catch (e) {
            const psCmd = `
                Add-Type -AssemblyName System.IO.Compression.FileSystem;
                $zip = [System.IO.Compression.ZipFile]::OpenRead('${archivePath.replace(/'/g, "''")}');
                $entry = $zip.GetEntry('${entryPath.replace(/'/g, "''")}');
                if ($entry) {
                    $reader = [System.IO.StreamReader]::new($entry.Open());
                    $reader.ReadToEnd();
                }
            `;
            const encodedCmd = Buffer.from(psCmd, 'utf16le').toString('base64');
            try {
                const { stdout } = await runCommand('powershell', ['-NoProfile', '-EncodedCommand', encodedCmd]);
                return typeof stdout === 'string' ? Buffer.from(stdout, 'utf-8') : stdout;
            } catch (psErr) {
                throw new Error(`[FileUtils] Failed to read file from zip. Both 'tar' and 'powershell' failed or are unavailable. Error: ${psErr.message}`, { cause: psErr });
            }
        } finally {
            try {
                await fs.unlink(tempPath);
            } catch (err) {}
        }
    } else {
        const { stdout } = await runCommand('unzip', ['-p', archivePath, entryPath]);
        return stdout;
    }
}

module.exports = { validateLocalFile, safeEnsureDir, getLibraryDir, getVersionDir, getVersionJsonPath, getVersionJarPath, calculateHashByBuffer, extractZip, extractTarGz, readFileFromZip }
