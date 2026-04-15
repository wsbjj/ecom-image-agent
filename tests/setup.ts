import '@testing-library/jest-dom/vitest'

// Mock window.api for renderer tests
const mockApi = {
  startTask: vi.fn().mockResolvedValue({ taskId: 'test-task-id' }),
  stopTask: vi.fn().mockResolvedValue({ success: true }),
  queryTasks: vi.fn().mockResolvedValue([]),
  onAgentEvent: vi.fn().mockReturnValue(() => {}),
  saveConfig: vi.fn().mockResolvedValue({ success: true }),
  checkConfig: vi.fn().mockResolvedValue({ exists: false }),
  saveTemplate: vi.fn().mockResolvedValue({ success: true }),
  listTemplates: vi.fn().mockResolvedValue([]),
  deleteTemplate: vi.fn().mockResolvedValue({ success: true }),
}

Object.defineProperty(globalThis, 'window', {
  value: {
    ...globalThis.window,
    api: mockApi,
  },
  writable: true,
})
