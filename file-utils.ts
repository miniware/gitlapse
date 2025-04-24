import fs from "fs";
import { execSync } from "child_process";

interface FileUtilDependencies {
  existsSync: typeof fs.existsSync;
  execCommand: (...args: any[]) => any;
}

const defaultDependencies: FileUtilDependencies = {
  existsSync: fs.existsSync,
  execCommand: execSync
};

/**
 * Finds the last processed frame in the output directory
 * @param outDir - The output directory path
 * @param framesPattern - The pattern used for frame filenames
 * @param deps - Optional dependencies to inject (useful for testing)
 * @returns The highest frame number found, or -1 if no frames found
 */
export function findLastProcessedFrame(
  outDir: string, 
  framesPattern: string,
  deps: FileUtilDependencies = defaultDependencies
): number {
  try {
    const { existsSync, execCommand } = deps;
    
    if (!existsSync(outDir)) {
      return -1;
    }
    
    // Look for existing frames in the output directory
    const framePattern = `${framesPattern}*.png`;
    const existingFrames = execCommand(`ls ${framePattern} 2>/dev/null || echo ""`)
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
      
    if (existingFrames.length === 0) {
      return -1;
    }
    
    // Find the highest frame number
    let highestFrameNumber = -1;
    for (const frame of existingFrames) {
      const match = frame.match(/frame_(\d+)_/);
      if (match && match[1]) {
        const frameNumber = parseInt(match[1]);
        if (frameNumber > highestFrameNumber) {
          highestFrameNumber = frameNumber;
        }
      }
    }
    
    return highestFrameNumber;
  } catch (error) {
    // If there's any error, return -1 to indicate no frames found
    return -1;
  }
}

/**
 * Gets information about the last processed commit
 * @param commitIndex - The index of the last processed commit
 * @param commits - Array of commit SHAs
 * @param deps - Optional dependencies to inject (useful for testing)
 * @returns Object with commit details, or undefined if commit not found
 */
export function getLastCommitInfo(
  commitIndex: number, 
  commits: string[],
  deps: { execCommand: (...args: any[]) => any } = { execCommand: execSync }
): { sha: string; shortSha: string; message: string } | undefined {
  try {
    const { execCommand } = deps;
    
    if (commitIndex < 0 || commitIndex >= commits.length) {
      return undefined;
    }
    
    const sha = commits[commitIndex];
    if (!sha) {
      return undefined;
    }
    
    const message = execCommand(`git show -s --format=%s ${sha}`).toString().trim();
    return {
      sha,
      shortSha: sha.substring(0, 8),
      message
    };
  } catch (error) {
    return undefined;
  }
}