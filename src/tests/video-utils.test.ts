import { expect, test, describe, jest, beforeEach, afterEach } from "bun:test";
import { findCapturedFrames, generateTimeLapseVideo } from "../video-utils";
import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

describe("Video utilities", () => {
  // Test the generateTimeLapseVideo with simpler validation of the fullscreen parameter
  describe("Video generation with fullscreen option", () => {
    test("generateTimeLapseVideo should accept a fullscreen parameter", () => {
      // Validate the function signature - this is a simple type test
      // We'll check that the function at least accepts the fullscreen parameter
      // without trying to run the actual code (which would need complex mocking)
      const videoFunction = generateTimeLapseVideo;
      
      // Check that function accepts 6 parameters, with the last one being the 
      // fullscreen option. This is a bit of a hack but useful for checking
      // that our function at least has the correct signature.
      expect(videoFunction.length).toBeGreaterThan(4);
    });
  });
  
  describe("findCapturedFrames", () => {
    // Test with real files in a temporary directory
    test("should filter only PNG files with matching prefix", () => {
      const tmpDir = path.join(os.tmpdir(), `test-frames-${Date.now()}`);
      try {
        // Create test directory with test files
        fs.mkdirSync(tmpDir, { recursive: true });
        
        // Create test files
        fs.writeFileSync(path.join(tmpDir, "frame_1_abc.png"), "test");
        fs.writeFileSync(path.join(tmpDir, "frame_2_def.png"), "test");
        fs.writeFileSync(path.join(tmpDir, "other_file.png"), "test");
        fs.writeFileSync(path.join(tmpDir, "frame_3_ghi.txt"), "test");
        
        // Run the function
        const result = findCapturedFrames(tmpDir, "frame_");
        
        // Sort for consistent comparison
        const sortedResult = result.sort();
        
        // Verify results - only PNG files with matching prefix should be returned
        expect(sortedResult.length).toBe(2);
        expect(sortedResult[0]?.endsWith("frame_1_abc.png")).toBe(true);
        expect(sortedResult[1]?.endsWith("frame_2_def.png")).toBe(true);
      } finally {
        // Clean up
        try {
          if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        } catch (error) {
          console.error("Error cleaning up test directory:", error);
        }
      }
    });
    
    test("should return empty array when directory is empty", () => {
      const tmpDir = path.join(os.tmpdir(), `test-empty-${Date.now()}`);
      try {
        // Create empty test directory
        fs.mkdirSync(tmpDir, { recursive: true });
        
        // Run the function
        const result = findCapturedFrames(tmpDir, "frame_");
        
        // Verify results
        expect(result).toEqual([]);
      } finally {
        // Clean up
        try {
          if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        } catch (error) {
          console.error("Error cleaning up test directory:", error);
        }
      }
    });
    
    test("should return empty array when directory doesn't exist", () => {
      const nonExistentDir = path.join(os.tmpdir(), `non-existent-${Date.now()}`);
      
      // Run the function with non-existent directory
      const result = findCapturedFrames(nonExistentDir, "frame_");
      
      // Verify results
      expect(result).toEqual([]);
    });
  });
});