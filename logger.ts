/**
 * Log levels for the application
 */
export type LogLevel = 'info' | 'success' | 'warning' | 'error';

/**
 * Simple logging with no timestamps - silent by default
 * @param message - The message to log
 */
export function log(message: string): void {
  // Only print in verbose mode for debug purposes
  if (process.env.DEBUG) {
    console.log(message);
  }
}

/**
 * Pretty printing with console colors
 * @param message - The message to print
 * @param type - The type of message (info, success, warning, error)
 */
export function pretty(message: string, type: LogLevel = 'info'): void {
  switch (type) {
    case 'success':
      console.log('\x1b[32m%s\x1b[0m', message);  // Green
      break;
    case 'warning':
      console.log('\x1b[33m%s\x1b[0m', message);  // Yellow 
      break;
    case 'error':
      console.log('\x1b[31m%s\x1b[0m', message);  // Red
      break;
    case 'info':
    default:
      console.log('\x1b[36m%s\x1b[0m', message);  // Cyan
      break;
  }
}