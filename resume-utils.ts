import * as fileUtilsModule from "./file-utils";
import * as loggerModule from "./logger";
import * as userInteractionModule from "./user-interaction";

export interface ResumeOptions {
  outDir: string;
  framesPattern: string;
  commits: string[];
}

/**
 * Dependencies required by the resume functionality
 */
export interface ResumeDependencies {
  fileUtils: {
    findLastProcessedFrame: typeof fileUtilsModule.findLastProcessedFrame;
    getLastCommitInfo: typeof fileUtilsModule.getLastCommitInfo;
  };
  logger: {
    pretty: typeof loggerModule.pretty;
  };
  userInteraction: {
    getUserConfirmation: typeof userInteractionModule.getUserConfirmation;
  };
}

// Default dependencies using the actual implementations
const defaultDependencies: ResumeDependencies = {
  fileUtils: {
    findLastProcessedFrame: fileUtilsModule.findLastProcessedFrame,
    getLastCommitInfo: fileUtilsModule.getLastCommitInfo
  },
  logger: {
    pretty: loggerModule.pretty
  },
  userInteraction: {
    getUserConfirmation: userInteractionModule.getUserConfirmation
  }
};

/**
 * Check if a resume is possible and prompt the user for confirmation
 * @param options - Options including output directory, frames pattern, and commit list
 * @param deps - Optional dependencies to inject (useful for testing)
 * @returns The index to start processing from (0 to start from beginning, > 0 to resume)
 */
export async function checkResumeAndPrompt(
  options: ResumeOptions, 
  deps: ResumeDependencies = defaultDependencies
): Promise<number> {
  const { outDir, framesPattern, commits } = options;
  const { fileUtils, logger, userInteraction } = deps;
  
  // Look for the last processed frame
  const lastFrameNumber = fileUtils.findLastProcessedFrame(outDir, framesPattern);
  
  // If no frames found or invalid frame number, start from beginning
  if (lastFrameNumber < 0) {
    return 0;
  }
  
  // If the last frame number is valid, get info about the last commit
  const lastCommitInfo = fileUtils.getLastCommitInfo(lastFrameNumber, commits);
  
  // If no commit info found, start from beginning
  if (!lastCommitInfo) {
    return 0;
  }
  
  // Show info to the user
  logger.pretty(`Found existing frames in ${outDir}`, "info");
  logger.pretty(`Last processed commit: #${lastFrameNumber + 1} (${lastCommitInfo.shortSha}: ${lastCommitInfo.message})`, "info");
  
  // Ask user if they want to resume
  const resumeConfirm = await userInteraction.getUserConfirmation("Resume from last processed commit?");
  
  if (resumeConfirm) {
    // Start from the next commit after the last processed one
    const startIndex = lastFrameNumber + 1;
    
    if (startIndex < commits.length) {
      logger.pretty(`Resuming from commit ${startIndex + 1}/${commits.length}`, "success");
      return startIndex;
    } else {
      logger.pretty("All commits have already been processed. Nothing to do.", "info");
      return -1; // Signal that all commits are already processed
    }
  } else {
    // User chose to start over
    logger.pretty("Starting from the beginning (existing frames will be overwritten)", "warning");
    return 0;
  }
}