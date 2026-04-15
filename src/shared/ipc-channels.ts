export const IPC_CHANNELS = {
  TASK_START: 'task:start',
  TASK_STOP: 'task:stop',
  TASK_LIST: 'task:list',
  AGENT_LOOP_EVENT: 'agent:loop-event',
  CONFIG_GET: 'config:get',
  CONFIG_GET_VALUE: 'config:get-value',
  CONFIG_SET: 'config:set',
  CONFIG_TEST_ANTHROPIC: 'config:test-anthropic',
  CONFIG_TEST_IMAGE_PROVIDER: 'config:test-image-provider',
  APP_USER_DATA_PATH: 'app:user-data-path',
  TEMPLATE_SAVE: 'template:save',
  TEMPLATE_LIST: 'template:list',
  TEMPLATE_DELETE: 'template:delete',
} as const satisfies Record<string, string>

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
