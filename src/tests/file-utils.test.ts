import { describe, test, expect } from "bun:test";
import { findLastProcessedFrame, getLastCommitInfo } from "../file-utils";

describe("findLastProcessedFrame", () => {
  test("returns -1 when output directory doesn't exist", () => {
    const mockDeps = {
      existsSync: () => false,
      execCommand: () => ""
    };
    
    expect(findLastProcessedFrame("/test/dir/out", "/test/dir/out/frame_", mockDeps)).toBe(-1);
  });
  
  test("returns -1 when no frames found", () => {
    const mockDeps = {
      existsSync: () => true,
      execCommand: () => ""
    };
    
    expect(findLastProcessedFrame("/test/dir/out", "/test/dir/out/frame_", mockDeps)).toBe(-1);
  });
  
  test("finds the highest frame number", () => {
    const mockDeps = {
      existsSync: () => true,
      execCommand: () => "frame_1_abc.png\nframe_5_def.png\nframe_3_ghi.png"
    };
    
    expect(findLastProcessedFrame("/test/dir/out", "/test/dir/out/frame_", mockDeps)).toBe(5);
  });
  
  test("handles malformed frame names", () => {
    const mockDeps = {
      existsSync: () => true,
      execCommand: () => "frame_1_abc.png\nframe_xyz.png\nframe_3_def.png\ninvalid.png"
    };
    
    expect(findLastProcessedFrame("/test/dir/out", "/test/dir/out/frame_", mockDeps)).toBe(3);
  });
  
  test("handles errors gracefully", () => {
    const mockDeps = {
      existsSync: () => true,
      execCommand: () => { throw new Error("Test error"); }
    };
    
    expect(findLastProcessedFrame("/test/dir/out", "/test/dir/out/frame_", mockDeps)).toBe(-1);
  });
  
  test("uses readdirSync when available", () => {
    const mockDeps: any = {
      existsSync: () => true,
      readdirSync: () => [
        "frame_3_aaa.png",
        "frame_7_bbb.png",
        "other.txt"
      ],
      execCommand: () => { throw new Error("Should not use execCommand"); }
    };
    expect(findLastProcessedFrame("/out", "/out/frame_", mockDeps)).toBe(7);
  });
  
  test("returns -1 when readdirSync returns no frames", () => {
    const mockDeps: any = {
      existsSync: () => true,
      readdirSync: () => ["foo.png", "bar.txt"],
      execCommand: () => { throw new Error("Should not use execCommand"); }
    };
    expect(findLastProcessedFrame("/out", "/out/frame_", mockDeps)).toBe(-1);
  });
});

describe("getLastCommitInfo", () => {
  test("returns undefined for invalid commit index", () => {
    const commits = ["sha1", "sha2", "sha3"];
    
    expect(getLastCommitInfo(-1, commits)).toBeUndefined();
    expect(getLastCommitInfo(3, commits)).toBeUndefined();
  });
  
  test("returns commit info for valid index", () => {
    const commits = ["sha1", "sha2", "sha3"];
    const mockDeps = {
      execCommand: () => "Test commit message"
    };
    
    const result = getLastCommitInfo(1, commits, mockDeps);
    
    expect(result).toBeDefined();
    expect(result?.sha).toBe("sha2");
    expect(result?.shortSha).toBe("sha2".substring(0, 8)); 
    expect(result?.message).toBe("Test commit message");
  });
  
  test("handles git command errors gracefully", () => {
    const commits = ["sha1", "sha2", "sha3"];
    const mockDeps = {
      execCommand: () => { throw new Error("Git command failed"); }
    };
    
    expect(getLastCommitInfo(1, commits, mockDeps)).toBeUndefined();
  });
});