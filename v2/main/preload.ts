import { contextBridge, ipcRenderer } from "electron";
import type { AkorithAPI, AppEvent } from "../shared/contracts";
const api: AkorithAPI = {
  invoke: async <T>(command: string, payload?: unknown): Promise<T> => {
    const result = (await ipcRenderer.invoke("akorith:command", {
      command,
      payload,
    })) as { ok: boolean; value?: T; error?: string };
    if (!result.ok) throw new Error(result.error || "The request failed.");
    return result.value as T;
  },
  onEvent: (callback: (event: AppEvent) => void) => {
    const listener = (_event: unknown, payload: AppEvent) => callback(payload);
    ipcRenderer.on("akorith:event", listener);
    return () => ipcRenderer.removeListener("akorith:event", listener);
  },
  onHostEvent: (callback) => {
    const listener = (
      _event: unknown,
      payload: Parameters<typeof callback>[0],
    ) => callback(payload);
    ipcRenderer.on("akorith:host", listener);
    return () => ipcRenderer.removeListener("akorith:host", listener);
  },
};
contextBridge.exposeInMainWorld("akorith", Object.freeze(api));
