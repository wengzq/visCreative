// Electron main process (RFC 0046): starts or attaches to studiod, runs the web host in this process and shows it in one window.
//   VIS_DATA_DIR      Optional data directory; defaults to the per-user application data directory, or ~/.vis-dev from source
//   VIS_DESKTOP_NODE  Optional Node binary that runs studiod when the app runs from source
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, session, shell, type OpenDialogOptions } from 'electron'
import { PROTOCOL_VERSION } from '@vis/protocol'
import { mergePath, readLoginShellPath } from '../../../runtime/login-shell-path'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { createWebHost, type WebHost } from '../../web/src/host/server'
import { openStudiodLink, type StudiodLink } from '../../web/src/host/studiod-link'
import { startOnStablePort } from './host-port'
import { appLayout } from './layout'
import { desktopMessages } from './messages'
import { navigationTarget, permissionAllowed } from './navigation'
import { ensureStudiod, startStudiodProcess, studiodLogPath, StudiodStartError, type StudiodProbe } from './studiod-process'

const here = fileURLToPath(new URL('.', import.meta.url))
const layout = appLayout({
  packaged: app.isPackaged,
  platform: process.platform,
  env: process.env,
  home: homedir(),
  execPath: process.execPath,
  resourcesPath: process.resourcesPath,
  repoRoot: fileURLToPath(new URL('../../../', import.meta.url)),
})

app.setName('visCreative')
// Chromium's profile lives beside studiod's data instead of sharing its directory; the single-instance lock follows it,
// so there is one app per data directory.
app.setPath('userData', join(layout.dataDir, 'shell'))
// The web host finds built-in fonts through this variable; studiod gets the same value from the layout.
if (layout.studiodEnv.VIS_FONTS_DIR) process.env.VIS_FONTS_DIR = layout.studiodEnv.VIS_FONTS_DIR

const socketPath = studiodEndpoint(layout.dataDir)
const tokenPath = join(layout.dataDir, 'run', 'studiod.token')
let host: WebHost | undefined
let appOrigin = ''
let mainWindow: BrowserWindow | undefined
let watch: StudiodLink | undefined
let studiodPath: string | undefined
let quitting = false
let recovering = false

const probe: StudiodProbe = async () => {
  try {
    const link = await openStudiodLink({ socketPath, tokenPath })
    link.close()
    return link.server
  } catch {
    return undefined
  }
}

async function attachStudiod() {
  const { server } = await ensureStudiod({ probe, start: () => startStudiodProcess(layout, process.env, studiodPath) })
  // RFC 0004: an incompatible studiod only accepts runtime.shutdown. Handing over to the new version arrives with updates (step d1).
  if (server.protocolVersion !== PROTOCOL_VERSION) throw new IncompatibleStudiodError(server.studiodVersion)
}

class IncompatibleStudiodError extends Error {
  constructor(readonly version: string) { super('An incompatible studiod is running') }
}

function describeStartError(error: unknown): string {
  const m = desktopMessages(app.getLocale())
  const log = studiodLogPath(layout.dataDir)
  if (error instanceof IncompatibleStudiodError) return m.incompatibleRunning(error.version)
  if (error instanceof StudiodStartError) return error.reason === 'timeout' ? m.startTimeout(log) : m.startExited(log)
  return error instanceof Error ? error.message : String(error)
}

function fail(error: unknown) {
  quitting = true
  dialog.showErrorBox(desktopMessages(app.getLocale()).startFailedTitle, describeStartError(error))
  app.quit()
}

// While a window is open, hold one connection of our own: when studiod goes away (crash, idle exit raced with a launch),
// start it again so the page's own reconnect finds it. Without a window nothing holds studiod, and it may idle out.
async function watchStudiod() {
  watch?.close()
  watch = undefined
  const recover = () => {
    if (quitting || recovering || !mainWindow) return
    recovering = true
    void attachStudiod().then(watchStudiod).catch(fail).finally(() => { recovering = false })
  }
  try {
    watch = await openStudiodLink({ socketPath, tokenPath, onClose: recover })
  } catch {
    recover()
  }
}

function createWindow() {
  if (!host) return
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'visCreative',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false, preload: join(here, 'preload.cjs') },
  })
  mainWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    mainWindow = undefined
    watch?.close()
    watch = undefined
  })
  void watchStudiod()
  void win.loadURL(host.url)
}

function lockNavigation() {
  // Applies to the main window and to any window the page opens: nothing leaves the host's origin inside the app.
  app.on('web-contents-created', (_event, contents) => {
    const guard = (event: { preventDefault(): void }, url: string) => {
      const target = navigationTarget(url, appOrigin)
      if (target === 'app') return
      event.preventDefault()
      if (target === 'external') void shell.openExternal(url)
    }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', guard)
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      const target = navigationTarget(url, appOrigin)
      if (target === 'external') void shell.openExternal(url)
      // Same-origin links (an asset version opened in a new tab on the web) get a plain window with no preload.
      if (target === 'app') return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } } }
      return { action: 'deny' }
    })
  })
}

// Sessions exist only once the app is ready.
function lockPermissions() {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(permissionAllowed(permission, details.requestingUrl, appOrigin)))
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, appOrigin))
}

function registerFolderPicker() {
  ipcMain.handle('vis:pick-directory', async (event, defaultPath: unknown) => {
    if (navigationTarget(event.senderFrame?.url ?? '', appOrigin) !== 'app') throw new Error('forbidden')
    const options: OpenDialogOptions = {
      title: desktopMessages(app.getLocale()).pickFolder,
      properties: ['openDirectory', 'createDirectory'],
      ...(typeof defaultPath === 'string' && defaultPath ? { defaultPath } : {}),
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    const path = result.canceled ? undefined : result.filePaths[0]
    return path ? { path, cancelled: false } : { cancelled: true }
  })
}

async function start() {
  if (!existsSync(join(layout.staticDir, 'index.html'))) throw new Error(desktopMessages(app.getLocale()).uiMissing)
  // A macOS app opened from Finder has a minimal PATH; Agent CLIs are found through the login shell's (RFC 0046).
  const loginPath = await readLoginShellPath({ platform: process.platform, shell: process.env.SHELL })
  if (loginPath) studiodPath = mergePath(loginPath, process.env.PATH, delimiter)
  await attachStudiod()
  host = await startOnStablePort(join(app.getPath('userData'), 'host-port'), port => createWebHost({ socketPath, tokenPath, staticDir: layout.staticDir, ...(port ? { port } : {}) }))
  appOrigin = new URL(host.url).origin
  lockPermissions()
  createWindow()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return createWindow()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  // macOS keeps the app in the Dock without windows; elsewhere closing the window quits. studiod keeps running either way
  // and exits on its own once idle (RFC 0004).
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('activate', () => { if (!mainWindow) createWindow() })
  app.on('before-quit', () => {
    quitting = true
    watch?.close()
    void host?.close()
  })
  lockNavigation()
  registerFolderPicker()
  void app.whenReady().then(start).catch(fail)
}
