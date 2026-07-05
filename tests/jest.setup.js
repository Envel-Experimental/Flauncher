jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => require('path').join(__dirname, '..', 'test-data')),
    getVersion: jest.fn(() => '1.0.0'),
  },
  ipcRenderer: {
    send: jest.fn(),
    on: jest.fn(),
    invoke: jest.fn(),
  },
  contextBridge: {
    exposeInMainWorld: jest.fn(),
  },
  shell: {
    openExternal: jest.fn(),
  },
  ipcMain: {
    on: jest.fn(),
    handle: jest.fn(),
    emit: jest.fn(),
    removeListener: jest.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: jest.fn().mockReturnValue(true),
    encryptString: jest.fn((s) => Buffer.from(s, 'utf8')),
    decryptString: jest.fn((b) => b.toString('utf8')),
  },
}));

jest.mock('@electron/remote', () => ({
  app: {
    getPath: jest.fn(() => require('path').join(__dirname, '..', 'test-data')),
  },
}), { virtual: true });

jest.mock('@sentry/electron/main', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}), { virtual: true });

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}), { virtual: true });

jest.mock('os', () => ({
  hostname: () => 'test-hostname',
  userInfo: () => ({ username: 'test-user' }),
  totalmem: () => 16 * 1024 * 1024 * 1024,
  freemem: () => 8 * 1024 * 1024 * 1024,
  cpus: () => [{}, {}, {}, {}],
  loadavg: () => [0.1, 0.2, 0.5],
  tmpdir: () => require('path').join(__dirname, '..', 'test-data', 'temp'),
  platform: jest.fn().mockReturnValue('win32'),
  arch: () => 'x64',
  homedir: () => require('path').join(__dirname, '..', 'test-data'),
  release: () => '10.0.19041',
  type: () => 'Windows_NT',
  endianness: () => 'LE',
  networkInterfaces: () => ({})
}));

const originalFetch = global.fetch;

global.fetch = jest.fn().mockImplementation((url, options) => {
  const urlStr = typeof url === 'string' ? url : (url && url.toString ? url.toString() : '');
  if (urlStr.includes('fortenlog.nikita.best') || urlStr.includes('posthog.com')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
    });
  }
  if (originalFetch) {
    return originalFetch(url, options);
  }
  return Promise.reject(new Error(`Fetch to ${urlStr} not mocked and no original fetch found`));
});

