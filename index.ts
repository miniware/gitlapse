#!/usr/bin/env bun

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { spawn } from "child_process";
import { parseArgs, detectServeCommand } from "./cli";
import os from "os";
import { log, pretty } from "./logger";
import { getUserConfirmation } from "./user-interaction";
import { checkResumeAndPrompt } from "./resume-utils";

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
    --branch <name>             Only include commits from this branch (default: all)
    --max-commits <number>   Limit number of commits to process
    --fps <number>           Frames per second in output video (default: 2)

  Features:
    - Automatic resume: If existing frames are found in the output directory,
      you'll be prompted to resume from where you left off or start over
  `);
}

// Check if we're in a git repo and the repo is in a safe state
function safetyCheck(outDir = "timelapse"): void {
  log("Running git repository safety check");
  
  // Check if we're in a git repo
  if (!fs.existsSync(path.join(process.cwd(), ".git"))) {
    console.error("ERROR: No .git directory found. Run from repo root.");
    process.exit(1);
  }
  
  checkForDetachedHead();
  checkForUncommittedChanges(outDir);
}

function checkForDetachedHead(): void {
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

function checkForUncommittedChanges(outDir = "timelapse"): void {
  try {
    // Get the status of the repository
    const status = execSync("git status --porcelain").toString().trim();
    
    // If there are no changes, we're good to go
    if (!status) {
      return;
    }
    
    // Normalize outDir to handle both with and without trailing slash
    const normalizedOutDir = outDir.endsWith('/') ? outDir : outDir + '/';
    const outDirBasename = path.basename(outDir);
    
    // Check if the only changes are within the output directory
    const lines = status.split("\n");
    const nonOutputDirChanges = lines.filter(line => {
      // Extract the file path from the status line (format: "XY path")
      const filePath = line.substring(3);
      // Check if the file is in the output directory - handle both relative and absolute paths
      return !filePath.startsWith(normalizedOutDir) && 
             !filePath.startsWith(outDirBasename + '/') &&
             !filePath.endsWith(outDirBasename);
    });
    
    // If there are changes outside of the output directory, exit
    if (nonOutputDirChanges.length > 0) {
      console.error("ERROR: You have uncommitted changes in this repository.");
      console.error("Please commit or stash your changes before running this tool.");
      console.error("This tool temporarily checks out past commits and requires a clean working directory.");
      process.exit(1);
    }
    
    // If we get here, only output directory changes exist, which we'll ignore
    log(`Ignoring changes in output directory (${outDir})`);
  } catch (error) {
    console.error("ERROR: Unable to check git status. Is this a valid git repository?");
    process.exit(1);
  }
}

function detectPackageManager(serveCmd: string): string {
  // Default to bun
  let packageManager = 'bun';
  
  // Check for lockfiles to determine the package manager
  if (fs.existsSync(path.join(process.cwd(), 'yarn.lock'))) {
    packageManager = 'yarn';
  } else if (fs.existsSync(path.join(process.cwd(), 'package-lock.json'))) {
    packageManager = 'npm';
  } else if (fs.existsSync(path.join(process.cwd(), 'pnpm-lock.yaml'))) {
    packageManager = 'pnpm';
  } else if (fs.existsSync(path.join(process.cwd(), 'bun.lock'))) {
    packageManager = 'bun';
  }
  
  // Also check the serve command to further confirm package manager
  if (serveCmd.startsWith('npm ')) {
    packageManager = 'npm';
  } else if (serveCmd.startsWith('yarn ')) {
    packageManager = 'yarn';
  } else if (serveCmd.startsWith('pnpm ')) {
    packageManager = 'pnpm';
  }
  
  return packageManager;
}

async function installDependencies(packageManager: string): Promise<void> {
  try {
    // Install based on detected package manager
    let installCmd = getInstallCommand(packageManager);
    
    log(`Running: ${installCmd}`);
    execSync(installCmd, {
      stdio: process.env.DEBUG ? 'inherit' : 'pipe',
      timeout: 120000 // Give it up to 2 minutes for dependency installation
    });
    
    pretty(`✅ Dependencies installed successfully`, "success");
  } catch (installError) {
    // Fall back to a more basic install if specific approach fails
    const errorMsg = installError instanceof Error ? installError.message : String(installError);
    pretty(`First install attempt failed: ${errorMsg}`, "warning");
    pretty(`Trying again with bun...`, "warning");
    
    try {
      execSync('bun install --no-save --exact', {
        stdio: 'inherit',
        timeout: 120000
      });
      pretty(`✅ Dependencies installed with fallback method`, "success");
    } catch (fallbackError) {
      const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      pretty(`❌ Dependency installation failed: ${fallbackMsg}`, "error");
      // Continue anyway - some commits might work without all deps
    }
  }
}

function getInstallCommand(packageManager: string): string {
  switch (packageManager) {
    case 'yarn':
      return 'yarn install --frozen-lockfile';
    case 'npm':
      return 'npm ci';
    case 'pnpm':
      return 'pnpm install --frozen-lockfile';
    case 'bun':
    default:
      return 'bun install --no-save --exact';
  }
}

/**
 * Check if package.json has changed and extract dependency changes
 */
async function checkPackageJsonChanges(prevPackageJson: string): Promise<{ packageJsonChanged: boolean; newPkgContent?: string }> {
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    if (!fs.existsSync(pkgPath)) {
      return { packageJsonChanged: false };
    }
    
    const currentPackageJson = fs.readFileSync(pkgPath, "utf8");
    
    // If the files are identical, no change
    if (currentPackageJson === prevPackageJson) {
      log("package.json unchanged from previous commit");
      return { packageJsonChanged: false };
    }
    
    // Parse package.json to compare dependencies specifically
    try {
      const prevPkg = JSON.parse(prevPackageJson || "{}");
      const currentPkg = JSON.parse(currentPackageJson);
      
      const prevDeps = {
        ...(prevPkg.dependencies || {}),
        ...(prevPkg.devDependencies || {})
      };
      
      const currentDeps = {
        ...(currentPkg.dependencies || {}),
        ...(currentPkg.devDependencies || {})
      };
      
      // Compare dependencies specifically
      const depsChanged = JSON.stringify(prevDeps) !== JSON.stringify(currentDeps);
      
      if (depsChanged) {
        log("package.json dependencies have changed since previous commit");
        return { packageJsonChanged: true, newPkgContent: currentPackageJson };
      } else {
        log("package.json content changed but dependencies are the same");
        return { packageJsonChanged: false, newPkgContent: currentPackageJson };
      }
    } catch (parseError) {
      // If there's a parsing error, assume we need to reinstall
      log(`Error parsing package.json: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      return { packageJsonChanged: true, newPkgContent: currentPackageJson };
    }
  } catch (pkgError) {
    const errorMsg = pkgError instanceof Error ? pkgError.message : String(pkgError);
    pretty(`❌ Error checking dependencies: ${errorMsg}`, "error");
    return { packageJsonChanged: false };
  }
}

// Track original branch for safety (read-only)
let originalBranch: string = "";

// Setup process exit handler for safety
function setupSafetyExitHandler() {
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

async function main() {
  setupSafetyExitHandler();
  
  try {
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
    log("Gathering commits from git history");
    let commitCmd = "git log --all --date-order --pretty=format:%H"; // Get all commits from all branches in chronological order
    if (config.branch) {
      commitCmd = `git log ${config.branch} --date-order --pretty=format:%H`;
      log(`Using branch restriction: ${config.branch}`);
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
    if (config.maxCommits && config.maxCommits > 0 && commits.length > config.maxCommits) {
      log(`Limiting to ${config.maxCommits} commits as requested`);
      commits = commits.slice(0, config.maxCommits);
    }
    
    // Check if we can resume from a previous run
    const startIndexResult = await checkResumeAndPrompt({
      outDir,
      framesPattern,
      commits
    });
    
    // If startIndexResult is -1, all commits have already been processed
    if (startIndexResult === -1) {
      // Check if there's already a video file in the output directory
      const existingVideos = fs.readdirSync(outDir)
        .filter(file => file.toLowerCase().endsWith('.mp4') && file.includes('timelapse'));
      
      if (existingVideos.length === 0) {
        // No video exists yet, so generate one from the existing frames
        pretty("No timelapse video found. Generating one from existing frames...", "info");
        const outputVideoPath = await generateTimeLapseVideo(outDir, framesPattern, width, height, config.fps);
        if (outputVideoPath) {
          pretty(`✅ Done! Video saved at: ${outputVideoPath}`, "success");
        }
      } else {
        // Video already exists
        pretty(`Existing timelapse video(s) found: ${existingVideos.join(', ')}`, "info");
        
        // Ask if user wants to generate a new video anyway
        const generateNewVideo = await getUserConfirmation("Generate a new video from existing frames?");
        if (generateNewVideo) {
          const outputVideoPath = await generateTimeLapseVideo(outDir, framesPattern, width, height, config.fps);
          if (outputVideoPath) {
            pretty(`✅ Done! New video saved at: ${outputVideoPath}`, "success");
          }
        }
      }
      return;
    }
    
    // Otherwise, use the returned start index
    const startIndex = startIndexResult;

    if (commits.length === 0) {
      console.error("No commits found in repository history.");
      process.exit(1);
    }
    log(`Will process ${commits.length} commits`);
    
    // Log first few commits to aid debugging
    log("First few commits to process:");
    commits.slice(0, Math.min(5, commits.length)).forEach((sha, i) => {
      const shortSha = sha.substring(0, 8);
      const message = execSync(`git show -s --format=%s ${sha}`).toString().trim();
      log(`  ${i+1}. ${shortSha} - ${message}`);
    });
    
    // Show commit count and confirm with gum
    log("Prompting for user confirmation");
    
    // Use gum for nice formatting
    pretty(`Found ${commits.length} commits to process.`, 'info');
    
    // Create variable to track previous package.json for dependency change detection
    let prevPackageJson = "";
    
    // User confirmation for large commit counts
    if (commits.length > 10) {
      log(`Asking confirmation for processing ${commits.length} commits`);
      
      // Use gum format for the warning
      pretty(`Processing ${commits.length} commits may take a while.`, 'warning');
      
      try {
        // Use gum confirm for interactive input (restoring the pretty interface)
        const confirm = await getUserConfirmation(`${commits.length} commits found. Continue?`);
        log(`User confirmation result: ${confirm}`);
        
        if (!confirm) {
          pretty("Operation cancelled by user.", 'error');
          return;
        }
        
        // Add a separator line after confirmation
        console.log('');
      } catch (confirmError) {
        // If there's an error with the confirmation, log it and continue anyway
        log(`Error getting user confirmation: ${confirmError instanceof Error ? confirmError.message : String(confirmError)}`);
        console.log('Continuing by default...');
      }
    }

    // Save current branch to return to it later (read-only)
    log("Saving current branch name for restoration");
    try {
      // Just record the branch name, no modifications to the repo
      originalBranch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
      log(`Current branch is: ${originalBranch}`);
    } catch (error) {
      console.error("ERROR: Failed to determine current branch");
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    
    // We'll install directly in the project

    // Launch browser
    log("Launching puppeteer browser");
    const browser = await puppeteer.launch();
    log("Browser launched successfully");
    log("Creating new page");
    const page = await browser.newPage();
    log("Setting viewport dimensions");
    await page.setViewport({ width, height });
    log(`Viewport set to ${width}x${height}`);

    // Parse and modify the server command
function prepareServerCommand(serveCmd: string, port: number) {
  log("Preparing server command");
  const cmdParts = serveCmd.split(" ");
  const cmd = cmdParts[0] || "bun";
  const parts = cmdParts.slice(1);
  
  // Use the original command as a starting point
  let modifiedCmd = cmd;
  let modifiedParts = [...parts];
  
  // For dev servers, add port flag if not present
  if (serveCmd.includes('dev') || serveCmd.includes('start') || serveCmd.includes('serve')) {
    log("Detected dev server command");
    
    if (!serveCmd.includes('--port') && !serveCmd.includes('-p')) {
      if (cmd === 'npm') {
        // For npm, we need to pass args differently
        modifiedParts.push('--');
        modifiedParts.push(`--port=${port}`);
      } else {
        // For other package managers
        modifiedParts.push(`--port=${port}`);
      }
      log(`Added explicit port ${port} to server command`);
    }
  }
  
  return { cmd: modifiedCmd, args: modifiedParts };
}

// Create a promise that rejects when the server exits unexpectedly
function createEarlyExitDetector(server: any, errorDetailsGetter: () => string) {
  return new Promise((_, reject) => {
    server.on('exit', (code: number | null, signal: string | null) => {
      if (code !== null || signal !== null) {
        log(`Server exited early with ${code !== null ? `code ${code}` : `signal ${signal}`}`);
        const error = errorDetailsGetter() || 
          `Server exited unexpectedly with ${code !== null ? `code ${code}` : `signal ${signal}`}`;
        reject(new Error(error));
      }
    });
  });
}

// Create a promise that resolves when the server appears ready
function createServerReadyDetector(server: any, waitMs: number, errorDetailsGetter: () => string) {
  return new Promise<boolean>(resolve => {
    let isReady = false;
    
    // Check stdout for ready indicators
    const stdoutListener = (data: Buffer) => {
      const output = data.toString();
      // Look for common "ready" messages in server output
      if (output.includes('ready') || 
          output.includes('listening') || 
          output.includes('started') || 
          output.includes('running') ||
          output.includes('localhost')) {
        isReady = true;
        resolve(true);
      }
    };
    
    if (server.stdout) {
      server.stdout.on('data', stdoutListener);
    }
    
    // Also set a timeout to resolve anyway if we don't see ready message
    setTimeout(() => {
      const errorDetails = errorDetailsGetter();
      if (!isReady && !errorDetails) {
        resolve(true);
      } else if (!isReady && errorDetails) {
        resolve(false);
      }
    }, waitMs);
  });
}

// Process server output to detect errors
function setupOutputHandlers(server: any) {
  let serverOutputBuffer = "";
  let serverErrorBuffer = "";
  let errorDetails = "";
  
  // Configure error handling
  server.on('error', (err: Error) => {
    const errMsg = err?.message || String(err);
    log(`Server process error: ${errMsg}`);
    errorDetails = `Process error: ${errMsg}`;
  });
  
  // Capture stdout
  if (server.stdout) {
    server.stdout.on('data', (data: Buffer) => {
      const output = data.toString();
      serverOutputBuffer += output;
      
      // Log output for debugging
      output.split('\n').filter(Boolean).forEach((line: string) => {
        log(`Server stdout: ${line.trim()}`);
      });
      
      // Look for error indicators
      if ((output.includes('Error') || output.includes('error')) && 
          !output.includes('compiled') && 
          !output.includes('successfully')) {
        errorDetails = output.split('\n')
          .find((line: string) => line.includes('Error') || line.includes('error'))
          ?.trim() || output.trim();
      }
      
      // Look for dependency issues
      if (output.includes('not found') || output.includes('missing')) {
        const match = output.match(/['"]([^'"]+)['"] not found/) || 
                     output.match(/missing ([^'"]+)/i);
        if (match && match[1]) {
          errorDetails = `Missing dependency: ${match[1]}`;
        }
      }
    });
  }
  
  // Capture stderr
  if (server.stderr) {
    server.stderr.on('data', (data: Buffer) => {
      const output = data.toString();
      serverErrorBuffer += output;
      
      // Log error output for debugging
      output.split('\n').filter(Boolean).forEach((line: string) => {
        log(`Server stderr: ${line.trim()}`);
      });
      
      // Capture error details
      if (!errorDetails && (
          output.includes('Error') || 
          output.includes('error') || 
          output.includes('not found')
      )) {
        errorDetails = output.trim().split('\n')[0] || '';
      }
    });
  }
  
  return () => errorDetails;
}

// Server management functions
async function startServer() {
  log("Preparing to start server");
  
  // Parse the serve command
  const { cmd, args } = prepareServerCommand(serveCmd, port);
  log(`Spawning server process: ${cmd} ${args.join(" ")}`);
  
  try {
    // Spawn the server process, detached so it runs in the background
    const server = spawn(cmd, args, { 
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: 'true' },
      detached: true
    });
    
    if (!server || !server.pid) {
      throw new Error("Failed to spawn server process - no process ID");
    }
    
    // Setup output handlers and get a function to retrieve error details
    const getErrorDetails = setupOutputHandlers(server);
    
    // Create promises for server status detection
    const earlyExitPromise = createEarlyExitDetector(server, getErrorDetails);
    const serverReadyPromise = createServerReadyDetector(server, waitMs, getErrorDetails);
    
    // Wait for server to start up or fail
    log(`Waiting ${waitMs}ms for server to start`);
    
    // Wait for the server to be ready or fail early
    const result = await Promise.race([serverReadyPromise, earlyExitPromise]);
    
    // serverReadyPromise returns true if ready, earlyExitPromise throws on error
    if (result === false) {
      throw new Error(getErrorDetails() || "Server startup failed silently");
    }
    
    // Final error check
    const errorDetails = getErrorDetails();
    if (errorDetails) {
      throw new Error(errorDetails);
    }
    
    log("Server is ready");
    return server;
  } catch (serverError) {
    const errorMsg = serverError instanceof Error ? serverError.message : String(serverError);
    log(`Server start failed: ${errorMsg}`);
    
    // Ensure we have a meaningful error message
    if (!errorMsg || errorMsg === "error when starting dev server:") {
      throw new Error("Failed to start server - check dependencies and server configuration");
    } else {
      throw new Error(`${errorMsg}`);
    }
  }
}

async function stopServer(server: any) {
  log("Stopping server");
  if (!server || typeof server.kill !== 'function') {
    log("Warning: Server object not valid or missing kill function");
    return;
  }
  
  try {
    // Kill entire process group (for detached processes)
    server.kill('SIGTERM'); 
    
    // Handle platform-specific cleanup
    if (process.platform === 'win32') {
      // Windows needs special handling for detached processes
      execSync(`taskkill /pid ${server.pid} /t /f`, { stdio: 'ignore' });
    } else {
      try {
        // Try sending SIGKILL to make sure it's gone
        process.kill(-server.pid, 'SIGKILL');
      } catch (killError) {
        // Ignore errors, as the process might already be gone
      }
    }
    
    log("Server process killed");
  } catch (killError) {
    log(`Error killing server: ${killError instanceof Error ? killError.message : String(killError)}`);
  }
}
    
    try {
      // Iterate commits
      log("Beginning frame creation process");
      
      // Initial checkout and setup
      if (commits.length > 0) {
        // If we're resuming, checkout the commit at the resume point
        // Otherwise, checkout the first commit
        const commitToCheckout = startIndex > 0 ? commits[startIndex] : commits[0];
        
        if (commitToCheckout) {
          log(`Checking out initial commit: ${commitToCheckout.substring(0, 8)}`);
          execSync(`git checkout ${commitToCheckout} --quiet`);
          log("Initial commit checked out successfully");
          
          // Store original package.json content for comparison and restoration
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
          const sha = commits[i];
          
          // Skip undefined or empty SHA values
          if (!sha) {
            log(`Skipping undefined commit at index ${i}`);
            continue;
          }
          
          log(`Processing commit ${i+1}/${commits.length}: ${sha.substring(0, 8)}`);
          
          // Get commit date and message
          log("Getting commit metadata");
          const date = execSync(`git show -s --format=%ci ${sha}`).toString().trim();
          const message = execSync(`git show -s --format=%s ${sha}`).toString().trim();
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
            execSync(`git checkout ${sha} --quiet`);
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
                server = await startServer();
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
              
              continue; // Skip to next commit if server fails to start
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
              skipCommitWithWarning(i, commits.length, sha, message, "Navigation failed silently");
              continue;
            }
            
            // Check for HTTP error status codes
            if (!await isResponseSuccessful(page, response, i, commits.length, sha, message)) {
              continue;
            }
            
            // Check for client-side error pages
            if (await isErrorPage(page)) {
              const errorMessage = await extractErrorMessage(page);
              skipCommitWithWarning(i, commits.length, sha, message, errorMessage);
              continue;
            }
            
            // Check for empty pages
            if (await isEmptyPage(page)) {
              skipCommitWithWarning(i, commits.length, sha, message, "Empty or loading page");
              continue;
            }
            
            // Save the screenshot
            await saveScreenshot(page, i, commits.length, message, framesPattern);
          } catch (navError) {
            handleNavigationError(navError, i, commits.length, sha, message);
          }
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
      await restoreRepositoryState();
    }
    
    // Function to restore repository state with fallbacks
    async function restoreRepositoryState() {
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
    
    async function tryCheckoutHead() {
      try {
        execSync(`git checkout HEAD --quiet`);
        log(`Restored repository to HEAD`);
        return true;
      } catch (headError) {
        return false;
      }
    }
    
    async function tryCheckoutMain() {
      try {
        execSync(`git checkout main --quiet`);
        log(`Restored repository to main branch`);
        return true;
      } catch (mainError) {
        return false;
      }
    }
    
    async function tryCheckoutMaster() {
      try {
        execSync(`git checkout master --quiet`);
        log(`Restored repository to master branch`);
        return true;
      } catch (masterError) {
        return false;
      }
    }

    // Build video from the captured frames
    const outputVideoPath = await generateTimeLapseVideo(outDir, framesPattern, width, height, config.fps);

    // Restore original dependencies
    await cleanupEnvironment();
    
    // Report the number of frames
    try {
      // Count the number of frames
      const framesGlob = `${framesPattern}*.png`;
      const frameFiles = execSync(`ls ${framesGlob} 2>/dev/null || echo ""`).toString().trim().split("\n").filter(Boolean);
      
      const processedCount = frameFiles.length;
      pretty(`\nCreated ${processedCount} frames out of ${commits.length} commits`, "info");
    } catch (error) {
      // Ignore errors in summary calculation
    }
    
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
  } catch (error) {
    pretty("❌ FATAL ERROR:", "error");
    pretty(error instanceof Error ? error.message : String(error), "error");
    
    // If we have a stack trace, show it in debug mode
    if (error instanceof Error && error.stack && process.env.DEBUG) {
      console.error(error.stack);
    }
    
    // Try to clean up any lock files even in case of error
    try {
      const lockFilePath = path.join(process.cwd(), 'bun.lock');
      if (fs.existsSync(lockFilePath)) {
        fs.unlinkSync(lockFilePath);
        log("Removed generated bun.lock file");
      }
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    
    process.exit(1);
  }
}

// Screenshot handling functions
async function navigateWithRetry(page: any, url: string, waitMs: number) {
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
    retryAttempted = true;
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

async function isResponseSuccessful(page: any, response: any, commitIndex: number, totalCommits: number, sha: string, message: string) {
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

async function extractHttpErrorDetails(page: any) {
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

async function isErrorPage(page: any) {
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
  let isDefiniteErrorPage = false;
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
      if (Array.from(contentElements).length < 3 && (document.body.textContent?.trim().length || 0) < 50) {
        return true;
      }
      
      return false;
    });
  } catch (evalError) {
    // If evaluation fails, assume it's not an error page
    isDefiniteErrorPage = false;
  }
  
  return isDefiniteErrorPage || hasExplicitErrorContent;
}

async function extractErrorMessage(page: any) {
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

async function isEmptyPage(page: any) {
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

async function saveScreenshot(page: any, commitIndex: number, totalCommits: number, message: string, framesPattern: string | undefined) {
  // Create filename from commit message
  const commitWords = message.split(' ');
  const truncatedMessage = commitWords.slice(0, 5).join('_').replace(/[^a-zA-Z0-9_-]/g, '');
  const frame = `${framesPattern}${String(commitIndex).padStart(3, "0")}_${truncatedMessage}.png`;
  
  log(`Saving screenshot to: ${frame}`);
  await page.screenshot({ path: frame, fullPage: true });
  
  // Verify the screenshot was created
  if (!fs.existsSync(frame)) {
    pretty(`❌ Failed to create screenshot at ${frame}`, "error");
    process.exit(1);
  }
  
  // Success message
  pretty(`✅ [${commitIndex+1}/${totalCommits}] Screenshot saved`, "success");
}

function skipCommitWithWarning(commitIndex: number, totalCommits: number, sha: string, message: string | undefined, reason: string | undefined) {
  const safeMessage = message || '(no message)';
  const safeReason = reason || 'Unknown error';
  pretty(`⚠️ Commit ${commitIndex+1}/${totalCommits}: ${sha.substring(0, 8)} - ${safeMessage}`, "warning");
  pretty(`   No screenshot saved - ${safeReason}`, "warning");
}

function handleNavigationError(error: any, commitIndex: number, totalCommits: number, sha: string, message: string) {
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

/**
 * Generate a video from captured frames
 */
async function generateTimeLapseVideo(outDir: string, framesPattern: string | undefined, width: number, height: number, fps: number): Promise<string | undefined> {
  if (!framesPattern) {
    throw new Error("Frame pattern is required");
  }
  pretty("Creating timelapse video...", "info");
  
  // Find captured frames
  const frameFiles = findCapturedFrames(outDir, framesPattern);
  
  if (frameFiles.length === 0) {
    pretty("❌ No frames were created. Cannot generate video.", "error");
    process.exit(1);
  }
  
  // Special handling for single frame case
  if (frameFiles.length === 1 && frameFiles[0]) {
    log("Only one frame detected, will duplicate it to create a valid video");
    // Duplicate the frame to ensure we can create a video (needs at least 2 frames)
    frameFiles.push(frameFiles[0]);
  }
  
  pretty(`Found ${frameFiles.length} frames, generating video...`, "info");
  
  // Create a unique filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const outputVideoPath = path.join(outDir, `timelapse-${timestamp}.mp4`);
  
  try {
    // Instead of using a concat file, we'll create a temp directory with numerically
    // named files that FFmpeg can use with a pattern
    const tmpDir = path.join(os.tmpdir(), `ffmpeg-frames-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    
    try {
      log(`Created temporary directory for frame sequence: ${tmpDir}`);
      
      // Copy all frames to the temporary directory with sequential names
      const sortedFrames = frameFiles.sort((a, b) => {
        const numA = parseInt(a.match(/frame_(\d+)_/)?.[1] || '0');
        const numB = parseInt(b.match(/frame_(\d+)_/)?.[1] || '0');
        return numA - numB;
      });
      
      // Create symbolic links to the original files with sequential names
      for (let i = 0; i < sortedFrames.length; i++) {
        const sourcePath = sortedFrames[i];
        if (!sourcePath) continue;
        
        const destPath = path.join(tmpDir, `img_${String(i).padStart(6, '0')}.png`);
        fs.copyFileSync(sourcePath, destPath);
        log(`Copied frame ${i+1}/${sortedFrames.length} to ${destPath}`);
      }
      
      // Construct the ffmpeg command using the sequence pattern
      const imgPattern = path.join(tmpDir, 'img_%06d.png');
      const ffmpegCmd = `ffmpeg -y -i "${imgPattern}" -r ${fps} -s ${width}x${height} -c:v libx264 -pix_fmt yuv420p -movflags faststart "${outputVideoPath}"`;
      
      log(`Running direct FFmpeg command: ${ffmpegCmd}`);
      execSync(ffmpegCmd);
      
      // Verify the video was created
      if (!fs.existsSync(outputVideoPath)) {
        throw new Error("Failed to create video file - output file does not exist");
      }
      
      pretty("✅ Video creation successful!", "success");
      return outputVideoPath;
    } finally {
      // Clean up the temporary directory
      try {
        log(`Cleaning up temporary directory: ${tmpDir}`);
        // Use a simple find and rm command for better compatibility
        execSync(`rm -rf "${tmpDir}"`);
      } catch (cleanupError) {
        log(`Warning: Failed to clean up temporary directory: ${cleanupError}`);
      }
    }
  } catch (ffmpegError) {
    pretty("❌ Error creating video:", "error");
    pretty(ffmpegError instanceof Error ? ffmpegError.message : String(ffmpegError), "error");
    
    // Try one more fallback approach without any temp files
    try {
      log("Trying alternative approach with direct glob pattern...");
      
      const frameDir = path.dirname(frameFiles[0] || '');
      const simpleCmd = `ffmpeg -y -pattern_type glob -i "${frameDir}/*.png" -r ${fps} -s ${width}x${height} -c:v libx264 -pix_fmt yuv420p "${outputVideoPath}"`;
      
      log(`Running fallback FFmpeg command: ${simpleCmd}`);
      execSync(simpleCmd);
      
      if (fs.existsSync(outputVideoPath)) {
        pretty("✅ Video creation successful with fallback method!", "success");
        return outputVideoPath;
      }
    } catch (fallbackError) {
      log(`Fallback approach failed: ${fallbackError}`);
      pretty("All video creation attempts failed. Please try manually using ffmpeg.", "error");
      process.exit(1);
    }
    
    process.exit(1);
  }
}

/**
 * Find all captured frames in the output directory
 */
function findCapturedFrames(outDir: string, framesPattern: string | undefined): string[] {
  if (!framesPattern) {
    throw new Error("Frame pattern is required");
  }
  const frameGlob = `${framesPattern}*.png`;
  return execSync(`ls ${frameGlob} 2>/dev/null || echo ""`)
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
}

// The video generation functionality has been completely rewritten
// and integrated into the generateTimeLapseVideo function

/**
 * Clean up environment before exiting
 */
async function cleanupEnvironment() {
  pretty("Restoring original dependencies...", "info");
  
  try {
    // Detect package manager
    const packageManager = detectPackageManager('');
    const installCmd = getRegularInstallCommand(packageManager);
    
    log(`Reinstalling dependencies with: ${installCmd}`);
    execSync(installCmd, { stdio: 'pipe' });
    pretty("✅ Original dependencies restored", "success");
  } catch (restoreError) {
    const errorMsg = restoreError instanceof Error ? restoreError.message : String(restoreError);
    pretty(`Warning: Could not restore original dependencies: ${errorMsg}`, "warning");
    pretty("You may need to run 'npm install' or equivalent manually.", "warning");
  }
  
  await cleanupTempFiles();
}

/**
 * Get standard install command (not the --frozen-lockfile version)
 */
function getRegularInstallCommand(packageManager: string): string {
  switch (packageManager) {
    case 'yarn':
      return 'yarn install';
    case 'npm':
      return 'npm install';
    case 'pnpm':
      return 'pnpm install';
    case 'bun':
    default:
      return 'bun install';
  }
}

/**
 * Clean up any temporary files created during execution
 */
async function cleanupTempFiles() {
  // Check for and delete any lock files that might have been created by bun
  const lockFilePath = path.join(process.cwd(), 'bun.lock');
  if (fs.existsSync(lockFilePath) && !fs.existsSync(path.join(process.cwd(), 'bun.lockb'))) {
    // Only remove if it's not a regular bun project that uses bun.lock
    try {
      fs.unlinkSync(lockFilePath);
      log("Removed generated bun.lock file");
    } catch (err) {
      log(`Warning: Could not remove lock file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main();
