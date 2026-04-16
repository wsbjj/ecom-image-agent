import { app, Menu, type MenuItemConstructorOptions } from 'electron'

export type AppLocale = 'zh-CN' | 'en-US'
export type MenuPlatform = 'darwin' | 'win32' | 'linux'

interface ResolveAppLocaleOptions {
  preferredSystemLanguages?: readonly string[] | null
  localeFallback?: string | null
}

interface BuildMenuTemplateOptions {
  appName?: string
}

interface SetupNativeShellUIOptions extends ResolveAppLocaleOptions {
  locale?: AppLocale
  platform?: MenuPlatform
  appName?: string
}

interface MenuLabels {
  file: string
  edit: string
  view: string
  window: string
  help: string
  about: string
  services: string
  hide: string
  hideOthers: string
  showAll: string
  quit: string
  close: string
  undo: string
  redo: string
  cut: string
  copy: string
  paste: string
  selectAll: string
  reload: string
  forceReload: string
  toggleDevTools: string
  resetZoom: string
  zoomIn: string
  zoomOut: string
  toggleFullscreen: string
  minimize: string
  zoom: string
  bringAllToFront: string
}

const MENU_LABELS: Record<AppLocale, MenuLabels> = {
  'zh-CN': {
    file: '文件',
    edit: '编辑',
    view: '视图',
    window: '窗口',
    help: '帮助',
    about: '关于',
    services: '服务',
    hide: '隐藏',
    hideOthers: '隐藏其他',
    showAll: '全部显示',
    quit: '退出',
    close: '关闭',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    reload: '重新加载',
    forceReload: '强制重新加载',
    toggleDevTools: '切换开发者工具',
    resetZoom: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    toggleFullscreen: '切换全屏',
    minimize: '最小化',
    zoom: '缩放',
    bringAllToFront: '前置全部窗口',
  },
  'en-US': {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    help: 'Help',
    about: 'About',
    services: 'Services',
    hide: 'Hide',
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quit: 'Quit',
    close: 'Close',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    reload: 'Reload',
    forceReload: 'Force Reload',
    toggleDevTools: 'Toggle Developer Tools',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    toggleFullscreen: 'Toggle Full Screen',
    minimize: 'Minimize',
    zoom: 'Zoom',
    bringAllToFront: 'Bring All to Front',
  },
}

const DEFAULT_APP_NAME = 'Ecom Image Agent'

function isChineseLocale(locale: string | null | undefined): boolean {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('zh')
}

function normalizeAppName(appName?: string): string {
  const normalized = appName?.trim()
  return normalized && normalized.length > 0 ? normalized : DEFAULT_APP_NAME
}

function normalizePlatform(platform: string): MenuPlatform {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform
  }
  return 'win32'
}

export function resolveAppLocale(options: ResolveAppLocaleOptions = {}): AppLocale {
  const preferredSystemLanguages =
    options.preferredSystemLanguages ?? app.getPreferredSystemLanguages?.() ?? []

  for (const locale of preferredSystemLanguages) {
    if (isChineseLocale(locale)) {
      return 'zh-CN'
    }
  }

  const localeFallback = options.localeFallback ?? app.getLocale?.() ?? ''
  return isChineseLocale(localeFallback) ? 'zh-CN' : 'en-US'
}

function createMacAppMenu(labels: MenuLabels, appName: string): MenuItemConstructorOptions {
  return {
    label: appName,
    submenu: [
      { label: `${labels.about} ${appName}`, role: 'about' },
      { type: 'separator' },
      { label: labels.services, role: 'services' },
      { type: 'separator' },
      { label: labels.hide, role: 'hide' },
      { label: labels.hideOthers, role: 'hideOthers' },
      { label: labels.showAll, role: 'unhide' },
      { type: 'separator' },
      { label: `${labels.quit} ${appName}`, role: 'quit' },
    ],
  }
}

function createFileMenu(labels: MenuLabels, platform: MenuPlatform): MenuItemConstructorOptions {
  if (platform === 'darwin') {
    return {
      label: labels.file,
      submenu: [{ label: labels.close, role: 'close' }],
    }
  }

  return {
    label: labels.file,
    submenu: [
      { label: labels.close, role: 'close' },
      { type: 'separator' },
      { label: labels.quit, role: 'quit' },
    ],
  }
}

function createEditMenu(labels: MenuLabels): MenuItemConstructorOptions {
  return {
    label: labels.edit,
    submenu: [
      { label: labels.undo, role: 'undo' },
      { label: labels.redo, role: 'redo' },
      { type: 'separator' },
      { label: labels.cut, role: 'cut' },
      { label: labels.copy, role: 'copy' },
      { label: labels.paste, role: 'paste' },
      { label: labels.selectAll, role: 'selectAll' },
    ],
  }
}

function createViewMenu(labels: MenuLabels): MenuItemConstructorOptions {
  return {
    label: labels.view,
    submenu: [
      { label: labels.reload, role: 'reload' },
      { label: labels.forceReload, role: 'forceReload' },
      { label: labels.toggleDevTools, role: 'toggleDevTools' },
      { type: 'separator' },
      { label: labels.resetZoom, role: 'resetZoom' },
      { label: labels.zoomIn, role: 'zoomIn' },
      { label: labels.zoomOut, role: 'zoomOut' },
      { type: 'separator' },
      { label: labels.toggleFullscreen, role: 'togglefullscreen' },
    ],
  }
}

function createWindowMenu(labels: MenuLabels, platform: MenuPlatform): MenuItemConstructorOptions {
  if (platform === 'darwin') {
    return {
      label: labels.window,
      submenu: [
        { label: labels.minimize, role: 'minimize' },
        { label: labels.zoom, role: 'zoom' },
        { type: 'separator' },
        { label: labels.bringAllToFront, role: 'front' },
        { label: labels.close, role: 'close' },
      ],
    }
  }

  return {
    label: labels.window,
    submenu: [
      { label: labels.minimize, role: 'minimize' },
      { label: labels.close, role: 'close' },
    ],
  }
}

function createHelpMenu(labels: MenuLabels, appName: string, platform: MenuPlatform): MenuItemConstructorOptions {
  const submenu: MenuItemConstructorOptions[] = []

  if (platform !== 'darwin') {
    submenu.push({ label: `${labels.about} ${appName}`, enabled: false })
    submenu.push({ type: 'separator' })
  }

  submenu.push({ label: labels.toggleDevTools, role: 'toggleDevTools' })

  return {
    label: labels.help,
    submenu,
  }
}

export function buildMenuTemplate(
  locale: AppLocale,
  platform: MenuPlatform,
  options: BuildMenuTemplateOptions = {},
): MenuItemConstructorOptions[] {
  const labels = MENU_LABELS[locale]
  const appName = normalizeAppName(options.appName)

  const template: MenuItemConstructorOptions[] = []
  if (platform === 'darwin') {
    template.push(createMacAppMenu(labels, appName))
  }

  template.push(createFileMenu(labels, platform))
  template.push(createEditMenu(labels))
  template.push(createViewMenu(labels))
  template.push(createWindowMenu(labels, platform))
  template.push(createHelpMenu(labels, appName, platform))

  return template
}

export function setupNativeShellUI(options: SetupNativeShellUIOptions = {}): AppLocale {
  const locale = options.locale ?? resolveAppLocale(options)
  const platform = normalizePlatform(options.platform ?? process.platform)
  const appName = normalizeAppName(options.appName ?? app.name)

  const template = buildMenuTemplate(locale, platform, { appName })
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)

  return locale
}
