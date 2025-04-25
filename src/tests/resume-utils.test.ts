import { describe, test, expect } from "bun:test";
import { checkResumeAndPrompt } from "../resume-utils";
import type { ResumeOptions, ResumeDependencies } from "../resume-utils";

describe("checkResumeAndPrompt", () => {
  const defaultOptions: ResumeOptions = {
    outDir: "/test/dir/out",
    framesPattern: "/test/dir/out/frame_",
    commits: ["sha1", "sha2", "sha3"]
  };
  
  test("returns 0 when no frames found", async () => {
    // Create mock dependencies
    const mockDeps: ResumeDependencies = {
      fileUtils: {
        findLastProcessedFrame: () => -1,
        getLastCommitInfo: () => undefined
      },
      logger: {
        pretty: () => {}
      },
      userInteraction: {
        getUserConfirmation: async () => true
      }
    };
    
    const result = await checkResumeAndPrompt(defaultOptions, mockDeps);
    expect(result).toBe(0);
  });
  
  test("returns 0 when last commit info not found", async () => {
    // Create mock dependencies
    const mockDeps: ResumeDependencies = {
      fileUtils: {
        findLastProcessedFrame: () => 1,
        getLastCommitInfo: () => undefined
      },
      logger: {
        pretty: () => {}
      },
      userInteraction: {
        getUserConfirmation: async () => true
      }
    };
    
    const result = await checkResumeAndPrompt(defaultOptions, mockDeps);
    expect(result).toBe(0);
  });
  
  test("returns next index when user confirms resume", async () => {
    // Create mock dependencies
    const mockDeps: ResumeDependencies = {
      fileUtils: {
        findLastProcessedFrame: () => 1,
        getLastCommitInfo: () => ({
          sha: "sha2",
          shortSha: "sha2",
          message: "Test commit"
        })
      },
      logger: {
        pretty: () => {}
      },
      userInteraction: {
        getUserConfirmation: async () => true
      }
    };
    
    const result = await checkResumeAndPrompt(defaultOptions, mockDeps);
    expect(result).toBe(2); // Next index after index 1
  });
  
  test("returns 0 when user declines resume", async () => {
    // Create mock dependencies
    const mockDeps: ResumeDependencies = {
      fileUtils: {
        findLastProcessedFrame: () => 1,
        getLastCommitInfo: () => ({
          sha: "sha2",
          shortSha: "sha2",
          message: "Test commit"
        })
      },
      logger: {
        pretty: () => {}
      },
      userInteraction: {
        getUserConfirmation: async () => false
      }
    };
    
    const result = await checkResumeAndPrompt(defaultOptions, mockDeps);
    expect(result).toBe(0); // Start from beginning
  });
  
  test("returns -1 when all commits are already processed", async () => {
    // Create mock dependencies
    const mockDeps: ResumeDependencies = {
      fileUtils: {
        findLastProcessedFrame: () => 2,
        getLastCommitInfo: () => ({
          sha: "sha3",
          shortSha: "sha3",
          message: "Test commit"
        })
      },
      logger: {
        pretty: () => {}
      },
      userInteraction: {
        getUserConfirmation: async () => true
      }
    };
    
    const result = await checkResumeAndPrompt(defaultOptions, mockDeps);
    expect(result).toBe(-1); // Signal that all commits are already processed
  });
});