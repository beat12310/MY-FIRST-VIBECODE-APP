import { getPreviewUrl, isValidPort } from './port-detector';
import { PROJECT_CONFIG } from '@/lib/constants';
import { logError } from '@/lib/error-handler';

/**
 * Preview manager state
 */
interface PreviewState {
  port: number;
  url: string;
  isRunning: boolean;
  startedAt: Date | null;
}

/**
 * Store for preview states (one per project)
 */
const previewStates = new Map<string, PreviewState>();

/**
 * Initialize preview for a project
 */
export function initializePreview(projectName: string, port: number): string {
  if (!isValidPort(port)) {
    port = PROJECT_CONFIG.DEFAULT_PORT;
  }

  const url = getPreviewUrl(port);
  const state: PreviewState = {
    port,
    url,
    isRunning: true,
    startedAt: new Date(),
  };

  previewStates.set(projectName, state);
  return url;
}

/**
 * Get preview URL for project
 */
export function getPreviewURLForProject(projectName: string): string | null {
  const state = previewStates.get(projectName);
  if (!state) {
    return null;
  }
  return state.url;
}

/**
 * Get preview port for project
 */
export function getPreviewPortForProject(projectName: string): number | null {
  const state = previewStates.get(projectName);
  if (!state) {
    return null;
  }
  return state.port;
}

/**
 * Check if preview is running
 */
export function isPreviewRunning(projectName: string): boolean {
  const state = previewStates.get(projectName);
  return state?.isRunning ?? false;
}

/**
 * Stop preview for project
 */
export function stopPreview(projectName: string): void {
  const state = previewStates.get(projectName);
  if (state) {
    state.isRunning = false;
  }
}

/**
 * Get all active previews
 */
export function getActivePreviewers(): Map<string, PreviewState> {
  const active = new Map<string, PreviewState>();
  previewStates.forEach((state, projectName) => {
    if (state.isRunning) {
      active.set(projectName, state);
    }
  });
  return active;
}

/**
 * Update preview port
 */
export function updatePreviewPort(projectName: string, port: number): string | null {
  const state = previewStates.get(projectName);
  if (!state) {
    return null;
  }

  if (!isValidPort(port)) {
    return state.url;
  }

  state.port = port;
  state.url = getPreviewUrl(port);
  return state.url;
}

/**
 * Generate preview frame HTML
 */
export function generatePreviewFrameHTML(projectName: string): string {
  const url = getPreviewURLForProject(projectName);

  if (!url) {
    return `
      <div style="display: flex; align-items: center; justify-content: center; height: 100%; background: #f5f5f5; font-family: system-ui;">
        <div style="text-align: center;">
          <h2>Preview Not Available</h2>
          <p>Project "${projectName}" is not running.</p>
        </div>
      </div>
    `;
  }

  return `
    <iframe 
      src="${url}" 
      style="width: 100%; height: 100%; border: none; border-radius: 8px;"
      title="Preview: ${projectName}"
      sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
    />
  `;
}

/**
 * Get preview status HTML
 */
export function getPreviewStatusHTML(projectName: string): string {
  const state = previewStates.get(projectName);

  if (!state) {
    return '<span style="color: #999;">Not started</span>';
  }

  if (!state.isRunning) {
    return '<span style="color: #d32f2f;">Stopped</span>';
  }

  const uptime = state.startedAt ? Date.now() - state.startedAt.getTime() : 0;
  const uptimeSeconds = Math.floor(uptime / 1000);

  return `
    <div>
      <span style="color: #388e3c; font-weight: bold;">✓ Running</span>
      <br>
      <small style="color: #666;">Port: ${state.port}</small>
      <br>
      <small style="color: #999;">Uptime: ${formatUptime(uptimeSeconds)}</small>
    </div>
  `;
}

/**
 * Get preview info
 */
export function getPreviewInfo(projectName: string): PreviewState | null {
  return previewStates.get(projectName) ?? null;
}

/**
 * Clear preview for project
 */
export function clearPreview(projectName: string): void {
  previewStates.delete(projectName);
}

/**
 * Clear all previews
 */
export function clearAllPreviews(): void {
  previewStates.clear();
}

/**
 * Format uptime
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m`;
  }

  const hours = Math.floor(seconds / 3600);
  return `${hours}h`;
}

/**
 * Get preview dashboard HTML
 */
export function getPreviewDashboard(): string {
  const previews = getActivePreviewers();

  if (previews.size === 0) {
    return `
      <div style="text-align: center; padding: 40px; color: #999;">
        <h3>No active previews</h3>
        <p>Generate an app to see preview here</p>
      </div>
    `;
  }

  let html = '<div style="padding: 20px;">';

  previews.forEach((state, projectName) => {
    html += `
      <div style="margin-bottom: 20px; padding: 15px; background: #f5f5f5; border-radius: 8px;">
        <h4 style="margin: 0 0 10px 0;">${projectName}</h4>
        <p style="margin: 5px 0;"><strong>URL:</strong> <code>${state.url}</code></p>
        <p style="margin: 5px 0;"><strong>Port:</strong> ${state.port}</p>
        <p style="margin: 5px 0; color: #388e3c;">✓ Running</p>
      </div>
    `;
  });

  html += '</div>';
  return html;
}