import path from "path";

export interface CliConfig {
  outDir: string;
  width: number;
  height: number;
  waitMs: number;
  route: string;
  port: number;
  branch?: string;
  maxCommits?: number;
  fps: number;
}

/** Parse command-line arguments into configuration. */
export function parseArgs(
  args: string[],
  cwd: string = process.cwd()
): CliConfig {
  let outDir = path.join(cwd, 'timelapse');
  let width = 1440;
  let height = 720;
  let waitMs = 3000;
  let route = "/";
  let port = 3000;
  let branch: string | undefined = undefined;
  let maxCommits: number | undefined = undefined;
  let fps = 12;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "-o":
      case "--out-dir":
        if (i + 1 >= args.length) {
          throw new Error(`Missing value for ${arg}`);
        }
        i++;
        outDir = path.resolve(cwd, args[i] || "");
        break;
      case "-w":
      case "--width":
        if (i + 1 >= args.length) {
          throw new Error(`Missing value for ${arg}`);
        }
        i++;
        width = parseInt(args[i] || "0", 10);
        break;
      case "-h":
      case "--height":
        if (i + 1 >= args.length) {
          throw new Error(`Missing value for ${arg}`);
        }
        i++;
        height = parseInt(args[i] || "0", 10);
        break;
      case "--wait":
        if (i + 1 >= args.length) {
          throw new Error(`Missing value for ${arg}`);
        }
        i++;
        waitMs = parseInt(args[i] || "0", 10);
        break;
      case "-r":
      case "--route":
        if (i + 1 >= args.length) {
          throw new Error(`Missing value for ${arg}`);
        }
        i++;
        const routeArg = args[i] || "";
        route = routeArg.startsWith("/") ? routeArg : `/${routeArg}`;
        break;
      case "-p":
      case "--port":
        if (i + 1 >= args.length) {
          throw new Error(`Missing value for ${arg}`);
        }
        i++;
        port = parseInt(args[i] || "3000", 10);
        break;
      case "--branch":
        if (i + 1 >= args.length) {
          throw new Error(`Missing value for ${arg}`);
        }
        i++;
        branch = args[i];
        break;
      case "--max-commits":
        if (i + 1 >= args.length) {
          throw new Error(`Missing value for ${arg}`);
        }
        i++;
        maxCommits = parseInt(args[i] || "0", 10);
        break;
      case "--fps":
        if (i + 1 >= args.length) {
          throw new Error(`Missing value for ${arg}`);
        }
        i++;
        fps = parseInt(args[i] || "12", 10);
        break;
      // Help is handled in index.ts
      default:``
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { outDir, width, height, waitMs, route, port, branch, maxCommits, fps };
}

export interface Scripts {
  [key: string]: string;
}

/** Determine serve command from package.json scripts. */
export function detectServeCommand(scripts: Scripts): string {
  if (scripts.dev) {
    return "bun run dev";
  }
  if (scripts.start) {
    return "bun run start";
  }
  throw new Error("No 'dev' or 'start' script found in package.json.");
}