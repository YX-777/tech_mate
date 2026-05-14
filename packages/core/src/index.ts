import { DEFAULT_CONFIG, ENV_VAR_NAMES, VALIDATION_RULES } from './constants/config';
import { CivilAgentError } from './utils/error';
import { logger } from './utils/logger';

export * from './types';
export * from './utils/logger';
export * from './utils/error';
export * from './constants/config';

export { logger, LogLevel, LogEntry } from './utils/logger';
export {
  CivilAgentError,
  MCPToolError,
  RAGRetrievalError,
  AgentExecutionError,
  ConfigurationError,
  ValidationError,
  NetworkError,
  isCivilAgentError,
  getErrorDetails,
  createErrorFromResponse,
  handleErrors,
  logError,
  shouldRetry,
  getRetryDelay,
} from './utils/error';

export {
  LEARNING_MODULES,
  DIFFICULTY_LEVELS,
  EMOTION_KEYWORDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  USER_INTENTS,
  LOG_LEVELS,
  DEFAULT_CONFIG,
  ENV_VAR_NAMES,
  API_ENDPOINTS,
  SUPPORTED_FILE_FORMATS,
  MAX_FILE_SIZE,
  VALIDATION_RULES,
  ERROR_CODES,
  HTTP_STATUS_CODES,
  CACHE_KEYS,
  RATE_LIMITS,
  SECURITY_CONFIG,
  DATABASE_CONFIG,
  REDIS_CONFIG,
} from './constants/config';

export const CORE_VERSION = '1.0.0';
export const CORE_DESCRIPTION = 'Core library providing TypeScript type definitions, logging utilities, error handling, and configuration constants for the tech learning assistant project.';

export function initializeCore(): void {
  logger.info('Core library initialized', { version: CORE_VERSION });
}

export function getCoreInfo(): {
  version: string;
  description: string;
  types: string[];
  utilities: string[];
  constants: string[];
} {
  return {
    version: CORE_VERSION,
    description: CORE_DESCRIPTION,
    types: [
      'GraphStateType',
      'Message',
      'RAGResult',
      'FeishuTask',
      'User',
      'ApiResponse',
      'PaginationParams',
    ],
    utilities: [
      'logger',
      'LogLevel',
      'CivilAgentError',
      'handleErrors',
      'logError',
      'shouldRetry',
    ],
    constants: [
      'DEFAULT_CONFIG',
      'ENV_VAR_NAMES',
      'API_ENDPOINTS',
      'LEARNING_MODULES',
      'DIFFICULTY_LEVELS',
    ],
  };
}

export function validateEnvironment(): {
  isValid: boolean;
  missingVars: string[];
  warnings: string[];
} {
  const missingVars: string[] = [];
  const warnings: string[] = [];

  const requiredEnvVars = [
    ENV_VAR_NAMES.ANTHROPIC_API_KEY,
    ENV_VAR_NAMES.LOG_LEVEL,
    ENV_VAR_NAMES.NODE_ENV,
  ];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      missingVars.push(envVar);
    }
  }

  if (!process.env[ENV_VAR_NAMES.DATABASE_URL]) {
    warnings.push('DATABASE_URL not set - some features may not work properly');
  }

  if (!process.env[ENV_VAR_NAMES.REDIS_URL]) {
    warnings.push('REDIS_URL not set - caching will be disabled');
  }

  return {
    isValid: missingVars.length === 0,
    missingVars,
    warnings,
  };
}

export function createCoreConfig(overrides?: Partial<typeof DEFAULT_CONFIG>) {
  const config = { ...DEFAULT_CONFIG };
  
  if (overrides) {
    Object.assign(config, overrides);
  }

  return config;
}

export function createError(
  code: string,
  message: string,
  context?: Record<string, any>,
  retryable: boolean = false
): CivilAgentError {
  return new CivilAgentError(code, message, context, retryable);
}

export function formatPrompt(template: string, variables: Record<string, any>): string {
  let formatted = template;
  
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{${key}}`;
    formatted = formatted.replace(new RegExp(placeholder, 'g'), String(value));
  }
  
  return formatted;
}

export function sanitizeInput(input: string): string {
  return input
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '');
}

export function validateEmail(email: string): boolean {
  return VALIDATION_RULES.EMAIL.test(email);
}

export function validatePhone(phone: string): boolean {
  return VALIDATION_RULES.PHONE.test(phone);
}

export function validatePassword(password: string): boolean {
  return VALIDATION_RULES.PASSWORD.test(password);
}

export function validateUsername(username: string): boolean {
  return VALIDATION_RULES.USERNAME.test(username);
}

export function generateId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

export function formatDate(date: Date): string {
  return date.toISOString();
}

export function parseDate(dateString: string): Date {
  return new Date(dateString);
}

export function calculateTimeAgo(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 30) return `${days}天前`;
  
  return date.toLocaleDateString();
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout;
  
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;
  
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

initializeCore();