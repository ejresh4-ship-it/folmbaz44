// Desktop API — the contract between the renderer (React) and the Electron
// main process. Exposed via a secure preload bridge on `window.filmBazDesktop`.
//
// SECURITY: The preload script uses contextBridge with contextIsolation enabled
// and nodeIntegration disabled. Only these explicitly-listed methods are
// exposed to the renderer. No unrestricted filesystem or shell access leaks.
//
// When running in a plain browser (no Electron), `window.filmBazDesktop` is
// undefined and the app falls back to mock/browser-mode behavior.

/** A detected media player on the system. */
export interface DetectedPlayer {
  /** unique stable id (e.g. "vlc", "mpc-hc", "system-default") */
  id: string;
  /** display name, e.g. "VLC media player" */
  name: string;
  /** absolute path to the executable, or "system-default" for the OS handler */
  executablePath: string;
  /** whether this is the Windows default handler for video files */
  isSystemDefault: boolean;
  /** whether the player supports external subtitle arguments */
  supportsSubtitles: boolean;
  /** optional icon path or data URL for display */
  iconUrl?: string;
}

/** Result of a playback launch attempt. */
export interface PlaybackResult {
  success: boolean;
  error?: string;
  /** the player that was used */
  playerUsed?: string;
}

/** User playback preferences stored in IndexedDB. */
export interface PlaybackPreferences {
  /** which player to use: 'system' for Windows default, or a player id */
  selectedPlayerId: 'system' | string;
  /** manually-selected executable path (when auto-detection misses) */
  manualExecutablePath?: string;
}

/** The desktop bridge exposed by the Electron preload script. */
export interface LanHostStartResult { success: boolean; message: string; port?: number; pin?: string; addresses?: string[]; }
export interface LanHostStatus { running: boolean; port: number | null; connectedDevices: number; }

export interface DesktopBridge {
  readonly isDesktop: true;
  chooseLanFolders(): Promise<string[]>;
  startLanHost(paths: string[], port: number): Promise<LanHostStartResult>;
  stopLanHost(): Promise<{ success: boolean }>;
  getLanHostStatus(): Promise<LanHostStatus>;

  // --- Local offline AI ---
  browseForAiServer(): Promise<string | null>;
  browseForAiModel(): Promise<string | null>;
  startLocalAi(serverPath: string, modelPath: string, port: number): Promise<{ success: boolean; message: string }>;
  stopLocalAi(): Promise<void>;

  // --- Artwork download ---
  /** Fetch a remote artwork image in Electron's main process, bypassing renderer CORS. */
  downloadImage(url: string): Promise<string | null>;

  // --- Filesystem (delegated to ElectronFilesystemService) ---
  listDir(path: string): Promise<import('./filesystem').DirEntry[]>;
  scanDir(
    path: string,
    onProgress: (scanned: number, currentPath: string) => void,
    signal: { cancelled: boolean },
  ): Promise<import('./filesystem').DirEntry[]>;
  stat(path: string): Promise<import('./filesystem').FileInfo>;
  exists(path: string): Promise<boolean>;
  createDir(path: string): Promise<{ success: boolean; error?: string }>;
  moveFile(source: string, dest: string): Promise<import('./filesystem').MoveResult>;
  writeTextFile(path: string, content: string): Promise<{ success: boolean; error?: string }>;
  downloadFile(url: string, destPath: string): Promise<{ success: boolean; error?: string }>;
  isSymlink(path: string): Promise<boolean>;
  /** Safely remove a strictly-empty child directory, never the selected root. */
  removeEmptyDirectory(path: string, selectedRoot: string): Promise<{ success: boolean; error?: string }>; 
  normalizePath(path: string): Promise<string>;
  joinPath(...segments: string[]): Promise<string>;
  parentPath(path: string): Promise<string>;
  baseName(path: string): Promise<string>;

  // --- Player discovery ---
  /** Detect installed media players using Windows registry, App Paths, and known locations. */
  detectPlayers(): Promise<DetectedPlayer[]>;
  /** Validate that an executable path exists and looks like an .exe. */
  validateExecutable(path: string): Promise<{ valid: boolean; error?: string }>;
  /** Open a file-picker dialog for selecting an .exe file. Returns path or null. */
  browseForExecutable(): Promise<string | null>;
  /** Open a folder-picker dialog. Returns all selected folders. */
  browseForFolders(): Promise<string[]>;

  // --- Secure settings ---
  /** Store an encrypted value using the operating system's credential storage. */
  secureSet(key: string, value: string): Promise<void>;
  /** Read an encrypted value, or null when it has not been stored. */
  secureGet(key: string): Promise<string | null>;

  // --- Playback ---
  /**
   * Launch a media file in the specified player.
   * Uses spawn() with argument arrays — never shell concatenation.
   */
  playFile(
    filePath: string,
    playerExecutable: string,
    subtitlePath?: string,
  ): Promise<PlaybackResult>;
  /** Open a file with the Windows default application. */
  playWithSystemDefault(filePath: string): Promise<PlaybackResult>;
}

declare global {
  interface Window {
    filmBazDesktop?: DesktopBridge;
  }
}
