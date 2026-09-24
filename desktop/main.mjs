import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes('--smoke');
const APP_ID = 'com.progoswa.contestadorautomatico';
const APP_NAME = 'Contestador Automatico';

// Nombre fijo de la app: determina la carpeta de datos (%APPDATA%\Contestador Automatico).
app.setName(APP_NAME);

let mainWindow = null;
let tray = null;
let quitting = false;
let shutdownDone = false;
let botStopped = false;

// Una sola instancia: si se abre de nuevo, se enfoca la ventana existente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(init).catch((error) => {
    dialog.showErrorBox('Error al iniciar la app', String(error?.stack ?? error));
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    // No cerrar: la app sigue en la bandeja para que el bot siga respondiendo.
  });

  app.on('before-quit', (event) => {
    quitting = true;
    if (shutdownDone) return;
    event.preventDefault();
    stopBot().finally(() => {
      shutdownDone = true;
      app.quit();
    });
  });
}

async function init() {
  app.setAppUserModelId(APP_ID);
  // Sin menú nativo: la clienta no necesita opciones de Electron.
  Menu.setApplicationMenu(null);

  // Datos y secretos en %APPDATA%: sobreviven a las actualizaciones de la app.
  process.env.DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';
  process.env.SESSION_SECRET = await loadOrCreateSecret();

  let serverPort;
  try {
    const { serverReady } = await import(pathToFileURL(path.join(__dirname, '..', 'server.js')).href);
    serverPort = await serverReady;
  } catch (error) {
    dialog.showErrorBox(
      'No se pudo iniciar el servidor',
      `La app no pudo arrancar.\n\n${String(error?.stack ?? error)}`,
    );
    app.exit(1);
    return;
  }

  if (SMOKE) {
    console.log(`SMOKE OK: servidor en http://127.0.0.1:${serverPort}`);
    await stopBot();
    app.exit(0);
    return;
  }

  createWindow(serverPort);
  createTray();
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f1f5f9',
    title: 'Contestador Automático',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // En desarrollo se pueden abrir las herramientas; en la app instalada, no.
      devTools: !app.isPackaged,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Cerrar la ventana la oculta; el bot sigue activo en la bandeja.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Contestador Automático');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir panel', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Salir', click: () => app.quit() },
    ]),
  );
  tray.on('double-click', () => showWindow());
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Secreto de sesión persistente para que las cookies del panel sigan válidas al reiniciar.
async function loadOrCreateSecret() {
  const secretPath = path.join(app.getPath('userData'), 'session-secret');
  try {
    const existing = (await fs.readFile(secretPath, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* Primera ejecución: se genera abajo. */
  }
  const secret = randomBytes(32).toString('hex');
  await fs.mkdir(path.dirname(secretPath), { recursive: true });
  await fs.writeFile(secretPath, secret, { mode: 0o600 });
  return secret;
}

// Detiene las cuentas de WhatsApp antes de cerrar.
async function stopBot() {
  if (botStopped) return;
  botStopped = true;
  try {
    const { stopAllAccounts } = await import(pathToFileURL(path.join(__dirname, '..', 'bot.js')).href);
    await stopAllAccounts();
  } catch {
    /* La app se está cerrando: no bloquear por esto. */
  }
}
