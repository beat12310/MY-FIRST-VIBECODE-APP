import { readFile, writeFile, mkdir, rmdir, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { logError } from '@/lib/error-handler';

/**
 * Read file content
 */
export async function readFileContent(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return content;
  } catch (error) {
    logError(`Failed to read file: ${filePath}`, error);
    throw error;
  }
}

/**
 * Write file content
 */
export async function writeFileContent(filePath: string, content: string): Promise<void> {
  try {
    const dir = dirname(filePath);
    
    // Create directory if it doesn't exist
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(filePath, content, 'utf-8');
  } catch (error) {
    logError(`Failed to write file: ${filePath}`, error);
    throw error;
  }
}

/**
 * File exists check
 */
export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

/**
 * Delete file
 */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    if (fileExists(filePath)) {
      await unlink(filePath);
    }
  } catch (error) {
    logError(`Failed to delete file: ${filePath}`, error);
    throw error;
  }
}

/**
 * Create directory
 */
export async function createDirectory(dirPath: string): Promise<void> {
  try {
    if (!fileExists(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }
  } catch (error) {
    logError(`Failed to create directory: ${dirPath}`, error);
    throw error;
  }
}

/**
 * Delete directory recursively
 */
export async function deleteDirectory(dirPath: string): Promise<void> {
  try {
    if (fileExists(dirPath)) {
      // Recursive delete would require reading contents
      // For now, just try to remove empty directory
      await rmdir(dirPath, { recursive: true });
    }
  } catch (error) {
    logError(`Failed to delete directory: ${dirPath}`, error);
    throw error;
  }
}

/**
 * List files in directory
 */
export async function listFiles(dirPath: string): Promise<string[]> {
  try {
    const { readdirSync } = require('fs');
    if (!fileExists(dirPath)) {
      return [];
    }
    return readdirSync(dirPath);
  } catch (error) {
    logError(`Failed to list files in: ${dirPath}`, error);
    return [];
  }
}

/**
 * Copy file
 */
export async function copyFile(source: string, destination: string): Promise<void> {
  try {
    const content = await readFileContent(source);
    await writeFileContent(destination, content);
  } catch (error) {
    logError(`Failed to copy file from ${source} to ${destination}`, error);
    throw error;
  }
}

/**
 * Update file content (append or replace)
 */
export async function updateFileContent(
  filePath: string,
  content: string,
  append: boolean = false
): Promise<void> {
  try {
    if (append && fileExists(filePath)) {
      const existing = await readFileContent(filePath);
      await writeFileContent(filePath, existing + '\n' + content);
    } else {
      await writeFileContent(filePath, content);
    }
  } catch (error) {
    logError(`Failed to update file: ${filePath}`, error);
    throw error;
  }
}

/**
 * Get file size
 */
export async function getFileSize(filePath: string): Promise<number> {
  try {
    const { statSync } = require('fs');
    if (!fileExists(filePath)) {
      return 0;
    }
    return statSync(filePath).size;
  } catch (error) {
    logError(`Failed to get file size: ${filePath}`, error);
    return 0;
  }
}

/**
 * Check if path is directory
 */
export function isDirectory(filePath: string): boolean {
  try {
    const { statSync } = require('fs');
    if (!fileExists(filePath)) {
      return false;
    }
    return statSync(filePath).isDirectory();
  } catch (error) {
    return false;
  }
}

/**
 * Get absolute path
 */
export function getAbsolutePath(basePath: string, relativePath: string): string {
  return join(basePath, relativePath);
}

/**
 * Ensure directory exists
 */
export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  if (!fileExists(dirPath)) {
    await createDirectory(dirPath);
  }
}