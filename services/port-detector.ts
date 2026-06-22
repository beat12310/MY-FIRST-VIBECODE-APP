import { createServer, createConnection } from 'net';
import { PROJECT_CONFIG } from '@/lib/constants';
import { logError } from '@/lib/error-handler';

/**
 * Check if a port is available.
 * Uses TCP-connect probes on BOTH IPv4 and IPv6 because Next.js on macOS binds
 * as tcp46 (dual-stack). A server.listen('127.0.0.1') probe misses IPv6
 * occupants and falsely reports the port as free — causing a new server to
 * start, fail with EADDRINUSE, and leave a stale state pointing at the old app.
 */
function isPortAvailable(port: number): Promise<boolean> {
  function probe(host: string): Promise<boolean> {
    // Returns true if something answered (port IN USE), false if connection refused
    return new Promise((resolve) => {
      const sock = createConnection({ port, host });
      const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 400);
      sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
      sock.once('error', () => { clearTimeout(timer); resolve(false); });
    });
  }
  // Port is only available if NEITHER IPv4 nor IPv6 has anything listening
  return Promise.all([probe('127.0.0.1'), probe('::1')])
    .then(([v4, v6]) => !v4 && !v6)
    .catch(() => false);
}

/**
 * Find next available port starting from a given port
 */
export async function findAvailablePort(startPort: number = PROJECT_CONFIG.DEFAULT_PORT): Promise<number> {
  const maxPort = PROJECT_CONFIG.PORT_RANGE_END;
  let port = startPort;

  while (port <= maxPort) {
    try {
      const available = await isPortAvailable(port);
      if (available) {
        return port;
      }
    } catch (error) {
      logError(`Error checking port ${port}`, error);
    }
    port++;
  }

  // If no port available in range, return default
  return PROJECT_CONFIG.DEFAULT_PORT;
}

/**
 * Get multiple available ports
 */
export async function findAvailablePorts(
  count: number = 1,
  startPort: number = PROJECT_CONFIG.DEFAULT_PORT
): Promise<number[]> {
  const ports: number[] = [];
  let currentPort = startPort;
  const maxPort = PROJECT_CONFIG.PORT_RANGE_END;

  while (ports.length < count && currentPort <= maxPort) {
    try {
      const available = await isPortAvailable(currentPort);
      if (available) {
        ports.push(currentPort);
      }
    } catch (error) {
      logError(`Error checking port ${currentPort}`, error);
    }
    currentPort++;
  }

  return ports;
}

/**
 * Wait for port to be available
 */
export async function waitForPort(
  port: number,
  timeoutMs: number = 30000,
  intervalMs: number = 500
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const available = await isPortAvailable(port);
      if (!available) {
        // Port is in use, which means server is running
        return true;
      }
    } catch (error) {
      logError(`Error checking port ${port}`, error);
    }

    // Wait before retry
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return false;
}

/**
 * Get port from environment or use default
 */
export function getPortFromEnv(): number {
  const envPort = process.env.PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65535) {
      return parsed;
    }
  }
  return PROJECT_CONFIG.DEFAULT_PORT;
}

/**
 * Validate port number
 */
export function isValidPort(port: number): boolean {
  return port > 0 && port < 65535 && Number.isInteger(port);
}

/**
 * Get preview URL from port
 */
export function getPreviewUrl(port: number, protocol: string = 'http'): string {
  if (!isValidPort(port)) {
    return `${protocol}://localhost:${PROJECT_CONFIG.DEFAULT_PORT}`;
  }
  return `${protocol}://localhost:${port}`;
}