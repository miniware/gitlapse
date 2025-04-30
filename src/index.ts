#!/usr/bin/env bun

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { parseArgs, detectServeCommand } from "./cli";
import { log, pretty } from "./logger";
import { getUserConfirmation } from "./user-interaction";
import { checkResumeAndPrompt } from "./resume-utils";
import { findCapturedFrames, generateTimeLapseVideo } from "./video-utils";
import {
  safetyCheck,
  getCurrentBranch,
  setupSafetyExitHandler,
  gatherCommits,
  restoreRepositoryState,
  cleanGemfileLock
} from "./git-utils";
import {
  startServer,
  stopServer
} from "./server-utils";
import {
  navigateWithRetry,
  isResponseSuccessful,
  isErrorPage,
  isEmptyPage,
  extractErrorMessage,
  saveScreenshot,
  handleNavigationError
} from "./screenshot-utils";
import {
  detectPackageManager,
  installDependencies,
  checkPackageJsonChanges,
  cleanupEnvironment
} from "./package-utils";

// Show help information
function showHelp() {
  console.log(`
  gitlapse - Create timelapse videos of your web project's development

  Usage: gitlapse [options]

  Options:
    -h, --help               Show this help message
    -o, --out-dir <dir>      Output directory for frames and video (default: ./timelapse)
    -w, --width <pixels>     Screenshot width (default: 1440)
    --height <pixels>        Screenshot height (default: 720)
    --wait-before <ms>       Wait time before page load (default: 3000)
    --wait-after <ms>        Wait time after page load before screenshot (default: 0)
    -r, --route <path>       Route to capture (default: /)
    -p, --port <number>      Port to use for the dev server (default: 3000)
    --branch <n>             Only include commits from this branch (default: all)
    --max-commits <number>   Limit number of commits to process
    --fps <number>           Frames per second in output video (default: 12)

  Features:
    - Automatic resume: If existing frames are found in the output directory,
      you'll be prompted to resume from where you left off or start over
  `);
}

// Track original branch for safety (read-only)
let originalBranch: string = "";
// Track project type
let projectType: "js" | "rails" | "hybrid" = "js";

async function main() {
  log("Starting gitlapse");

  // Show help if requested
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    log("Showing help and exiting");
    showHelp();
    return;
  }

  // CLI args
  log("Parsing command line arguments");
  const args = process.argv.slice(2);
  const config = parseArgs(args);
  const { outDir, width, height, waitBeforeMs, waitAfterMs, route, port } = config;
  log(`Config: outDir=${outDir}, width=${width}, height=${height}, waitBeforeMs=${waitBeforeMs}, waitAfterMs=${waitAfterMs}, route=${route}, port=${port}`);

  // Run safety checks
  safetyCheck(outDir);
  log("Repository safety checks passed");

  // Detect project type based on configuration files
  log("Detecting project type...");
  const pkgPath = path.join(process.cwd(), "package.json");
  const gemfilePath = path.join(process.cwd(), "Gemfile");
  const hasPackageJson = fs.existsSync(pkgPath);
  const hasGemfile = fs.existsSync(gemfilePath);
  
  // Determine project type based on available files
  if (hasGemfile && hasPackageJson) {
    projectType = "hybrid";
    log("Detected hybrid project (Rails + JS)");
  } else if (hasGemfile) {
    projectType = "rails";
    log("Detected Rails project");
  } else if (hasPackageJson) {
    projectType = "js";
    log("Detected JavaScript project");
  } else {
    console.error("No package.json or Gemfile found. This tool supports JS apps with package.json or Rails apps with Gemfile.");
    process.exit(1);
  }

  // Create output directory if it doesn't exist
  log(`Creating output directory if needed: ${outDir}`);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
    log(`Created output directory: ${outDir}`);
  } else {
    log(`Output directory already exists: ${outDir}`);
  }

  // Determine serve command based on project type
  let serveCmd = "";
  
  switch (projectType) {
    case "rails":
      log("Using Rails server command");
      serveCmd = "bundle exec rails server";
      log(`Using Rails serve command: ${serveCmd}`);
      break;
      
    case "js":
    case "hybrid":
      // For hybrid projects, prefer the JS server command
      log("Reading package.json to determine serve command");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      serveCmd = detectServeCommand(pkg.scripts || {});
      log(`Detected serve command: ${serveCmd}`);
      break;
      
    default:
      console.error("Unsupported project type");
      process.exit(1);
  }

  const url = `http://localhost:${port}`;
  const framesPattern = path.join(outDir, "frame_");
  log(`URL will be: ${url}${route}`);
  log(`Frame pattern: ${framesPattern}`);

  // Gather commits
  const commits = gatherCommits(config.branch, config.maxCommits);

  if (commits.length === 0) {
    console.error("No commits found in repository history.");
    process.exit(1);
  }
  log(`Will process ${commits.length} commits`);

  // Log first few commits to aid debugging
  log("First few commits to process:");
  commits.slice(0, Math.min(5, commits.length)).forEach((sha, i) => {
    const shortSha = sha.substring(0, 8);
    const message = require('child_process').execSync(`git show -s --format=%s ${sha}`).toString().trim();
    log(`  ${i+1}. ${shortSha} - ${message}`);
  });

  // Check if we can resume from a previous run
  const startIndexResult = await checkResumeAndPrompt({
    outDir,
    framesPattern,
    commits
  });

  // If startIndexResult is -1, all commits have already been processed
  if (startIndexResult === -1) {
    await handleAllCommitsProcessed(outDir, framesPattern, width, height, config.fps);
    return;
  }

  // Otherwise, use the returned start index
  const startIndex = startIndexResult;

  // Show commit count and confirm
  pretty(`Found ${commits.length} commits to process.`, 'info');
  await confirmLargeCommitCount(commits);

  // Save current branch to return to it later (read-only)
  log("Saving current branch name for restoration");
  originalBranch = getCurrentBranch();

  // Setup safety exit handler
  setupSafetyExitHandler(originalBranch);

  // Process the commits
  await processCommits(commits, startIndex, framesPattern, outDir, serveCmd, url, route, port, waitBeforeMs, waitAfterMs, width, height);

  // Build video from the captured frames
  const outputVideoPath = await generateTimeLapseVideo(outDir, framesPattern, width, height, config.fps);

  // Restore original dependencies
  await cleanupEnvironment();

  // Report the number of frames
  reportProcessedFrames(outDir, framesPattern, commits.length);

  // Pretty completion message with ANSI colors
  console.log('\x1b[32m%s\x1b[0m', `✅ Done! Video saved at: ${outputVideoPath}`);

  // Show cleanup instructions
  console.log('\n\x1b[36mTo clean up all generated files:\x1b[0m');
  console.log(`  rm -rf ${outDir}`);

  // Show relative path for easier reference
  const relativeOutDir = path.relative(process.cwd(), outDir);
  if (relativeOutDir !== outDir) {
    console.log(`  or: rm -rf ${relativeOutDir}`);
  }
}

/**
 * Handle the case where all commits have already been processed
 */
async function handleAllCommitsProcessed(
  outDir: string,
  framesPattern: string,
  width: number,
  height: number,
  fps: number
): Promise<void> {
  // Check if there's already a video file in the output directory
  const existingVideos = fs.readdirSync(outDir)
    .filter(file => file.toLowerCase().endsWith('.mp4') && file.includes('timelapse'));

  if (existingVideos.length === 0) {
    // No video exists yet, so generate one from the existing frames
    pretty("No timelapse video found. Generating one from existing frames...", "info");
    const outputVideoPath = await generateTimeLapseVideo(outDir, framesPattern, width, height, fps);
    if (outputVideoPath) {
      pretty(`✅ Done! Video saved at: ${outputVideoPath}`, "success");
    }
  } else {
    // Video already exists
    pretty(`Existing timelapse video(s) found: ${existingVideos.join(', ')}`, "info");

    // Ask if user wants to generate a new video anyway
    const generateNewVideo = await getUserConfirmation("Generate a new video from existing frames?");
    if (generateNewVideo) {
      const outputVideoPath = await generateTimeLapseVideo(outDir, framesPattern, width, height, fps);
      if (outputVideoPath) {
        pretty(`✅ Done! New video saved at: ${outputVideoPath}`, "success");
      }
    }
  }
}

/**
 * Confirm with the user if there are many commits to process
 */
async function confirmLargeCommitCount(commits: string[]): Promise<void> {
  // User confirmation for large commit counts
  if (commits.length > 10) {
    log(`Asking confirmation for processing ${commits.length} commits`);

    // Use gum format for the warning
    pretty(`Processing ${commits.length} commits may take a while.`, 'warning');

    try {
      // Use gum confirm for interactive input
      const confirm = await getUserConfirmation(`${commits.length} commits found. Continue?`);
      log(`User confirmation result: ${confirm}`);

      if (!confirm) {
        pretty("Operation cancelled by user.", 'error');
        process.exit(0);
      }

      // Add a separator line after confirmation
      console.log('');
    } catch (confirmError) {
      // If there's an error with the confirmation, log it and continue anyway
      log(`Error getting user confirmation: ${confirmError instanceof Error ? confirmError.message : String(confirmError)}`);
      console.log('Continuing by default...');
    }
  }
}

/**
 * Process each commit in the list
 */
async function processCommits(
  commits: string[],
  startIndex: number,
  framesPattern: string,
  outDir: string,
  serveCmd: string,
  url: string,
  route: string,
  port: number,
  waitBeforeMs: number,
  waitAfterMs: number,
  width: number,
  height: number
): Promise<void> {
  // Launch browser
  log("Launching puppeteer browser");
  const browser = await puppeteer.launch();
  log("Browser launched successfully");
  log("Creating new page");
  const page = await browser.newPage();
  log("Setting viewport dimensions");
  await page.setViewport({ width, height });
  log(`Viewport set to ${width}x${height}`);

  try {
    // Initial checkout and setup
    let dependencyState = "";
    if (commits.length > 0) {
      // If we're resuming, checkout the commit at the resume point
      // Otherwise, checkout the first commit
      const commitToCheckout = startIndex > 0 ? commits[startIndex] : commits[0];

      if (commitToCheckout) {
        // Clean Gemfile.lock before checkout to prevent conflicts
        cleanGemfileLock();
        
        log(`Checking out initial commit: ${commitToCheckout.substring(0, 8)}`);
        try {
          require('child_process').execSync(`git checkout ${commitToCheckout} --quiet`);
          log("Initial commit checked out successfully");
        } catch (checkoutError) {
          // If checkout fails, try force checkout
          log(`Initial checkout failed, attempting force checkout: ${checkoutError instanceof Error ? checkoutError.message : String(checkoutError)}`);
          require('child_process').execSync(`git checkout -f ${commitToCheckout} --quiet`);
          log("Initial commit force checked out successfully");
        }

        // Store project dependency information for comparison and restoration
        switch (projectType) {
          case "rails":
            // For Rails projects, use Gemfile.lock timestamp as reference
            const gemfileLockPath = path.join(process.cwd(), "Gemfile.lock");
            if (fs.existsSync(gemfileLockPath)) {
              const gemfileLockStats = fs.statSync(gemfileLockPath);
              dependencyState = `rails:${gemfileLockStats.mtimeMs}`;
            } else {
              dependencyState = "rails:0";
            }
            break;
            
          case "js":
            // For JS projects, use package.json
            const jsPkgPath = path.join(process.cwd(), "package.json");
            const pkgContent = fs.readFileSync(jsPkgPath, "utf8");
            dependencyState = pkgContent;
            break;
            
          case "hybrid":
            // For hybrid projects, store both
            const hybridPkgPath = path.join(process.cwd(), "package.json");
            const hybridPkgContent = fs.readFileSync(hybridPkgPath, "utf8");
            const hybridGemfileLockPath = path.join(process.cwd(), "Gemfile.lock");
            let gemfileLockTime = "0";
            
            if (fs.existsSync(hybridGemfileLockPath)) {
              const gemStats = fs.statSync(hybridGemfileLockPath);
              gemfileLockTime = String(gemStats.mtimeMs);
            }
            
            dependencyState = `hybrid:${gemfileLockTime}:${hybridPkgContent}`;
            break;
        }

        // Detect and install dependencies for this commit
        const packageManager = detectPackageManager(serveCmd);

        // Install dependencies directly in the project
        pretty(`📦 Installing dependencies using ${packageManager}...`, "info");
        await installDependencies(packageManager);

        log("Dependencies installed without modifying project files");
      } else {
        log("Warning: Initial commit is undefined, skipping initial checkout");
      }
    }

    // Variable to track server instance
    let server: any = null;

    try {
      // Process each commit, starting from the resume point if applicable
      for (let i = startIndex; i < commits.length; i++) {
        const result = await processCommit(
          i, commits, startIndex, dependencyState, serveCmd,
          server, url, route, waitBeforeMs, waitAfterMs, page, framesPattern
        );
        server = result.server;
        dependencyState = result.dependencyState;
      }
    } finally {
      // Ensure server is always killed, even if screenshot fails
      log("Frame creation complete, cleaning up resources");
      if (server) {
        await stopServer(server);
        server = null;
      }
    }
  } finally {
    // Clean up browser
    log("Closing puppeteer browser");
    await browser.close();
    log("Browser closed successfully");

    // Return to original branch using helper functions
    await restoreRepositoryState(originalBranch || "");
  }
}

/**
 * Process a single commit
 */
async function processCommit(
  i: number,
  commits: string[],
  startIndex: number,
  dependencyStateRef: string,
  serveCmd: string,
  serverRef: any,
  url: string,
  route: string,
  waitBeforeMs: number,
  waitAfterMs: number,
  page: any,
  framesPattern: string
): Promise<{server: any, dependencyState: string}> {
  let server = serverRef;
  let dependencyState = dependencyStateRef;
  const sha = commits[i];

  // Skip undefined or empty SHA values
  if (!sha) {
    log(`Skipping undefined commit at index ${i}`);
    return {server, dependencyState};
  }

  log(`Processing commit ${i+1}/${commits.length}: ${sha.substring(0, 8)}`);

  // Get commit date and message
  log("Getting commit metadata");
  const date = require('child_process').execSync(`git show -s --format=%ci ${sha}`).toString().trim();
  const message = require('child_process').execSync(`git show -s --format=%s ${sha}`).toString().trim();
  log(`Commit date: ${date}, message: ${message}`);

  // Format and print commit status
  const formattedDate = new Date(date).toLocaleDateString();
  const truncatedMessage = message.substring(0, 60) + (message.length > 60 ? '...' : '');

  // Use formatted progress indicator
  console.log('\x1b[35m[%d/%d]\x1b[33m %s\x1b[0m - \x1b[36m%s\x1b[0m',
    i+1, commits.length, formattedDate, truncatedMessage);

  // Skip checkout for the first iteration if we're starting from the beginning
  // or if we've already checked out the correct commit during resumption
  if (!(i === 0 && startIndex === 0) && !(i === startIndex && startIndex > 0)) {
    // Reset any changes to Gemfile.lock before checkout to prevent conflicts
    cleanGemfileLock();
    
    log(`Checking out commit: ${sha.substring(0, 8)}`);
    try {
      require('child_process').execSync(`git checkout ${sha} --quiet`);
      log("Checkout complete");
    } catch (checkoutError) {
      // If checkout fails, try force checkout with -f flag
      log(`Checkout failed, attempting force checkout: ${checkoutError instanceof Error ? checkoutError.message : String(checkoutError)}`);
      require('child_process').execSync(`git checkout -f ${sha} --quiet`);
      log("Force checkout complete");
    }
  }

  // Check if dependencies have changed from previous commit
  const { dependenciesChanged, newDependencyState } = await checkPackageJsonChanges(dependencyState);

  // Update the reference for next comparison
  if (dependenciesChanged && newDependencyState) {
    dependencyState = newDependencyState;

    // Handle dependency installation if needed
    const packageManager = detectPackageManager(serveCmd);
    pretty(`📦 Dependencies changed, reinstalling using ${packageManager}...`, "info");
    await installDependencies(packageManager);
  }

  // Server reuse logic - only restart if dependencies changed or no server is running
  if (dependenciesChanged || !server) {
    // Stop existing server if running
    if (server) {
      await stopServer(server);
      server = null;
    }

    // Start server for this commit
    try {
      pretty(`🚀 Starting server for commit ${i+1}/${commits.length}`, "info");

      // Set DEBUG temporarily to see server output during startup
      const originalDebug = process.env.DEBUG;
      process.env.DEBUG = "true";

      try {
        server = await startServer({
          serveCmd,
          port: url.includes(':') ? parseInt(url.split(':')[2] || '3000') : 3000,
          waitBeforeMs
        });
      } finally {
        // Restore original DEBUG setting
        process.env.DEBUG = originalDebug;
      }
    } catch (serverStartError) {
      const errorMsg = serverStartError instanceof Error ?
        serverStartError.message : String(serverStartError);

      pretty(`⚠️ Commit ${i+1}/${commits.length}: ${sha.substring(0, 8)} - ${message}`, "warning");

      // Format the error message for better readability
      if (errorMsg.includes('dependency') || errorMsg.includes('not found')) {
        // Extract the dependency name if possible, otherwise show the full error
        const depPart = errorMsg.includes('dependency') ? errorMsg.split('dependency')[1] : null;
        pretty(`   No screenshot saved - Missing dependency: ${depPart?.trim() || errorMsg}`, "warning");
      } else if (errorMsg.length > 5) { // Make sure we have a meaningful error
        pretty(`   No screenshot saved - ${errorMsg}`, "warning");
      } else {
        pretty(`   No screenshot saved - Server start failed (check server configuration)`, "warning");
      }

      return {server, dependencyState}; // Skip to next commit if server fails to start
    }
  } else {
    // Using existing server (reuse)
    log(`Reusing server for commit ${i+1}/${commits.length}`);
  }

  // Capture screenshot
  log(`Preparing to take screenshot at route: ${route}`);
  try {
    // Attempt to navigate to the page and check for errors
    const response = await navigateWithRetry(page, url + route, waitBeforeMs);

    if (!response) {
      // Navigation failed silently
      pretty(`⚠️ Commit ${i+1}/${commits.length}: ${sha.substring(0, 8)} - ${message}`, "warning");
      pretty(`   No screenshot saved - Navigation failed silently`, "warning");
      return {server, dependencyState};
    }

    // Check for HTTP error status codes
    if (!await isResponseSuccessful(page, response, i, commits.length, sha, message)) {
      return {server, dependencyState};
    }

    // Check for client-side error pages
    if (await isErrorPage(page)) {
      const errorMessage = await extractErrorMessage(page);
      pretty(`⚠️ Commit ${i+1}/${commits.length}: ${sha.substring(0, 8)} - ${message}`, "warning");
      pretty(`   No screenshot saved - ${errorMessage}`, "warning");
      return {server, dependencyState};
    }

    // Check for empty pages
    if (await isEmptyPage(page)) {
      pretty(`⚠️ Commit ${i+1}/${commits.length}: ${sha.substring(0, 8)} - ${message}`, "warning");
      pretty(`   No screenshot saved - Empty or loading page`, "warning");
      return {server, dependencyState};
    }

    // Wait additional time after page load if specified
    if (waitAfterMs > 0) {
      log(`Waiting ${waitAfterMs}ms after page load before taking screenshot`);
      await new Promise(resolve => setTimeout(resolve, waitAfterMs));
    }

    // Save the screenshot
    await saveScreenshot(page, i, commits.length, message, framesPattern);
  } catch (navError) {
    handleNavigationError(navError, i, commits.length, sha, message);
  }

  return {server, dependencyState};
}

/**
 * Report the number of frames that were processed
 */
function reportProcessedFrames(outDir: string, framesPattern: string | undefined, totalCommits: number): void {
  try {
    const frameFiles = findCapturedFrames(outDir, framesPattern || '');
    const processedCount = frameFiles.length;
    pretty(`\nCreated ${processedCount} frames out of ${totalCommits} commits`, "info");
  } catch {
    // Ignore errors in summary calculation
  }
}

// Only invoke CLI when run as the main module
if (import.meta.main) {
  main();
}