"use strict";
const electron = require("electron");
const IPC_CHANNELS = {
  TASK_START: "task:start",
  TASK_STOP: "task:stop",
  TASK_LIST: "task:list",
  AGENT_LOOP_EVENT: "agent:loop-event",
  CONFIG_GET: "config:get",
  CONFIG_SET: "config:set",
  APP_USER_DATA_PATH: "app:user-data-path",
  TEMPLATE_SAVE: "template:save",
  TEMPLATE_LIST: "template:list",
  TEMPLATE_DELETE: "template:delete"
};
const api = {
  startTask: (input) => electron.ipcRenderer.invoke(IPC_CHANNELS.TASK_START, input),
  stopTask: (taskId) => electron.ipcRenderer.invoke(IPC_CHANNELS.TASK_STOP, taskId),
  queryTasks: () => electron.ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST),
  onAgentEvent: (callback) => {
    const handler = (_, event) => {
      callback(event);
    };
    electron.ipcRenderer.on(IPC_CHANNELS.AGENT_LOOP_EVENT, handler);
    return () => {
      electron.ipcRenderer.removeListener(IPC_CHANNELS.AGENT_LOOP_EVENT, handler);
    };
  },
  saveConfig: (key, value) => electron.ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET, key, value),
  checkConfig: (key) => electron.ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET, key),
  getUserDataPath: () => electron.ipcRenderer.invoke(IPC_CHANNELS.APP_USER_DATA_PATH),
  saveTemplate: (template) => electron.ipcRenderer.invoke(IPC_CHANNELS.TEMPLATE_SAVE, template),
  listTemplates: () => electron.ipcRenderer.invoke(IPC_CHANNELS.TEMPLATE_LIST),
  deleteTemplate: (id) => electron.ipcRenderer.invoke(IPC_CHANNELS.TEMPLATE_DELETE, id)
};
electron.contextBridge.exposeInMainWorld("api", api);
