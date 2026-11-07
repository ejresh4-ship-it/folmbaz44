// Electron preload script — securely bridges the main process and the renderer.
//
// SECURITY MODEL:
// - contextIsolation: true — no Node.js globals leak into the renderer
// - nodeIntegration: false — no require/import in the renderer
// - Only the methods listed here are exposed via contextBridge

import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DetectedPlayer, PlaybackResult } from '../src/types/desktop';
import type { DirEntry, FileInfo, MoveResult } from '../src/types/filesystem';

const scanProgressChannels = new Map<string, (scanned: number, currentPath: string) => void>();

contextBridge.exposeInMainWorld('filmBazDesktop', {
  isDesktop: true,

  // --- Local offline AI ---
  browseForAiServer: (): Promise<string | null> => ipcRenderer.invoke('ai:browseServer'),
  browseForAiModel: (): Promise<string | null> => ipcRenderer.invoke('ai:browseModel'),
  startLocalAi: (serverPath: string, modelPath: string, port: number): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke('ai:startLocal', serverPath, modelPath, port),
  stopLocalAi: (): Promise<void> => ipcRenderer.invoke('ai:stopLocal'),

  // --- Embedded LAN streaming ---
  getLanStatus: () => ipcRenderer.invoke('lan:status'),
  configureLanSharing: (roots: import('../src/types/desktop').LanRoot[]) => ipcRenderer.invoke('lan:configure', roots),

  // --- Artwork download ---
  downloadImage: (url: string): Promise<string | null> => ipcRenderer.invoke('images:download', url),

  // --- Filesystem ---
  listDir: (p: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:listDir', p),

  scanDir: (
    p: string,
    onProgress: (scanned: number, currentPath: string) => void,
    signal: { cancelled: boolean },
  ): Promise<DirEntry[]> => {
    const channel = `fs:scanProgress:${p}:${Date.now()}`;
    scanProgressChannels.set(channel, onProgress);
    const handler = (_evt: unknown, scanned: number, currentPath: string) => {
      const cb = scanProgressChannels.get(channel);
      if (cb) cb(scanned, currentPath);
    };
    ipcRenderer.on(channel, handler);
    let cancellationSent = false;
    const cancelTimer = setInterval(() => {
      if (signal.cancelled && !cancellationSent) {
        cancellationSent = true;
        void ipcRenderer.invoke('fs:cancelScan', channel);
      }
    }, 100);
    return ipcRenderer.invoke('fs:scanDir', p, channel, channel).finally(() => {
      clearInterval(cancelTimer);
      ipcRenderer.removeListener(channel, handler);
      scanProgressChannels.delete(channel);
    });
  },

  stat: (p: string): Promise<FileInfo> => ipcRenderer.invoke('fs:stat', p),
  exists: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:exists', p),
  createDir: (p: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('fs:createDir', p),
  moveFile: (source: string, dest: string): Promise<MoveResult> => ipcRenderer.invoke('fs:moveFile', source, dest),
  writeTextFile: (path: string, content: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('fs:writeTextFile', path, content),
  downloadFile: (url: string, destPath: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('fs:downloadFile', url, destPath),
  isSymlink: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:isSymlink', p),
  removeEmptyDirectory: (p: string, root: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('fs:removeEmptyDirectory', p, root),
  normalizePath: (p: string): Promise<string> => ipcRenderer.invoke('fs:normalizePath', p),
  joinPath: (...segments: string[]): Promise<string> => ipcRenderer.invoke('fs:joinPath', ...segments),
  parentPath: (p: string): Promise<string> => ipcRenderer.invoke('fs:parentPath', p),
  baseName: (p: string): Promise<string> => ipcRenderer.invoke('fs:baseName', p),

  // --- Player discovery ---
  detectPlayers: (): Promise<DetectedPlayer[]> => ipcRenderer.invoke('player:detect'),
  validateExecutable: (p: string): Promise<{ valid: boolean; error?: string }> => ipcRenderer.invoke('player:validateExe', p),
  browseForExecutable: (): Promise<string | null> => ipcRenderer.invoke('player:browseExe'),
  browseForFolders: (): Promise<string[]> => ipcRenderer.invoke('fs:browseFolders'),

  // --- Secure settings ---
  secureSet: (key: string, value: string): Promise<void> => ipcRenderer.invoke('secure:set', key, value),
  secureGet: (key: string): Promise<string | null> => ipcRenderer.invoke('secure:get', key),

  // --- Playback ---
  playFile: (filePath: string, playerExecutable: string, subtitlePath?: string): Promise<PlaybackResult> =>
    ipcRenderer.invoke('playback:playFile', filePath, playerExecutable, subtitlePath),
  playWithSystemDefault: (filePath: string): Promise<PlaybackResult> =>
    ipcRenderer.invoke('playback:playSystemDefault', filePath),
} satisfies DesktopBridge);
