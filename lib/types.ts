/**
 * A single file to be generated in a project
 */
export interface ProjectFile {
  path: string;
  content: string;
}

/**
 * Complete project data from Claude
 */
export interface ProjectData {
  intent: 'build' | 'chat';
  projectName: string;
  description?: string;
  files: ProjectFile[];
}

/**
 * Chat response from Claude
 */
export interface ChatResponse {
  intent: 'chat';
  response: string;
}

/**
 * Build response from Claude
 */
export interface BuildResponse {
  intent: 'build';
  projectName: string;
  description?: string;
  files: ProjectFile[];
}

/**
 * Message in conversation
 */
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  type: 'chat' | 'build';
  timestamp: Date;
  projectName?: string;
}

/**
 * Project metadata
 */
export interface Project {
  id: string;
  projectName: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  filesCount: number;
  foldersCount: number;
  projectPath: string;
  port?: number;
  isRunning: boolean;
  previewUrl?: string;
}

/**
 * Build progress state
 */
export interface BuildProgress {
  status: 'idle' | 'analyzing' | 'generating' | 'creating' | 'installing' | 'starting' | 'success' | 'error';
  message: string;
  logs: string[];
  projectName?: string;
  projectPath?: string;
  foldersCreated?: number;
  filesCreated?: number;
  port?: number;
  previewUrl?: string;
  error?: string;
}

/**
 * File editor state
 */
export interface FileEditorState {
  projectId: string;
  filePath: string;
  content: string;
  isDirty: boolean;
  isLoading: boolean;
}

/**
 * Project runner result
 */
export interface RunnerResult {
  success: boolean;
  port?: number;
  logs: string[];
  error?: string;
}

/**
 * Installation result
 */
export interface InstallResult {
  success: boolean;
  logs: string[];
  error?: string;
}

/**
 * API Response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  logs?: string[];
}

/**
 * Deployment target
 */
export type DeploymentTarget = 'vercel' | 'netlify' | 'github';

/**
 * Deployment result
 */
export interface DeploymentResult {
  success: boolean;
  url?: string;
  target: DeploymentTarget;
  logs: string[];
  error?: string;
}