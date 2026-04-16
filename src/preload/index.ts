import { contextBridge, ipcRenderer } from "electron";
import type { JobEvent, MangaProject, StartAnalysisRequest, StartAnalysisResult } from "../shared/types";

const api = {
  openImages: () => ipcRenderer.invoke("images:open"),
  openImageFolder: () => ipcRenderer.invoke("images:open-folder"),
  saveProject: (project: MangaProject) => ipcRenderer.invoke("project:save", project),
  loadProject: () => ipcRenderer.invoke("project:load"),
  exportPng: (dataUrl: string, defaultName: string) => ipcRenderer.invoke("export:png", dataUrl, defaultName),
  getLogPath: (): Promise<string> => ipcRenderer.invoke("logs:get-path"),
  openLogFolder: () => ipcRenderer.invoke("logs:open-folder"),
  writeLog: (level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown) =>
    ipcRenderer.invoke("logs:write", level, message, detail),
  startAnalysis: (request: StartAnalysisRequest): Promise<StartAnalysisResult> => ipcRenderer.invoke("job:start-analysis", request),
  cancelJob: () => ipcRenderer.invoke("job:cancel"),
  onJobEvent: (callback: (event: JobEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: JobEvent) => callback(payload);
    ipcRenderer.on("job:event", listener);
    return () => {
      ipcRenderer.removeListener("job:event", listener);
    };
  }
};

contextBridge.exposeInMainWorld("mangaApi", api);

export type MangaApi = typeof api;
