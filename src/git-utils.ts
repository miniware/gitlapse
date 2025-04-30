import { execSync } from "child_process";
import { log, pretty } from "./logger";
import fs from "fs";
import path from "path";

/**
 * Check if we're in a git repo and the repo is in a safe state
 */
export function safetyCheck(outDir = "timelapse"): void {
  log("Running git repository safety check");

  // Check if we're in a git repo
  if (!require('fs').existsSync(require('path').join(process.cwd(), ".git"))) {
    console.error("ERROR: No .git directory found. Run from repo root.");
    process.exit(1);
  }

  checkForDetachedHead();
  checkForUncommittedChanges();
}

/**
 * Check for detached HEAD, rebase, or merge in progress
 */
export function checkForDetachedHead(): void {
  try {
    const gitStatus = execSync("git status").toString().trim();
    if (gitStatus.includes("detached HEAD") ||
        gitStatus.includes("rebase in progress") ||
        gitStatus.includes("merge in progress")) {
      console.error("ERROR: Git repository is in a detached HEAD state or in the middle of a rebase/merge.");
      console.error("Please complete any ongoing git operations before running this tool.");
      process.exit(1);
    }
  } catch (error) {
    console.error("ERROR: Unable to check git status. Is this a valid git repository?");
    process.exit(1);
  }
}

/**
 * Check for uncommitted changes
 */
export function checkForUncommittedChanges(): void {
  try {
    // Ensure no unstaged or staged changes
    execSync('git diff --quiet');
    execSync('git diff --cached --quiet');
  } catch {
    console.error("ERROR: You have uncommitted changes in this repository.");
    console.error("Please commit or stash your changes before running this tool.");
    console.error("This tool requires a clean working directory.");
    process.exit(1);
  }
}

/**
 * Forcibly clean any changes to Gemfile.lock before checkout
 */
export function cleanGemfileLock(): void {
  const gemfileLockPath = path.join(process.cwd(), "Gemfile.lock");
  if (fs.existsSync(gemfileLockPath)) {
    try {
      // Check if Gemfile.lock has changes
      try {
        execSync('git diff --quiet Gemfile.lock');
      } catch {
        // Gemfile.lock has changes, reset it
        log("Resetting changes to Gemfile.lock before checkout");
        execSync('git checkout -- Gemfile.lock');
      }
    } catch (error) {
      // Log but don't fail the process
      log(`Warning: Failed to reset Gemfile.lock: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Gather commits from git history
 */
export function gatherCommits(branch?: string, maxCommits?: number): string[] {
  log("Gathering commits from git history");
  let commitCmd = "git log --all --date-order --pretty=format:%H"; // Get all commits from all branches in chronological order
  
  if (branch) {
    commitCmd = `git log ${branch} --date-order --pretty=format:%H`;
    log(`Using branch restriction: ${branch}`);
  }
  
  log(`Running git command: ${commitCmd}`);

  let commits = execSync(commitCmd)
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .reverse(); // Reverse to get oldest commits first
    
  log(`Found ${commits.length} total commits in history`);

  // Limit number of commits if requested
  if (maxCommits && maxCommits > 0 && commits.length > maxCommits) {
    log(`Limiting to ${maxCommits} commits as requested`);
    commits = commits.slice(0, maxCommits);
  }
  
  return commits;
}

/**
 * Get the current branch name
 * @returns Current branch name or empty string if error
 */
export function getCurrentBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
  } catch (error) {
    console.error("ERROR: Failed to determine current branch");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Restore repository to original state with fallbacks
 */
export async function restoreRepositoryState(originalBranch: string): Promise<void> {
  log(`Restoring repository state`);
  try {
    // First try to restore original branch if known
    if (originalBranch) {
      try {
        execSync(`git checkout ${originalBranch} --quiet`);
        log(`Restored original branch: ${originalBranch}`);
        return;
      } catch (branchError) {
        log(`Failed to restore original branch: ${originalBranch}`);
        // Will try fallbacks below
      }
    }

    // Try fallbacks in order
    if (await tryCheckoutHead()) return;
    if (await tryCheckoutMain()) return;
    if (await tryCheckoutMaster()) return;

    // If all fallbacks fail
    pretty(`❌ ERROR: Failed all attempts to restore repository state`, "error");
    pretty(`Please manually run: git checkout ${originalBranch || 'main'}`, "error");
  } catch (error) {
    pretty(`❌ CRITICAL ERROR: Failed to restore repository state`, "error");
    pretty(`Please manually run: git checkout ${originalBranch || 'main'}`, "error");
  }
}

/**
 * Try to checkout HEAD
 */
export async function tryCheckoutHead(): Promise<boolean> {
  try {
    execSync(`git checkout HEAD --quiet`);
    log(`Restored repository to HEAD`);
    return true;
  } catch (headError) {
    return false;
  }
}

/**
 * Try to checkout main branch
 */
export async function tryCheckoutMain(): Promise<boolean> {
  try {
    execSync(`git checkout main --quiet`);
    log(`Restored repository to main branch`);
    return true;
  } catch (mainError) {
    return false;
  }
}

/**
 * Try to checkout master branch
 */
export async function tryCheckoutMaster(): Promise<boolean> {
  try {
    execSync(`git checkout master --quiet`);
    log(`Restored repository to master branch`);
    return true;
  } catch (masterError) {
    return false;
  }
}

/**
 * Setup process exit handler for safety
 */
export function setupSafetyExitHandler(originalBranch: string): void {
  // Clean up on process exit signals
  ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException"].forEach(signal => {
    process.on(signal, () => {
      log("⚠️ Process interrupted, restoring repository state");

      try {
        // First try to restore original branch if known
        if (originalBranch) {
          try {
            execSync(`git checkout ${originalBranch} --quiet`);
            log(`Restored original branch: ${originalBranch}`);
            process.exit(1);
            return;
          } catch (branchError) {
            console.error(`ERROR: Failed to restore original branch ${originalBranch}`);
            console.error(branchError instanceof Error ? branchError.message : String(branchError));
            // Will try fallbacks below
          }
        }

        // Fallback 1: Try to checkout HEAD
        try {
          execSync(`git checkout HEAD --quiet`);
          log(`Restored repository to HEAD`);
          process.exit(1);
          return;
        } catch (headError) {
          // Ignore and try next fallback
        }

        // Fallback 2: Try to checkout main branch
        try {
          execSync(`git checkout main --quiet`);
          log(`Restored repository to main branch`);
          process.exit(1);
          return;
        } catch (mainError) {
          // Ignore and try next fallback
        }

        // Fallback 3: Try to checkout master branch
        try {
          execSync(`git checkout master --quiet`);
          log(`Restored repository to master branch`);
        } catch (masterError) {
          console.error(`ERROR: Failed all attempts to restore repository state`);
        }
      } catch (finalError) {
        console.error(`CRITICAL ERROR during cleanup: ${finalError}`);
      }

      process.exit(1);
    });
  });
}