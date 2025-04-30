import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { log, pretty } from "./logger";

/**
 * Detect package manager from project files and command
 */
export function detectPackageManager(serveCmd: string): string {
  // For Rails-specific commands
  if (serveCmd.includes('bundle') || serveCmd.includes('rails')) {
    return 'bundle';
  }

  // Default to bun for JS projects
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

/**
 * Get install command with frozen lockfile for given package manager
 */
export function getInstallCommand(packageManager: string): string {
  switch (packageManager) {
    case 'bundle':
      return 'bundle install';
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
 * Get standard install command (not the --frozen-lockfile version)
 */
export function getRegularInstallCommand(packageManager: string): string {
  switch (packageManager) {
    case 'bundle':
      return 'bundle install';
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
 * Install dependencies using specified package manager
 */
export async function installDependencies(packageManager: string): Promise<void> {
  const pm = packageManager;
  const cmd = getInstallCommand(pm);
  try {
    log(`Running: ${cmd}`);
    execSync(cmd, { stdio: 'inherit', timeout: 120000 });
    pretty(`✅ Dependencies installed successfully`, "success");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    pretty(`❌ Dependency installation failed: ${msg}`, "error");
    // Continue anyway
  }
}

/**
 * Check if package.json has changed and extract dependency changes
 */
export async function checkPackageJsonChanges(prevPackageJson: string): Promise<{ 
  packageJsonChanged: boolean; 
  newPkgContent?: string 
}> {
  try {
    // Detect project type from the stored format
    if (prevPackageJson && prevPackageJson.startsWith('rails:')) {
      return handleRailsProjectChanges(prevPackageJson);
    } else if (prevPackageJson && prevPackageJson.startsWith('hybrid:')) {
      return handleHybridProjectChanges(prevPackageJson);
    } else {
      return handleJsProjectChanges(prevPackageJson);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    pretty(`❌ Error checking dependencies: ${errorMsg}`, "error");
    return { packageJsonChanged: false };
  }
}

/**
 * Check for dependency changes in a Rails project
 */
function handleRailsProjectChanges(prevPackageJson: string): { 
  packageJsonChanged: boolean; 
  newPkgContent?: string 
} {
  const gemfileLockPath = path.join(process.cwd(), "Gemfile.lock");
  if (!fs.existsSync(gemfileLockPath)) {
    // If no Gemfile.lock, consider it unchanged
    return { packageJsonChanged: false };
  }
  
  // Extract the previous timestamp
  const prevTimestampStr = prevPackageJson.split(':')[1] || "0";
  let prevTimestamp = 0;
  
  try {
    prevTimestamp = parseFloat(prevTimestampStr);
    if (isNaN(prevTimestamp)) {
      prevTimestamp = 0;
    }
  } catch (e) {
    prevTimestamp = 0;
  }
  
  // Get current timestamp
  const gemfileLockStats = fs.statSync(gemfileLockPath);
  
  if (gemfileLockStats.mtimeMs > prevTimestamp) {
    log("Gemfile.lock has changed since previous commit");
    return { packageJsonChanged: true, newPkgContent: `rails:${gemfileLockStats.mtimeMs}` };
  } else {
    log("Gemfile.lock unchanged from previous commit");
    return { packageJsonChanged: false, newPkgContent: `rails:${gemfileLockStats.mtimeMs}` };
  }
}

/**
 * Check for dependency changes in a hybrid project (Rails + JS)
 */
function handleHybridProjectChanges(prevPackageJson: string): { 
  packageJsonChanged: boolean; 
  newPkgContent?: string 
} {
  const parts = prevPackageJson.split(':');
  if (parts.length < 3) {
    // Invalid format, assume changed
    return { packageJsonChanged: true };
  }
  
  const prevGemfileTimestamp = parseFloat(parts[1] || "0");
  const prevPkgContent = parts.slice(2).join(':');
  
  let gemfileChanged = false;
  let pkgJsonChanged = false;
  
  // Check Gemfile.lock changes
  const gemfileLockPath = path.join(process.cwd(), "Gemfile.lock");
  let currentGemfileTimestamp = 0;
  
  if (fs.existsSync(gemfileLockPath)) {
    const gemfileLockStats = fs.statSync(gemfileLockPath);
    currentGemfileTimestamp = gemfileLockStats.mtimeMs;
    
    if (currentGemfileTimestamp > prevGemfileTimestamp) {
      gemfileChanged = true;
      log("Gemfile.lock has changed since previous commit");
    }
  }
  
  // Check package.json changes
  const pkgPath = path.join(process.cwd(), "package.json");
  let currentPkgContent = "";
  
  if (fs.existsSync(pkgPath)) {
    currentPkgContent = fs.readFileSync(pkgPath, "utf8");
    
    // Compare package.json dependencies
    try {
      const prevPkg = JSON.parse(prevPkgContent || "{}");
      const currentPkg = JSON.parse(currentPkgContent);
      
      const prevDeps = {
        ...(prevPkg.dependencies || {}),
        ...(prevPkg.devDependencies || {})
      };
      
      const currentDeps = {
        ...(currentPkg.dependencies || {}),
        ...(currentPkg.devDependencies || {})
      };
      
      // Compare dependencies specifically
      pkgJsonChanged = JSON.stringify(prevDeps) !== JSON.stringify(currentDeps);
      
      if (pkgJsonChanged) {
        log("package.json dependencies have changed since previous commit");
      }
    } catch (parseError) {
      // If there's a parsing error, assume we need to reinstall
      log(`Error parsing package.json: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      pkgJsonChanged = true;
    }
  }
  
  // Return true if either dependency source changed
  return { 
    packageJsonChanged: gemfileChanged || pkgJsonChanged, 
    newPkgContent: `hybrid:${currentGemfileTimestamp}:${currentPkgContent}`
  };
}

/**
 * Check for dependency changes in a JavaScript project
 */
function handleJsProjectChanges(prevPackageJson: string): { 
  packageJsonChanged: boolean; 
  newPkgContent?: string 
} {
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
}

/**
 * Clean up environment before exiting
 */
export async function cleanupEnvironment(): Promise<void> {
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
 * Clean up any temporary files created during execution
 */
export async function cleanupTempFiles(): Promise<void> {
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