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
  restoreRepositoryState 
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
  git-lapse - Create timelapse videos of your web project's development

  Usage: git-lapse [options]

  Options:
    -h, --help               Show this help message
    -o, --out-dir <dir>      Output directory for frames and video (default: ./timelapse)
    -w, --width <pixels>     Screenshot width (default: 1440)
    --height <pixels>        Screenshot height (default: 720)
    --wait <milliseconds>    Wait time after starting server (default: 3000)
    -r, --route <path>       Route to capture (default: /)
    -p, --port <number>      Port to use for the dev server (default: 3000)
    --branch <n>             Only include commits from this branch (default: all)
    --max-commits <number>   Limit number of commits to process
    --fps <number>           Frames per second in output video (default: 2)

  Features:
    - Automatic resume: If existing frames are found in the output directory,
      you'll be prompted to resume from where you left off or start over
  `);
}

// Track original branch for safety (read-only)
let originalBranch: string = "";

async function main() {

  log("Starting git-lapse");

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
  const { outDir, width, height, waitMs, route, port } = config;
  log(`Config: outDir=${outDir}, width=${width}, height=${height}, waitMs=${waitMs}, route=${route}, port=${port}`);

  // Run safety checks
  safetyCheck(outDir);
  log("Repository safety checks passed");

  // Only support apps with package.json
  log("Checking for package.json");
  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.error("No package.json found. This tool supports only JS apps with package.json.");
    process.exit(1);
  }
  log("Confirmed: package.json found");

  // Create output directory if it doesn't exist
  log(`Creating output directory if needed: ${outDir}`);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
    log(`Created output directory: ${outDir}`);
  } else {
    log(`Output directory already exists: ${outDir}`);
  }

  // Determine serve cmd from package.json
  log("Reading package.json to determine serve command");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const serveCmd = detectServeCommand(pkg.scripts || {});
  log(`Detected serve command: ${serveCmd}`);

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
  await processCommits(commits, startIndex, framesPattern, outDir, serveCmd, url, route, port, waitMs, width, height);

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
  waitMs: number,
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
    let prevPackageJson = "";
    if (commits.length > 0) {
      // If we're resuming, checkout the commit at the resume point
      // Otherwise, checkout the first commit
      const commitToCheckout = startIndex > 0 ? commits[startIndex] : commits[0];

      if (commitToCheckout) {
        log(`Checking out initial commit: ${commitToCheckout.substring(0, 8)}`);
        require('child_process').execSync(`git checkout ${commitToCheckout} --quiet`);
        log("Initial commit checked out successfully");

        // Store original package.json content for comparison and restoration
        const pkgPath = path.join(process.cwd(), "package.json");
        const pkgContent = fs.readFileSync(pkgPath, "utf8");
        prevPackageJson = pkgContent;

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
          i, commits, startIndex, prevPackageJson, serveCmd, 
          server, url, route, waitMs, page, framesPattern
        );
        server = result.server;
        prevPackageJson = result.prevPackageJson;
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
  prevPackageJsonRef: string,
  serveCmd: string,
  serverRef: any,
  url: string,
  route: string,
  waitMs: number,
  page: any,
  framesPattern: string
): Promise<{server: any, prevPackageJson: string}> {
  let server = serverRef;
  let prevPackageJson = prevPackageJsonRef;
  const sha = commits[i];

  // Skip undefined or empty SHA values
  if (!sha) {
    log(`Skipping undefined commit at index ${i}`);
    return {server, prevPackageJson};
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
    log(`Checking out commit: ${sha.substring(0, 8)}`);
    require('child_process').execSync(`git checkout ${sha} --quiet`);
    log("Checkout complete");
  }

  // Check if package.json has changed from previous commit
  const { packageJsonChanged, newPkgContent } = await checkPackageJsonChanges(prevPackageJson);

  // Update the reference for next comparison
  if (packageJsonChanged && newPkgContent) {
    prevPackageJson = newPkgContent;

    // Handle dependency installation if needed
    const packageManager = detectPackageManager(serveCmd);
    pretty(`📦 Dependencies changed, reinstalling using ${packageManager}...`, "info");
    await installDependencies(packageManager);
  }

  // Server reuse logic - only restart if dependencies changed or no server is running
  if (packageJsonChanged || !server) {
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
          waitMs
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

      return {server, prevPackageJson}; // Skip to next commit if server fails to start
    }
  } else {
    // Using existing server (reuse)
    log(`Reusing server for commit ${i+1}/${commits.length}`);
  }

  // Capture screenshot
  log(`Preparing to take screenshot at route: ${route}`);
  try {
    // Attempt to navigate to the page and check for errors
    const response = await navigateWithRetry(page, url + route, waitMs);

    if (!response) {
      // Navigation failed silently
      pretty(`⚠️ Commit ${i+1}/${commits.length}: ${sha.substring(0, 8)} - ${message}`, "warning");
      pretty(`   No screenshot saved - Navigation failed silently`, "warning");
      return {server, prevPackageJson};
    }

    // Check for HTTP error status codes
    if (!await isResponseSuccessful(page, response, i, commits.length, sha, message)) {
      return {server, prevPackageJson};
    }

    // Check for client-side error pages
    if (await isErrorPage(page)) {
      const errorMessage = await extractErrorMessage(page);
      pretty(`⚠️ Commit ${i+1}/${commits.length}: ${sha.substring(0, 8)} - ${message}`, "warning");
      pretty(`   No screenshot saved - ${errorMessage}`, "warning");
      return {server, prevPackageJson};
    }

    // Check for empty pages
    if (await isEmptyPage(page)) {
      pretty(`⚠️ Commit ${i+1}/${commits.length}: ${sha.substring(0, 8)} - ${message}`, "warning");
      pretty(`   No screenshot saved - Empty or loading page`, "warning");
      return {server, prevPackageJson};
    }

    // Save the screenshot
    await saveScreenshot(page, i, commits.length, message, framesPattern);
  } catch (navError) {
    handleNavigationError(navError, i, commits.length, sha, message);
  }

  return {server, prevPackageJson};
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