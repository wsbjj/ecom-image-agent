import { app, BrowserWindow } from 'electron'
import * as path from 'node:path'
import { runMigrations } from './db/client'
import { registerAgentHandlers, cleanupAgentHandlers } from './ipc/agent.handler'
import { registerTaskHandlers } from './ipc/task.handler'
import { registerConfigHandlers } from './ipc/config.handler'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    titleBarStyle: 'hiddenInset',
    show: false,
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  registerAgentHandlers(mainWindow)
  registerTaskHandlers()
  registerConfigHandlers()

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app
  .whenReady()
  .then(async () => {
    await runMigrations()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
  .catch((error: unknown) => {
    console.error('[Main] Failed to initialize app', error)
    app.quit()
  })

app.on('window-all-closed', () => {
  cleanupAgentHandlers()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
