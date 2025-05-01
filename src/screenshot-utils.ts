import fs from "fs";
import path from "path";
import { log, pretty } from "./logger";
import type { Page, HTTPResponse } from "puppeteer";

/**
 * Navigate to a URL with retry capability
 */
export async function navigateWithRetry(page: Page, url: string, waitMs: number): Promise<HTTPResponse | null> {
  log(`Navigating to ${url}`);
  const navigationTimeout = waitMs * 3;
  log(`Using navigation timeout of ${navigationTimeout}ms`);

  let retryAttempted = false;

  try {
    return await page.goto(url, {
      waitUntil: "networkidle0",
      timeout: navigationTimeout
    });
  } catch (navErr) {
    if (retryAttempted) {
      throw navErr;
    }

    // First failure, try once more with a different wait strategy
    log("Navigation failed, retrying with different wait strategy");

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeout
    });

    // If we've loaded the DOM but not all resources, wait a bit more
    await new Promise(resolve => setTimeout(resolve, 1000));
    return response;
  }
}

/**
 * Check if the HTTP response was successful
 */
export async function isResponseSuccessful(
  page: Page, 
  response: HTTPResponse, 
  commitIndex: number, 
  totalCommits: number, 
  sha: string, 
  message: string
): Promise<boolean> {
  const statusCode = response.status();
  const statusText = response.statusText();
  log(`Page loaded with status code: ${statusCode} (${statusText})`);

  if (statusCode < 400) {
    return true;
  }

  // Try to get more detailed error information
  let errorDetails = "";
  try {
    const errorContent = await extractHttpErrorDetails(page);
    if (errorContent) {
      errorDetails = ` - ${errorContent.substring(0, 150).replace(/\n/g, ' ')}`;
    }
  } catch (evalError) {
    // Ignore errors from page.evaluate
  }

  skipCommitWithWarning(commitIndex, totalCommits, sha, message,
    errorDetails.includes('Missing dependency')
      ? `Dependency error: ${errorDetails.replace(' - ', '')}`
      : `HTTP ${statusCode} ${statusText}${errorDetails}`
  );

  return false;
}

/**
 * Extract error details from HTTP error page
 */
export async function extractHttpErrorDetails(page: Page): Promise<string> {
  return await page.evaluate(() => {
    // Look for common error containers
    const errorElements = [
      document.querySelector('.error-message, .error-text, .error-info'),
      document.querySelector('.error-details, .stack-trace'),
      document.querySelector('#error-container, .error-container'),
      document.querySelector('[role="alert"]'),
      document.querySelector('pre'),
      document.querySelector('h1, h2'),
      document.body
    ];

    // Return the first non-empty error element text
    for (const el of errorElements) {
      if (el && el.textContent && el.textContent.trim()) {
        const text = el.textContent.trim();
        return text.length > 100 ? text.split('\n').slice(0, 2).join(' ') : text;
      }
    }

    // Try to extract common error patterns
    const bodyText = document.body.textContent || '';

    // Look for dependency errors
    const missingDepMatch = bodyText.match(/dependency ["']([^"']+)["'] not found/i) ||
                           bodyText.match(/Cannot find module ["']([^"']+)["']/i) ||
                           bodyText.match(/Module not found: Error: Can't resolve ["']([^"']+)["']/i);

    if (missingDepMatch && missingDepMatch[1]) {
      return `Missing dependency: ${missingDepMatch[1]}`;
    }

    // Look for syntax errors
    const syntaxErrorMatch = bodyText.match(/SyntaxError: ([^\n]+)/i);
    if (syntaxErrorMatch && syntaxErrorMatch[1]) {
      return `Syntax error: ${syntaxErrorMatch[1]}`;
    }

    return "";
  });
}

/**
 * Check if the rendered page is an error page
 */
export async function isErrorPage(page: Page): Promise<boolean> {
  const pageTitle = await page.title();
  const pageContent = await page.content();

  // Definitive error patterns
  const errorPatterns = [
    '404 Not Found', '500 Internal Server Error', 'Error Page',
    'Something went wrong', 'page not found', 'cannot display the webpage'
  ];

  // Check for explicit error content
  const hasExplicitErrorContent = errorPatterns.some(pattern =>
    pageTitle.toLowerCase().includes(pattern.toLowerCase()) ||
    pageContent.toLowerCase().includes(pattern.toLowerCase())
  );

  // Check if the page has error elements
  let isDefiniteErrorPage: boolean;
  try {
    isDefiniteErrorPage = await page.evaluate(() => {
      // Check for HTTP status code elements
      const statusElements = document.querySelectorAll('.status-code, .error-code, code');
      for (const el of Array.from(statusElements)) {
        const text = el.textContent || '';
        if (text.match(/^[45]\d{2}$/) || text.includes('404') || text.includes('500')) {
          return true;
        }
      }

      // Check for explicit error message containers
      const errorContainers = document.querySelectorAll(
        '.error-message, .error-container, .alert-danger, .exception, ' +
        '[role="alert"], .error-title, .error-description'
      );
      if (Array.from(errorContainers).length > 0) {
        return true;
      }

      // Check title for error indicators
      const title = document.title || '';
      if (
        title.includes('404') ||
        title.includes('500') ||
        title.match(/not found/i) ||
        title.match(/server error/i) ||
        title.match(/^error\b/i)
      ) {
        return true;
      }

      // Check for a mostly empty page
      const contentElements = document.body.querySelectorAll('div, p, h1, h2, h3, section, main');
      return Array.from(contentElements).length < 3 && (document.body.textContent?.trim().length || 0) < 50;
    });
  } catch (evalError) {
    // If evaluation fails, assume it's not an error page
    isDefiniteErrorPage = false;
  }

  return isDefiniteErrorPage || hasExplicitErrorContent;
}

/**
 * Extract error message from error page
 */
export async function extractErrorMessage(page: Page): Promise<string> {
  try {
    const extractedError = await page.evaluate(() => {
      // Common error message container selectors
      const errorSelectors = [
        '.error-message', '.alert-danger', '.error-details',
        '#error-container', '[role="alert"]', '.exception-message',
        'title', 'h1', '.main-error', '.error-code', '.status-code'
      ];

      for (const selector of errorSelectors) {
        const el = document.querySelector(selector);
        if (el && el.textContent) {
          const content = el.textContent.trim();
          if (content) {
            return content;
          }
        }
      }

      // Try the body text
      const bodyText = document.body.textContent || "";
      if (bodyText.length < 100) {
        return bodyText.trim();
      }

      // Look for error messages
      const errorRegex = /error:?\s+([^\n.]+)/i;
      const match = bodyText.match(errorRegex);
      if (match && match[1]) {
        return match[1].trim();
      }

      return "";
    });

    if (extractedError) {
      return extractedError.substring(0, 100).replace(/\n/g, ' ');
    }

    return "Empty or error page detected";
  } catch (evalError) {
    return "Error page (could not extract details)";
  }
}

/**
 * Check if the page is empty or has minimal content
 */
export async function isEmptyPage(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const bodyText = document.body.textContent || "";
      const trimmedText = bodyText.trim();

      // Check if the page has almost no content
      if (trimmedText.length < 10) {
        return true;
      }

      // Check for visible elements
      const allElements = Array.from(document.querySelectorAll('*'));
      const visibleElements = allElements.filter(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      });

      // If very few visible elements with content, might be empty/loading
      return visibleElements.length < 5 && trimmedText.length < 30;
    });
  } catch (evalError) {
    // If evaluation fails, assume it's not empty
    return false;
  }
}

/**
 * Save a screenshot from the current page
 */
export async function saveScreenshot(
  page: Page, 
  commitIndex: number, 
  totalCommits: number, 
  message: string, 
  framesPattern: string,
  density?: number,
  fullscreen?: boolean
): Promise<void> {
  // Create filename from commit message
  const commitWords = message.split(' ');
  const truncatedMessage = commitWords.slice(0, 5).join('_').replace(/[^a-zA-Z0-9_-]/g, '');
  const frame = `${framesPattern}${String(commitIndex).padStart(3, "0")}_${truncatedMessage}.png`;

  log(`Saving screenshot to: ${frame}`);

  await page.screenshot({ 
    path: frame, 
    fullPage: fullscreen === true
  });

  // Verify the screenshot was created
  if (!fs.existsSync(frame)) {
    pretty(`❌ Failed to create screenshot at ${frame}`, "error");
    process.exit(1);
  }

  // Success message
  pretty(`✅ [${commitIndex+1}/${totalCommits}] Screenshot saved`, "success");
}

/**
 * Display warning for skipped commit
 */
export function skipCommitWithWarning(
  commitIndex: number, 
  totalCommits: number, 
  sha: string, 
  message: string | undefined, 
  reason: string | undefined
): void {
  const safeMessage = message || '(no message)';
  const safeReason = reason || 'Unknown error';
  pretty(`⚠️ Commit ${commitIndex+1}/${totalCommits}: ${sha.substring(0, 8)} - ${safeMessage}`, "warning");
  pretty(`   No screenshot saved - ${safeReason}`, "warning");
}

/**
 * Handle navigation errors
 */
export function handleNavigationError(
  error: any, 
  commitIndex: number, 
  totalCommits: number, 
  sha: string, 
  message: string
): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const shortErrorMessage = errorMessage.split('\n')[0];

  // Identify connection errors
  const isConnectionError = errorMessage.includes('ERR_CONNECTION') ||
                          errorMessage.includes('ECONNREFUSED') ||
                          errorMessage.includes('ETIMEDOUT');

  // Check for any navigation-related errors
  const isNavigationError = isConnectionError ||
                          errorMessage.includes('ERR_ABORTED') ||
                          errorMessage.includes('ERR_FAILED') ||
                          errorMessage.includes('ERR_NETWORK') ||
                          errorMessage.includes('navigation');

  if (isNavigationError) {
    // Extract specific error type
    let issue = shortErrorMessage;

    if (errorMessage.includes('ECONNREFUSED')) {
      issue = "Connection refused - server may not have started";
    } else if (errorMessage.includes('ETIMEDOUT')) {
      issue = "Connection timed out - server may be slow to respond";
    } else if (errorMessage.includes('ERR_CONNECTION_RESET')) {
      issue = "Connection reset - server closed the connection";
    } else if (errorMessage.includes('ERR_EMPTY_RESPONSE')) {
      issue = "Empty response - server didn't return any data";
    } else if (errorMessage.includes('ERR_ABORTED')) {
      issue = "Navigation aborted - page may be redirecting or reloading";
    } else if (errorMessage.includes('ERR_FAILED')) {
      issue = "Navigation failed - page may be unreachable";
    }

    skipCommitWithWarning(commitIndex, totalCommits, sha, message, issue);
  } else {
    // For other errors
    skipCommitWithWarning(commitIndex, totalCommits, sha, message, `Unexpected error: ${shortErrorMessage}`);
  }
}