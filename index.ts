#!/usr/bin/env bun

import { execSync } from "bun";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { spawn } from "child_process";

// CLI args
const args = process.argv.slice(2);
let outDir = process.cwd();
let width = 1440;
let height = 720;
let waitMs = 3000;
let route = "/";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case "-o": case "--out-dir":
      outDir = path.resolve(process.cwd(), args[++i]);
      break;
    case "-w": case "--width":
      width = parseInt(args[++i], 10);
      break;
    case "-h": case "--height":
      height = parseInt(args[++i], 10);
      break;
    case "--wait":
      waitMs = parseInt(args[++i], 10);
      break;
    case "-r": case "--route":
      route = args[++i];
      break;
    default:
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
  }
}

// Ensure repo root
if (!fs.existsSync(path.join(process.cwd(), ".git"))) {
  console.error("No .git directory found. Run from repo root.");
  process.exit(1);
}

// Only support apps with package.json
const pkgPath = path.join(process.cwd(), "package.json");
if (!fs.existsSync(pkgPath)) {
  console.error("No package.json found. This tool supports only JS apps with package.json.");
  process.exit(1);
}

// Determine serve cmd from package.json
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
let serveCmd: string;
if (pkg.scripts?.dev) {
  serveCmd = "bun run dev";
} else if (pkg.scripts?.start) {
  serveCmd = "bun run start";
} else {
  console.error("No 'dev' or 'start' script found in package.json.");
  process.exit(1);
}

const url = "http://localhost:3000";
const framesPattern = path.join(outDir, "frame_");

// Gather commits
const commits = execSync("git rev-list --reverse HEAD")
  .toString()
  .trim()
  .split("\n");

// Launch browser
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.setViewport({ width, height });

// Iterate commits
for (const [i, sha] of commits.entries()) {
  console.log(`Checkout ${sha}`);
  execSync(`git checkout ${sha} --quiet`);

  // install deps
  execSync("bun install --quiet");

  // start server
  console.log("Starting server...");
  const [cmd, ...parts] = serveCmd.split(" ");
  const server = spawn(cmd, parts, { stdio: "ignore" });
  await new Promise(res => setTimeout(res, waitMs));

  // capture
  console.log(`Screenshot ${i + 1}/${commits.length} at ${route}`);
  await page.goto(url + route, { waitUntil: "networkidle0" });
  const frame = `${framesPattern}${String(i).padStart(3, "0")}.png`;
  await page.screenshot({ path: frame, fullPage: true });

  // stop server
  server.kill();
}

await browser.close();

// Reset branch to main
execSync("git checkout main --quiet");

// Build video
console.log("Building video...");
execSync(
  `ffmpeg -y -framerate 2 -pattern_type glob -i '${framesPattern}*.png' -s ${width}x${height} -c:v libx264 -pix_fmt yuv420p ${path.join(outDir, "timelapse.mp4")}`
);

console.log("Done. Video at:", path.join(outDir, "timelapse.mp4"));
