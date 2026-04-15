import '@testing-library/jest-dom/vitest'

// Mock window.api for renderer tests
const mockApi = {
  startTask: vi.fn().mockResolvedValue({ taskId: 'test-task-id' }),
  stopTask: vi.fn().mockResolvedValue({ success: true }),
  queryTasks: vi.fn().mockResolvedValue([]),
  onAgentEvent: vi.fn().mockReturnValue(() => {}),
  saveConfig: vi.fn().mockResolvedValue({ success: true }),
  checkConfig: vi.fn().mockResolvedValue({ exists: false }),
  getConfigValue: vi.fn().mockResolvedValue({ value: null }),
  testAnthropicConnection: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
  testImageProviderConnection: vi.fn().mockResolvedValue({ success: true, message: 'ok', durationMs: 100 }),
  getUserDataPath: vi.fn().mockResolvedValue({ path: 'C:/Users/test/AppData/Roaming/ecom-image-agent' }),
  resolveLocalPath: vi.fn().mockReturnValue(''),
  saveTemplate: vi.fn().mockResolvedValue({ success: true }),
  listTemplates: vi.fn().mockResolvedValue([]),
  deleteTemplate: vi.fn().mockResolvedValue({ success: true }),
}

Object.defineProperty(window, 'api', {
  value: mockApi,
  writable: true,
})
