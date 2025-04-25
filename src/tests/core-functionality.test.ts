// We're keeping only the most essential tests for now
// TODO: Expand these tests in a future update

import { describe, test, expect } from "bun:test";
import * as fileUtils from "../file-utils";
import { parseArgs } from "../cli";

describe("Core git-lapse functionality", () => {
  // Test CLI parsing which is core to the application
  test("CLI parsing correctly handles default values", () => {
    // Test with minimal arguments
    const config = parseArgs([], "/test/dir");
    
    // Verify default values
    expect(config.outDir).toBe("/test/dir/timelapse");
    expect(config.width).toBe(1440);
    expect(config.height).toBe(720);
    expect(config.waitMs).toBe(3000);
    expect(config.route).toBe("/");
    expect(config.port).toBe(3000);
    expect(config.fps).toBe(12);
  });
});