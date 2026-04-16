import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

const { mockBuildFromTemplate, mockSetApplicationMenu } = vi.hoisted(() => ({
  mockBuildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => ({ template })),
  mockSetApplicationMenu: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getPreferredSystemLanguages: vi.fn(() => []),
    getLocale: vi.fn(() => 'en-US'),
    name: 'Ecom Image Agent',
  },
  Menu: {
    buildFromTemplate: mockBuildFromTemplate,
    setApplicationMenu: mockSetApplicationMenu,
  },
}))

import { buildMenuTemplate, resolveAppLocale, setupNativeShellUI } from '../../../src/main/ui/native-shell'

function getTopLabels(template: MenuItemConstructorOptions[]): string[] {
  return template
    .map((item) => (typeof item.label === 'string' ? item.label : null))
    .filter((label): label is string => label !== null)
}

function getSubmenuLabels(menu: MenuItemConstructorOptions): string[] {
  const submenu = Array.isArray(menu.submenu) ? menu.submenu : []
  return submenu
    .map((item) => (typeof item.label === 'string' ? item.label : null))
    .filter((label): label is string => label !== null)
}

describe('resolveAppLocale', () => {
  it('returns zh-CN when preferred language contains zh-CN', () => {
    expect(resolveAppLocale({ preferredSystemLanguages: ['zh-CN'] })).toBe('zh-CN')
  })

  it('returns zh-CN when preferred language contains zh-Hans', () => {
    expect(resolveAppLocale({ preferredSystemLanguages: ['zh-Hans'] })).toBe('zh-CN')
  })

  it('returns en-US when preferred languages are non-Chinese', () => {
    expect(resolveAppLocale({ preferredSystemLanguages: ['en-US'], localeFallback: 'en-US' })).toBe('en-US')
  })

  it('falls back to locale when preferred list is empty', () => {
    expect(resolveAppLocale({ preferredSystemLanguages: [], localeFallback: 'zh-CN' })).toBe('zh-CN')
  })

  it('defaults to en-US when no locale information exists', () => {
    expect(resolveAppLocale({ preferredSystemLanguages: [], localeFallback: '' })).toBe('en-US')
  })
})

describe('buildMenuTemplate', () => {
  it('builds zh-CN top-level labels for win32', () => {
    const template = buildMenuTemplate('zh-CN', 'win32', { appName: 'Ecom Image Agent' })
    expect(getTopLabels(template)).toEqual(['文件', '编辑', '视图', '窗口', '帮助'])
  })

  it('builds zh-CN top-level labels for darwin with app menu', () => {
    const template = buildMenuTemplate('zh-CN', 'darwin', { appName: 'Ecom Image Agent' })
    expect(getTopLabels(template)).toEqual(['Ecom Image Agent', '文件', '编辑', '视图', '窗口', '帮助'])
  })

  it('builds en-US top-level labels for linux', () => {
    const template = buildMenuTemplate('en-US', 'linux', { appName: 'Ecom Image Agent' })
    expect(getTopLabels(template)).toEqual(['File', 'Edit', 'View', 'Window', 'Help'])
  })

  it('contains key zh-CN submenu labels', () => {
    const template = buildMenuTemplate('zh-CN', 'win32', { appName: 'Ecom Image Agent' })
    const fileMenu = template.find((item) => item.label === '文件')
    const viewMenu = template.find((item) => item.label === '视图')

    expect(fileMenu).toBeDefined()
    expect(viewMenu).toBeDefined()
    expect(getSubmenuLabels(fileMenu as MenuItemConstructorOptions)).toContain('退出')
    expect(getSubmenuLabels(viewMenu as MenuItemConstructorOptions)).toContain('切换开发者工具')
  })

  it('contains key en-US submenu labels', () => {
    const template = buildMenuTemplate('en-US', 'win32', { appName: 'Ecom Image Agent' })
    const fileMenu = template.find((item) => item.label === 'File')
    const viewMenu = template.find((item) => item.label === 'View')

    expect(fileMenu).toBeDefined()
    expect(viewMenu).toBeDefined()
    expect(getSubmenuLabels(fileMenu as MenuItemConstructorOptions)).toContain('Quit')
    expect(getSubmenuLabels(viewMenu as MenuItemConstructorOptions)).toContain('Toggle Developer Tools')
  })
})

describe('setupNativeShellUI', () => {
  beforeEach(() => {
    mockBuildFromTemplate.mockClear()
    mockSetApplicationMenu.mockClear()
  })

  it('builds and sets application menu with resolved locale', () => {
    const locale = setupNativeShellUI({
      preferredSystemLanguages: ['zh-CN'],
      platform: 'linux',
      appName: 'Ecom Image Agent',
    })

    expect(locale).toBe('zh-CN')
    expect(mockBuildFromTemplate).toHaveBeenCalledTimes(1)
    expect(mockSetApplicationMenu).toHaveBeenCalledTimes(1)

    const [template] = mockBuildFromTemplate.mock.calls[0] as [MenuItemConstructorOptions[]]
    expect(getTopLabels(template)).toEqual(['文件', '编辑', '视图', '窗口', '帮助'])
  })
})
