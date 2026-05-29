const path = require('path');
const { app, BrowserWindow } = require('electron');

// Detectar modo de desarrollo explícitamente. Evita abrir DevTools en producción
const isDev = process.env.NODE_ENV === 'development' || process.env.ELECTRON_DEV === '1';
const { startServer } = require('../src/server/app');

app.disableHardwareAcceleration();
app.setPath('userData', path.join(__dirname, '..', 'data', 'electron-user-data'));

let mainWindow;
let serverHandle;

async function createWindow() {
  const serverInfo = await serverHandle;
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1280,
    minHeight: 800,
    show: false,
    backgroundColor: '#0f172a',
    title: 'SISPED SW',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: isDev
    }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  await win.loadURL(`http://127.0.0.1:${serverInfo.port}`);
  // Abrir DevTools automáticamente en entorno de desarrollo para facilitar debugging
  try {
    if (isDev) {
      win.webContents.openDevTools({ mode: 'undocked' });
    }
  } catch (e) { /* ignore if fails */ }
  mainWindow = win;
}

app.whenReady().then(async () => {
  serverHandle = startServer();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch(console.error);
    }
  });
});

app.on('window-all-closed', async () => {
  if (serverHandle) {
    const serverInfo = await serverHandle;
    serverInfo.server.close();
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
