import * as readline from 'readline';
import { pretty } from './logger';

/**
 * Options for user confirmations
 */
export interface ConfirmationOptions {
  defaultValue?: boolean;
  timeoutMs?: number;
  timeoutDefault?: boolean;
}

/**
 * Prompt user for confirmation via a simple y/n question with enhanced options
 * In test environments (NODE_ENV === 'test'), defaults to specified value or true
 * 
 * @param prompt - The prompt message to display
 * @param options - Optional confirmation options
 * @returns Promise resolving to boolean based on user input
 */
export function getUserConfirmation(
  prompt: string, 
  options: ConfirmationOptions = {}
): Promise<boolean> {
  // In test environment, return the specified default or true
  if (process.env.NODE_ENV === 'test') {
    return Promise.resolve(options.defaultValue ?? true);
  }

  const { defaultValue, timeoutMs, timeoutDefault } = options;
  const defaultPrompt = defaultValue === undefined ? 'y/n' : 
                        defaultValue === true ? 'Y/n' : 'y/N';

  const rl = readline.createInterface({ 
    input: process.stdin, 
    output: process.stdout 
  });

  return new Promise<boolean>(resolve => {
    // Add timeout if specified
    let timeoutId: NodeJS.Timeout | undefined;
    
    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        rl.close();
        const result = timeoutDefault ?? defaultValue ?? false;
        pretty(`Confirmation timed out after ${timeoutMs}ms. Using default: ${result}`, "info");
        resolve(result);
      }, timeoutMs);
    }

    rl.question(`${prompt} (${defaultPrompt}) `, answer => {
      // Clear timeout if it was set
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      rl.close();
      
      // If empty string, use default value if provided
      if (answer.trim() === '' && defaultValue !== undefined) {
        return resolve(defaultValue);
      }
      
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * Prompt user for textual input with optional default value and validation
 * 
 * @param prompt - The prompt message to display
 * @param defaultValue - Optional default value if user provides empty input
 * @param validator - Optional validation function
 * @returns Promise resolving to user input string
 */
export function getUserInput(
  prompt: string,
  defaultValue?: string,
  validator?: (input: string) => boolean | string
): Promise<string> {
  // In test environment, return the default value or empty string
  if (process.env.NODE_ENV === 'test') {
    return Promise.resolve(defaultValue || '');
  }
  
  const defaultPrompt = defaultValue ? ` (default: ${defaultValue})` : '';
  const rl = readline.createInterface({ 
    input: process.stdin, 
    output: process.stdout 
  });
  
  return new Promise<string>((resolve, reject) => {
    const askQuestion = () => {
      rl.question(`${prompt}${defaultPrompt}: `, answer => {
        // Use default value for empty input if provided
        const value = answer.trim() === '' && defaultValue ? defaultValue : answer.trim();
        
        // Validate input if validator is provided
        if (validator) {
          const validationResult = validator(value);
          if (validationResult !== true) {
            // Show error message if validation failed
            if (typeof validationResult === 'string') {
              pretty(validationResult, "error");
            } else {
              pretty("Invalid input, please try again", "error");
            }
            
            // Ask again
            return askQuestion();
          }
        }
        
        rl.close();
        resolve(value);
      });
    };
    
    askQuestion();
  });
}

/**
 * Display a multi-choice menu and get user selection
 * 
 * @param prompt - The prompt message to display
 * @param choices - Array of choice objects with value and label
 * @param defaultIndex - Optional index of default choice
 * @returns Promise resolving to the value of the selected choice
 */
export function getUserChoice<T>(
  prompt: string,
  choices: Array<{ value: T, label: string }>,
  defaultIndex = 0
): Promise<T> {
  // In test environment, return the default choice
  if (process.env.NODE_ENV === 'test') {
    const defaultChoice = choices[defaultIndex];
    if (!defaultChoice) {
      throw new Error("No default choice available at index: " + defaultIndex);
    }
    return Promise.resolve(defaultChoice.value);
  }
  
  if (choices.length === 0) {
    throw new Error("No choices provided for selection menu");
  }
  
  const rl = readline.createInterface({ 
    input: process.stdin, 
    output: process.stdout 
  });
  
  // Display menu
  console.log(`\n${prompt}`);
  choices.forEach((choice, index) => {
    const defaultMarker = index === defaultIndex ? " (default)" : "";
    console.log(`${index + 1}. ${choice.label}${defaultMarker}`);
  });
  
  return new Promise<T>((resolve, reject) => {
    const askQuestion = () => {
      rl.question(`Enter selection (1-${choices.length}) or press Enter for default: `, answer => {
        const value = answer.trim();
        
        // Empty input uses default
        if (value === '') {
          rl.close();
          const defaultChoice = choices[defaultIndex];
          if (!defaultChoice) {
            return reject(new Error("No default choice available at index: " + defaultIndex));
          }
          return resolve(defaultChoice.value);
        }
        
        // Parse numeric input
        const selection = parseInt(value, 10);
        if (isNaN(selection) || selection < 1 || selection > choices.length) {
          pretty(`Please enter a number between 1 and ${choices.length}`, "error");
          return askQuestion();
        }
        
        rl.close();
        const selectedChoice = choices[selection - 1];
        if (!selectedChoice) {
          return reject(new Error("Selected choice not available at index: " + (selection - 1)));
        }
        resolve(selectedChoice.value);
      });
    };
    
    askQuestion();
  });
}