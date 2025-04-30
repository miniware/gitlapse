import { describe, test, expect } from "bun:test";
import { parseArgs, detectServeCommand } from "../cli";
import path from "path";

describe("parseArgs", () => {
  test("should use default values when no args provided", () => {
    const cwd = "/test/dir";
    const config = parseArgs([], cwd);

    expect(config.outDir).toBe(path.join(cwd, "timelapse"));
    expect(config.width).toBe(1440);
    expect(config.height).toBe(720);
    expect(config.waitBeforeMs).toBe(3000);
    expect(config.waitAfterMs).toBe(0);
    expect(config.route).toBe("/");
    expect(config.port).toBe(3000);
    expect(config.branch).toBeUndefined();
    expect(config.maxCommits).toBeUndefined();
    expect(config.fps).toBe(12);
  });

  test("parses width and height", () => {
    const config = parseArgs(["-w", "800", "--height", "600"]);

    expect(config.width).toBe(800);
    expect(config.height).toBe(600);
  });

  test("parses outDir correctly", () => {
    const cwd = "/test/dir";
    const config = parseArgs(["-o", "output"], cwd);

    expect(config.outDir).toBe(path.join(cwd, "output"));
  });

  test("parses route with leading slash", () => {
    const config = parseArgs(["-r", "test"]);

    expect(config.route).toBe("/test");
  });

  test("maintains leading slash in route", () => {
    const config = parseArgs(["-r", "/test"]);

    expect(config.route).toBe("/test");
  });

  test("parses port", () => {
    const config = parseArgs(["-p", "8080"]);

    expect(config.port).toBe(8080);
  });

  test("parses branch", () => {
    const config = parseArgs(["--branch", "develop"]);

    expect(config.branch).toBe("develop");
  });

  test("parses maxCommits", () => {
    const config = parseArgs(["--max-commits", "50"]);

    expect(config.maxCommits).toBe(50);
  });

  test("parses fps", () => {
    const config = parseArgs(["--fps", "30"]);

    expect(config.fps).toBe(30);
  });

  test("parses wait-before time", () => {
    const config = parseArgs(["--wait-before", "5000"]);

    expect(config.waitBeforeMs).toBe(5000);
  });

  test("parses wait-after time", () => {
    const config = parseArgs(["--wait-after", "2000"]);

    expect(config.waitAfterMs).toBe(2000);
  });

  test("parses wait time as alias for wait-before", () => {
    const config = parseArgs(["--wait", "5000"]);

    expect(config.waitBeforeMs).toBe(5000);
  });

  test("throws on unknown argument", () => {
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown argument: --unknown");
  });
});

describe("detectServeCommand", () => {
  test("should prefer dev script when available", () => {
    const scripts = {
      dev: "vite dev",
      start: "node server.js"
    };

    expect(detectServeCommand(scripts)).toBe("bun run dev");
  });

  test("should use start script when dev is not available", () => {
    const scripts = {
      start: "next start",
      build: "next build"
    };

    expect(detectServeCommand(scripts)).toBe("bun run start");
  });

  test("should throw when neither dev nor start scripts are available", () => {
    const scripts = {
      build: "next build",
      lint: "eslint ."
    };

    expect(() => detectServeCommand(scripts)).toThrow("No 'dev' or 'start' script found in package.json.");
  });
});

describe("parseArgs error cases", () => {
  const cwd = "/test";
  const flags = [
    ["-o"], ["--out-dir"],
    ["-w"], ["--width"],
    ["-h"], ["--height"],
    ["--wait"], ["--wait-before"], ["--wait-after"],
    ["-r"], ["--route"],
    ["-p"], ["--port"],
    ["--branch"],
    ["--max-commits"],
    ["--fps"]
  ];
  for (const [flag] of flags) {
    test(`throws missing value for ${flag}`, () => {
      expect(() => parseArgs([flag as string], cwd)).toThrow(`Missing value for ${flag}`);
    });
  }
});