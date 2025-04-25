import { spawn } from 'child_process';
import { pretty, log } from './logger';

/**
 * Options for user confirmations
 */
export interface ConfirmationOptions {
  defaultValue?: boolean;
}

/**
 * Prompt user for confirmation using gum with proper stdio handling
 * In test environments, defaults to specified value or true
 * 
 * @param prompt - The prompt message to display
 * @param options - Optional confirmation options
 * @returns Promise resolving to boolean based on user input
 */
export async function getUserConfirmation(
  prompt: string, 
  options: ConfirmationOptions = {}
): Promise<boolean> {
  // In test environment, return the specified default or true
  if (process.env.NODE_ENV === 'test') {
    return Promise.resolve(options.defaultValue ?? true);
  }

  return new Promise(resolve => {
    const { defaultValue } = options;
    const args = ['confirm'];
    
    if (defaultValue === true) {
      args.push('--default');
    }
    
    args.push(prompt);
    
    // Must use spawn with stdio: 'inherit' to properly show interactive prompts
    const gumProcess = spawn('gum', args, { 
      stdio: 'inherit'
    });
    
    gumProcess.on('close', code => {
      // Exit code 0 means "Yes", any other means "No"
      resolve(code === 0);
    });
  });
}

/**
 * Prompt user for textual input using gum with proper stdio handling
 * 
 * @param prompt - The prompt message to display
 * @param defaultValue - Optional default value if user provides empty input
 * @returns Promise resolving to user input string
 */
export async function getUserInput(
  prompt: string,
  defaultValue?: string
): Promise<string> {
  // In test environment, return the default value or empty string
  if (process.env.NODE_ENV === 'test') {
    return Promise.resolve(defaultValue || '');
  }
  
  const args = ['input', '--placeholder', prompt];
  
  if (defaultValue) {
    args.push('--value', defaultValue);
  }
  
  return new Promise((resolve) => {
    // Use stdin/stdout redirection for capturing input
    const gumProcess = spawn('gum', args, {
      stdio: ['inherit', 'pipe', 'inherit']
    });
    
    let output = '';
    
    if (gumProcess.stdout) {
      gumProcess.stdout.on('data', (data) => {
        output += data.toString();
      });
    }
    
    gumProcess.on('close', () => {
      const value = output.trim();
      resolve(value || defaultValue || '');
    });
  });
}

/**
 * Display a multi-choice menu using gum with proper stdio handling
 * 
 * @param prompt - The prompt message to display
 * @param choices - Array of choice objects with value and label
 * @param defaultIndex - Optional index of default choice
 * @returns Promise resolving to the value of the selected choice
 */
export async function getUserChoice<T>(
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
  
  // Extract just the labels for gum
  const labels = choices.map(choice => choice.label);
  
  // Build gum args
  const args = ['choose', '--header', prompt, ...labels];

  return new Promise((resolve) => {
    // Use stdin/stdout redirection for interactive selection
    const gumProcess = spawn('gum', args, {
      stdio: ['inherit', 'pipe', 'inherit']
    });
    
    let output = '';
    
    if (gumProcess.stdout) {
      gumProcess.stdout.on('data', (data) => {
        output += data.toString();
      });
    }
    
    gumProcess.on('close', (code) => {
      const selectedLabel = output.trim();
      
      // Find the matching choice
      const selectedChoice = choices.find(choice => choice.label === selectedLabel);
      
      if (selectedChoice) {
        resolve(selectedChoice.value);
      } else {
        // If not found or user cancelled, return default
        const defaultChoice = choices[defaultIndex];
        if (!defaultChoice) {
          throw new Error("No default choice available");
        }
        resolve(defaultChoice.value);
      }
    });
  });
}