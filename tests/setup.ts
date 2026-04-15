import '@testing-library/jest-dom/vitest'

// Mock window.api for renderer tests
const mockApi = {
  startTask: vi.fn().mockResolvedValue({ taskId: 'test-task-id' }),
  stopTask: vi.fn().mockResolvedValue({ success: true }),
  queryTasks: vi.fn().mockResolvedValue([]),
  queryTaskRoundArtifacts: vi.fn().mockResolvedValue([]),
  onAgentEvent: vi.fn().mockReturnValue(() => {}),
  saveConfig: vi.fn().mockResolvedValue({ success: true }),
  checkConfig: vi.fn().mockResolvedValue({ exists: false }),
  getConfigValue: vi.fn().mockResolvedValue({ value: null }),
  testAnthropicConnection: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
  testImageProviderConnection: vi.fn().mockResolvedValue({ success: true, message: 'ok', durationMs: 100 }),
  getUserDataPath: vi.fn().mockResolvedValue({ path: 'C:/Users/test/AppData/Roaming/ecom-image-agent' }),
  readImageAsDataUrl: vi.fn().mockResolvedValue({ dataUrl: null }),
  resolveLocalPath: vi.fn().mockReturnValue(''),
  saveTemplate: vi.fn().mockResolvedValue({ success: true }),
  listTemplates: vi.fn().mockResolvedValue([]),
  deleteTemplate: vi.fn().mockResolvedValue({ success: true }),
  saveEvaluationTemplate: vi.fn().mockResolvedValue({ success: true }),
  listEvaluationTemplates: vi.fn().mockResolvedValue([]),
  deleteEvaluationTemplate: vi.fn().mockResolvedValue({ success: true }),
  generateStandardEvaluationTemplate: vi.fn().mockResolvedValue({
    id: 1,
    name: '默认电商评估标准',
    version: 1,
    default_threshold: 85,
    rubric_json: '{}',
    created_at: new Date().toISOString(),
  }),
}

Object.defineProperty(window, 'api', {
  value: mockApi,
  writable: true,
})
