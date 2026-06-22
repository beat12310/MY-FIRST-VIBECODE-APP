import { ERROR_MESSAGES } from './constants';

/**
 * Custom error class for application errors
 */
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Error types
 */
export enum ErrorCode {
  // Input errors
  EMPTY_PROMPT = 'EMPTY_PROMPT',
  INVALID_INPUT = 'INVALID_INPUT',
  INVALID_PROJECT_NAME = 'INVALID_PROJECT_NAME',

  // JSON errors
  INVALID_JSON = 'INVALID_JSON',
  JSON_PARSE_ERROR = 'JSON_PARSE_ERROR',
  INVALID_RESPONSE_FORMAT = 'INVALID_RESPONSE_FORMAT',

  // File errors
  FILE_CREATE_ERROR = 'FILE_CREATE_ERROR',
  FILE_WRITE_ERROR = 'FILE_WRITE_ERROR',
  FILE_READ_ERROR = 'FILE_READ_ERROR',
  PROJECT_CREATE_ERROR = 'PROJECT_CREATE_ERROR',

  // Process errors
  INSTALL_ERROR = 'INSTALL_ERROR',
  START_SERVER_ERROR = 'START_SERVER_ERROR',
  PORT_DETECTION_ERROR = 'PORT_DETECTION_ERROR',

  // API errors
  BEDROCK_ERROR = 'BEDROCK_ERROR',
  API_ERROR = 'API_ERROR',
  MISSING_CREDENTIALS = 'MISSING_CREDENTIALS',

  // Server errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
}

/**
 * Format error message for user display
 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'An unexpected error occurred';
}

/**
 * Handle and format errors for API responses
 */
export function handleError(error: unknown): {
  message: string;
  code: string;
  statusCode: number;
  details?: unknown;
} {
  console.error('Error:', error);

  if (error instanceof AppError) {
    return {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      details: error.details,
    };
  }

  if (error instanceof SyntaxError) {
    return {
      message: ERROR_MESSAGES.INVALID_JSON,
      code: ErrorCode.JSON_PARSE_ERROR,
      statusCode: 400,
      details: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      code: ErrorCode.INTERNAL_ERROR,
      statusCode: 500,
      details: error.stack,
    };
  }

  return {
    message: 'An unexpected error occurred',
    code: ErrorCode.INTERNAL_ERROR,
    statusCode: 500,
  };
}

/**
 * Validate prompt input
 */
export function validatePrompt(prompt: string): { valid: boolean; error?: string } {
  if (!prompt || typeof prompt !== 'string') {
    return {
      valid: false,
      error: ERROR_MESSAGES.NO_PROMPT,
    };
  }

  if (prompt.trim().length === 0) {
    return {
      valid: false,
      error: ERROR_MESSAGES.NO_PROMPT,
    };
  }

  if (prompt.length > 10000) {
    return {
      valid: false,
      error: 'Prompt is too long (max 10000 characters)',
    };
  }

  return { valid: true };
}

/**
 * Validate project name
 */
export function validateProjectName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return {
      valid: false,
      error: ERROR_MESSAGES.INVALID_PROJECT_NAME,
    };
  }

  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return {
      valid: false,
      error: ERROR_MESSAGES.INVALID_PROJECT_NAME,
    };
  }

  // Allow kebab-case, lowercase letters, numbers
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmed)) {
    return {
      valid: false,
      error: 'Project name must be lowercase, alphanumeric, with hyphens allowed',
    };
  }

  if (trimmed.length > 50) {
    return {
      valid: false,
      error: 'Project name is too long (max 50 characters)',
    };
  }

  return { valid: true };
}

/**
 * Create AppError with code
 */
export function createError(
  code: ErrorCode,
  message: string,
  statusCode: number = 500,
  details?: unknown
): AppError {
  return new AppError(code, message, statusCode, details);
}

/**
 * Handle Bedrock API errors
 */
export function handleBedrockError(error: unknown): AppError {
  if (error instanceof Error) {
    if (error.message.includes('credential')) {
      return createError(
        ErrorCode.MISSING_CREDENTIALS,
        ERROR_MESSAGES.MISSING_CREDENTIALS,
        401
      );
    }

    if (error.message.includes('throttl')) {
      return createError(
        ErrorCode.BEDROCK_ERROR,
        'API rate limit exceeded. Please try again later.',
        429
      );
    }

    if (error.message.includes('timeout')) {
      return createError(
        ErrorCode.TIMEOUT_ERROR,
        'Request timeout. Please try again.',
        504
      );
    }

    return createError(
      ErrorCode.BEDROCK_ERROR,
      ERROR_MESSAGES.BEDROCK_ERROR,
      500,
      error.message
    );
  }

  return createError(ErrorCode.BEDROCK_ERROR, ERROR_MESSAGES.BEDROCK_ERROR, 500);
}

/**
 * Retry logic for failed operations
 */
export async function retryOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (i < maxRetries - 1) {
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }

  throw lastError || new Error('Operation failed after retries');
}

/**
 * Log error with context
 */
export function logError(
  context: string,
  error: unknown,
  additionalInfo?: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();
  const message = formatErrorMessage(error);

  console.error(`[${timestamp}] ${context}:`, message, additionalInfo);
}