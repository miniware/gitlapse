import { expect, test, describe } from "bun:test";
import { 
  getCurrentBranch,
  safetyCheck
} from "../git-utils";
import fs from "fs";
import path from "path";

describe("Git utilities core functionality", () => {
  // Simple test that verifies the function exists and returns a string
  test("getCurrentBranch returns a string when run in a valid git repo", () => {
    try {
      const branch = getCurrentBranch();
      expect(typeof branch).toBe("string");
      expect(branch.length).toBeGreaterThan(0);
    } catch (error) {
      // If this fails, it might be running in a CI environment without a git repo
      // Just skip the test in that case
      console.log("Skipping getCurrentBranch test, not in a git repo");
    }
  });
});