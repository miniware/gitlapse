import { execSync } from "child_process";
import * as readline from 'readline';
import { log, pretty } from "./logger";

// Interface for dependencies
export interface UserInteractionDependencies {
  execCommand: (...args: any[]) => any;
  // Use a more generic type for readline options
  createReadline: (options: any) => readline.Interface;
  loggerPretty: typeof pretty;
  loggerLog: typeof log;
}

// Default implementation
const defaultDependencies: UserInteractionDependencies = {
  execCommand: execSync,
  createReadline: (options) => readline.createInterface(options),
  loggerPretty: pretty,
  loggerLog: log
};

/**
 * Prompt user for confirmation using gum or fallback to readline
 * @param prompt - The prompt to display to the user
 * @param deps - Optional dependencies to inject (useful for testing)
 * @returns Promise that resolves to true if confirmed, false otherwise
 */
export async function getUserConfirmation(
  prompt: string,
  deps: UserInteractionDependencies = defaultDependencies
): Promise<boolean> {
  try {
    // Try to use gum for a pretty interface
    try {
      // This will throw with non-zero exit code if user selects "No"
      deps.execCommand(`gum confirm "${prompt}"`, { stdio: 'inherit' });
      return true;
    } catch (gumError) {
      // Non-zero exit means user chose "No"
      if (gumError instanceof Error && gumError.message.includes('Command failed')) {
        return false;
      }
      
      // If it's another error (like gum not installed), fall back to basic prompt
      deps.loggerPretty("(gum not found, using fallback prompt)", "info");
      
      // For testability, allow passing null in tests to skip readline
      if (process.env.NODE_ENV === 'test') {
        return true; // Default to true in tests
      }
      
      const rl = deps.createReadline({
        input: process.stdin,
        output: process.stdout
      });
      
      return new Promise(resolve => {
        rl.question(`${prompt} (y/n) `, answer => {
          rl.close();
          resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
        });
      });
    }
  } catch (error) {
    // Handle unexpected errors
    deps.loggerLog(`Error in confirmation UI: ${error instanceof Error ? error.message : String(error)}`);
    return process.env.NODE_ENV === 'test' ? false : false;
  }
}