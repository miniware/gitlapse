import { spawn } from "child_process";
import { log, pretty } from "./logger";

interface ServerOptions {
  serveCmd: string;
  port: number;
  waitMs: number;
}

/**
 * Prepare server command with appropriate port settings
 */
export function prepareServerCommand(serveCmd: string, port: number) {
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

/**
 * Start the development server
 */
export async function startServer({ serveCmd, port, waitMs }: ServerOptions): Promise<any> {
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

/**
 * Stop the server
 */
export async function stopServer(server: any): Promise<void> {
  log("Stopping server");
  if (!server || typeof server.kill !== 'function') {
    log("Warning: Server object not valid or missing kill function");
    return;
  }

  try {
    // Kill entire process group: first SIGTERM, then SIGKILL to ensure shutdown
    server.kill('SIGTERM');
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      // Ignore errors, as process may already be terminated
    }

    log("Server process killed");
  } catch (killError) {
    log(`Error killing server: ${killError instanceof Error ? killError.message : String(killError)}`);
  }
}

/**
 * Create a promise that rejects when the server exits unexpectedly
 */
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

/**
 * Create a promise that resolves when the server appears ready
 */
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

/**
 * Process server output to detect errors
 */
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