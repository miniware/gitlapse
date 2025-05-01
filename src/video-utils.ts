import fs from "fs";
import path from "path";
import os from "os";
import { execSync, spawn } from "child_process";
import { log, pretty } from "./logger";
import { promisify } from "util";
import { createHash } from "crypto";

// Promisify fs functions for better async performance
const copyFileAsync = promisify(fs.copyFile);
const mkdirAsync = promisify(fs.mkdir);
const existsAsync = promisify(fs.exists);
const readdirAsync = promisify(fs.readdir);

// Check if hardware acceleration is available for ffmpeg
function detectHardwareAcceleration(): string {
  try {
    // Check for macOS hardware acceleration
    if (process.platform === 'darwin') {
      return "-hwaccel videotoolbox -hwaccel_output_format yuv420p";
    }
    
    // Check for NVIDIA GPU acceleration 
    const nvidiaSmiOutput = execSync("nvidia-smi -L 2>/dev/null || echo 'not found'").toString();
    if (!nvidiaSmiOutput.includes("not found")) {
      return "-hwaccel cuda -hwaccel_output_format yuv420p";
    }
    
    // Check for Intel QuickSync acceleration
    const vaInfoOutput = execSync("vainfo 2>/dev/null || echo 'not found'").toString();
    if (!vaInfoOutput.includes("not found") && vaInfoOutput.includes("VA-API")) {
      return "-hwaccel vaapi -hwaccel_output_format yuv420p";
    }
    
    // No hardware acceleration detected
    return "";
  } catch (error) {
    log("Hardware acceleration detection failed, using software encoding");
    return "";
  }
}

/**
 * Generate a hash for an image file - used for deduplication
 */
async function generateImageHash(filePath: string): Promise<string> {
  try {
    const data = fs.readFileSync(filePath);
    const hash = createHash('md5').update(data).digest('hex');
    return hash;
  } catch (error) {
    log(`Error generating hash for ${filePath}: ${error}`);
    // Return a unique string to prevent duplication errors
    return `error-${Date.now()}-${Math.random()}`;
  }
}

/**
 * Filter out duplicate frames based on image content
 */
async function removeDuplicateFrames(frames: string[]): Promise<string[]> {
  pretty("Checking for duplicate frames...", "info");
  
  if (frames.length <= 1) {
    return frames;
  }
  
  const uniqueFrames: string[] = [];
  const seenHashes = new Set<string>();
  
  // Use a sliding window approach for better performance with many frames
  const batchSize = 10;
  for (let i = 0; i < frames.length; i += batchSize) {
    const batch = frames.slice(i, i + batchSize);
    const hashPromises = batch.map(frame => {
      if (!frame) return Promise.resolve("");
      return generateImageHash(frame);
    });
    const hashes = await Promise.all(hashPromises);
    
    batch.forEach((frame, index) => {
      if (!frame) return;
      const hash = hashes[index];
      if (hash && !seenHashes.has(hash)) {
        seenHashes.add(hash);
        uniqueFrames.push(frame);
      } else if (hash) {
        log(`Duplicate frame detected: ${frame}`);
      }
    });
  }
  
  const duplicatesRemoved = frames.length - uniqueFrames.length;
  if (duplicatesRemoved > 0) {
    pretty(`Removed ${duplicatesRemoved} duplicate frames.`, "info");
  } else {
    log("No duplicate frames found.");
  }
  
  return uniqueFrames;
}

/**
 * Generate a video from captured frames with improved performance
 */
export async function generateTimeLapseVideo(
  outDir: string, 
  framesPattern: string, 
  width: number, 
  height: number, 
  fps: number,
  fullscreen?: boolean,
  densityValue?: number
): Promise<string | undefined> {
  if (!framesPattern) {
    throw new Error("Frame pattern is required");
  }
  pretty("Creating timelapse video...", "info");

  // Find captured frames
  const frameFiles = findCapturedFrames(outDir, framesPattern);

  if (frameFiles.length === 0) {
    pretty("❌ No frames were created. Cannot generate video.", "error");
    process.exit(1);
  }

  // Remove duplicate frames
  const uniqueFrames = await removeDuplicateFrames(frameFiles);

  // Special handling for single frame case
  if (uniqueFrames.length === 1 && uniqueFrames[0]) {
    log("Only one frame detected, will duplicate it to create a valid video");
    // Duplicate the frame to ensure we can create a video (needs at least 2 frames)
    uniqueFrames.push(uniqueFrames[0]);
  }
  
  // If fullscreen, determine max height of all frames then adjust for density
  let maxHeight = height;
  // Use provided density parameter or default to 2
  const densityFactor = (typeof densityValue === 'number' && densityValue > 0) ? densityValue : 2;
  
  if (fullscreen) {
    try {
      pretty("Fullscreen mode enabled, finding tallest frame...", "info");
      for (const frame of uniqueFrames) {
        if (!frame) continue;
        
        // Use ImageMagick to get dimensions
        try {
          const dimensions = execSync(`identify -format "%h" "${frame}"`).toString().trim();
          const frameHeight = parseInt(dimensions, 10);
          if (!isNaN(frameHeight) && frameHeight > maxHeight) {
            maxHeight = frameHeight;
            log(`New max height found: ${maxHeight}px from frame ${frame}`);
          }
        } catch (imgError) {
          log(`Error getting dimensions from ${frame}: ${imgError}`);
        }
      }
      
      // Adjust height based on density (screenshot dimensions are multiplied by density)
      const adjustedMaxHeight = Math.ceil(maxHeight / densityFactor);
      pretty(`Adjusting max height from ${maxHeight}px to ${adjustedMaxHeight}px (accounting for density ${densityFactor})`, "info");
      maxHeight = adjustedMaxHeight;
      
      // Ensure max height is at least the configured height
      if (maxHeight < height) {
        maxHeight = height;
      }
      
      pretty(`Using max height of ${maxHeight}px for video output`, "info");
    } catch (error) {
      log(`Error determining max height, falling back to configured height: ${error}`);
      maxHeight = height;
    }
  }

  pretty(`Found ${uniqueFrames.length} unique frames, generating video...`, "info");

  // Use a consistent filename for easier access
  const outputVideoPath = path.join(outDir, `timelapse.mp4`);

  try {
    // Create a temp directory with numerically named files that FFmpeg can use with a pattern
    const tmpDir = path.join(os.tmpdir(), `ffmpeg-frames-${Date.now()}`);
    await mkdirAsync(tmpDir, { recursive: true });

    try {
      log(`Created temporary directory for frame sequence: ${tmpDir}`);

      // Sort frames by numeric order with optimized regex once
      const frameNumbers = new Map<string, number>();
      const regex = /frame_(\d+)_/;
      
      // Create a filtered, non-undefined array of frames
      const validFrames: string[] = [];
      for (const frame of uniqueFrames) {
        if (typeof frame === 'string') {
          validFrames.push(frame);
        }
      }
      
      // Process the valid frames
      for (const frame of validFrames) {
        const match = regex.exec(frame);
        if (match && match[1]) {
          frameNumbers.set(frame, parseInt(match[1]));
        } else {
          frameNumbers.set(frame, 0);
        }
      }
      
      const sortedFrames = [...validFrames].sort((a, b) => {
        return (frameNumbers.get(a) || 0) - (frameNumbers.get(b) || 0);
      });
      
      // Create copy operations in batches for better performance
      const batchSize = 10; // Adjust based on system capabilities
      const copyPromises: Promise<void>[] = [];
      
      for (let i = 0; i < sortedFrames.length; i++) {
        const sourcePath = sortedFrames[i];
        if (!sourcePath) continue;
        
        const destPath = path.join(tmpDir, `img_${String(i).padStart(6, '0')}.png`);
        copyPromises.push(copyFileAsync(sourcePath, destPath));
        
        // Process in batches to avoid overwhelming the file system
        if (copyPromises.length >= batchSize || i === sortedFrames.length - 1) {
          await Promise.all(copyPromises);
          copyPromises.length = 0;
        }
      }
      
      // Detect hardware acceleration capabilities
      const hwAccel = detectHardwareAcceleration();
      
      // Construct the ffmpeg command with high quality settings
      const imgPattern = path.join(tmpDir, 'img_%06d.png');
      
      // Enhanced ffmpeg command for higher quality output:
      // - For fullscreen mode: Preserve aspect ratio exactly, align top  
      // - For normal mode: Keep aspect ratio, center both vertically and horizontally
      const vfFilter = fullscreen 
        ? `scale=w=${width}:h=-1,pad=${width}:${maxHeight}:0:0:black` 
        : `scale='min(${width},iw)':min(${height},ih):force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
        
      const ffmpegCmd = `ffmpeg -y -loglevel error ${hwAccel} -framerate ${fps} -i "${imgPattern}" \
        -vframes ${sortedFrames.length} \
        -c:v libx264 -preset slow -tune stillimage -crf 15 \
        -vf "${vfFilter}" \
        -sws_flags neighbor -pix_fmt yuv420p -color_primaries 1 -color_trc 1 -colorspace 1 \
        -movflags faststart -g 1 -bf 0 "${outputVideoPath}"`;
      
      
      log(`Running FFmpeg command with high quality settings: ${ffmpegCmd}`);
      
      // Use spawn instead of execSync for better performance with large files
      return new Promise((resolve, reject) => {
        const ffmpeg = spawn('bash', ['-c', ffmpegCmd], { 
          stdio: ['ignore', 'pipe', 'pipe'] 
        });
        
        let stdoutChunks: Buffer[] = [];
        let stderrChunks: Buffer[] = [];
        
        ffmpeg.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
        ffmpeg.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
        
        ffmpeg.on('close', async (code) => {
          if (code !== 0) {
            const stderr = Buffer.concat(stderrChunks).toString();
            log(`FFmpeg error: ${stderr}`);
            
            // Try fallback approach
            const fallbackResult = await tryFallbackVideoGeneration(
              outDir, framesPattern, sortedFrames, fps, outputVideoPath, fullscreen, densityValue
            );
            resolve(fallbackResult);
          } else {
            // Verify the video was created
            const exists = await existsAsync(outputVideoPath);
            if (!exists) {
              reject(new Error("Failed to create video file - output file does not exist"));
              return;
            }
            
            pretty("✅ Video creation successful!", "success");
            resolve(outputVideoPath);
          }
          
          // Clean up the temporary directory asynchronously
          try {
            execSync(`rm -rf "${tmpDir}"`);
            log(`Cleaned up temporary directory: ${tmpDir}`);
          } catch (cleanupError) {
            log(`Warning: Failed to clean up temporary directory: ${cleanupError}`);
          }
        });
        
        ffmpeg.on('error', async (err) => {
          log(`FFmpeg process error: ${err.message}`);
          
          // Try fallback approach
          const fallbackResult = await tryFallbackVideoGeneration(
            outDir, framesPattern, sortedFrames, fps, outputVideoPath, fullscreen, densityValue
          );
          resolve(fallbackResult);
          
          // Clean up the temporary directory asynchronously
          try {
            execSync(`rm -rf "${tmpDir}"`);
          } catch (cleanupError) {
            log(`Warning: Failed to clean up temporary directory: ${cleanupError}`);
          }
        });
      });
    } catch (error) {
      // Clean up the temporary directory
      try {
        execSync(`rm -rf "${tmpDir}"`);
        log(`Cleaned up temporary directory after error: ${tmpDir}`);
      } catch (cleanupError) {
        log(`Warning: Failed to clean up temporary directory: ${cleanupError}`);
      }
      
      throw error;
    }
  } catch (ffmpegError) {
    pretty("❌ Error creating video:", "error");
    pretty(ffmpegError instanceof Error ? ffmpegError.message : String(ffmpegError), "error");

    // Try fallback approach
    return tryFallbackVideoGeneration(outDir, framesPattern, uniqueFrames, fps, outputVideoPath, fullscreen, densityValue);
  }
}

/**
 * Find all captured frames in the output directory with improved performance
 */
export function findCapturedFrames(outDir: string, framesPattern: string): string[] {
  const basename = path.basename(framesPattern);
  try {
    const entries = fs.readdirSync(outDir);
    
    // Use filter with a more efficient predicate
    const prefix = basename;
    const suffix = '.png';
    
    return entries
      .filter(f => {
        return f.indexOf(prefix) === 0 && f.indexOf(suffix, f.length - suffix.length) !== -1;
      })
      .map(f => path.join(outDir, f));
  } catch (err) {
    return [];
  }
}

/**
 * Improved fallback approach for video generation when the main method fails
 */
async function tryFallbackVideoGeneration(
  outDir: string,
  framesPattern: string,
  allFrames: string[],
  fps: number,
  outputVideoPath: string,
  fullscreen?: boolean,
  densityValue?: number
): Promise<string | undefined> {
  try {
    log("Trying alternative approach with glob pattern...");

    // Create a temporary directory for the frames
    const tmpDir = path.join(os.tmpdir(), `ffmpeg-frames-fallback-${Date.now()}`);
    await mkdirAsync(tmpDir, { recursive: true });
    log(`Created temp directory for fallback approach: ${tmpDir}`);
    
    try {
      // Create sequentially named copies of the frames in parallel batches
      const batchSize = 10;
      const copyPromises: Promise<void>[] = [];
      
      for (let i = 0; i < allFrames.length; i++) {
        const sourcePath = allFrames[i];
        if (!sourcePath) continue;
        
        const destPath = path.join(tmpDir, `img_${String(i).padStart(6, '0')}.png`);
        copyPromises.push(copyFileAsync(sourcePath, destPath));
        
        // Process in batches to avoid overwhelming the file system
        if (copyPromises.length >= batchSize || i === allFrames.length - 1) {
          await Promise.all(copyPromises);
          copyPromises.length = 0;
        }
      }
      
      // Use a direct sequence pattern for more reliable frame ordering
      // Use a simpler command but still prioritize quality
      const imgPattern = path.join(tmpDir, 'img_%06d.png');
      
      // Determine max height for fullscreen mode with adjustment for density
      let maxHeight = 720; // Default height
      const videoWidth = 1440; // Default width
      // Use provided density parameter or default to 2
      const densityFactor = (typeof densityValue === 'number' && densityValue > 0) ? densityValue : 2;
      
      if (fullscreen) {
        try {
          // First pass: find the tallest frame
          for (const frame of allFrames) {
            if (!frame) continue;
            try {
              const dimensions = execSync(`identify -format "%h" "${frame}"`).toString().trim();
              const frameHeight = parseInt(dimensions, 10);
              if (!isNaN(frameHeight) && frameHeight > maxHeight) {
                maxHeight = frameHeight;
                log(`Fallback: New max height found: ${maxHeight} from frame ${frame}`);
              }
            } catch (imgError) {
              log(`Fallback: Error getting dimensions from ${frame}: ${imgError}`);
            }
          }
          
          // Adjust height based on density (screenshot dimensions are multiplied by density)
          const adjustedMaxHeight = Math.ceil(maxHeight / densityFactor);
          log(`Fallback: Adjusting max height from ${maxHeight}px to ${adjustedMaxHeight}px (accounting for density ${densityFactor})`);
          maxHeight = adjustedMaxHeight;
          
          log(`Fallback: Using max height of ${maxHeight} pixels for video output`);
        } catch (error) {
          log(`Fallback: Error determining max height: ${error}`);
        }
      }
      
      // Set up video filter based on fullscreen mode - embed in command properly
      // For fullscreen: Preserve aspect ratio exactly, align top
      const vfFilter = fullscreen
        ? `scale=w=${videoWidth}:h=-1,pad=${videoWidth}:${maxHeight}:0:0:black`
        : `scale=${videoWidth}:720:force_original_aspect_ratio=decrease,pad=${videoWidth}:720:(ow-iw)/2:(oh-ih)/2:black`;
      
      // Simple command with error output enabled to help diagnose issues
      const simpleCmd = `ffmpeg -y -framerate ${fps} -i "${imgPattern}" \
        -vframes ${allFrames.length} -c:v libx264 -preset medium \
        -crf 23 -vf "${vfFilter}" -pix_fmt yuv420p "${outputVideoPath}"`;
      
      log(`Using adjusted filter for compatibility: ${vfFilter}`);
      
      
      log(`Running fallback FFmpeg command with medium preset: ${simpleCmd}`);
      execSync(simpleCmd, { stdio: ['ignore', 'pipe', 'pipe'] });
      
      if (await existsAsync(outputVideoPath)) {
        pretty("✅ Video creation successful with fallback method!", "success");
        return outputVideoPath;
      }
    } finally {
      // Clean up the temporary directory
      try {
        execSync(`rm -rf "${tmpDir}"`);
        log(`Cleaned up temporary directory: ${tmpDir}`);
      } catch (cleanupError) {
        log(`Warning: Failed to clean up temporary directory: ${cleanupError}`);
      }
    }
  } catch (fallbackError) {
    log(`Fallback approach failed: ${fallbackError}`);
    
    // Try one very basic fallback before giving up completely
    try {
      log("Attempting final basic fallback...");
      // Ultra basic fallback command - accounting for density
      const defaultWidth = 1440;
      let defaultMaxHeight = 720; // Default if we can't determine
      const densityFactor = 2; // Default density for final fallback (no parameters access here)
      
      // Try to determine the actual max height by checking frames directly
      try {
        pretty("Finding tallest frame for final fallback...", "info");
        // Use find command to get frame paths
        const frames = execSync(`find "${outDir}" -name "frame_*.png"`, { encoding: 'utf8' }).split('\n').filter(Boolean);
        
        // Find tallest frame height
        for (const frame of frames) {
          if (!frame) continue;
          try {
            const dimensions = execSync(`identify -format "%h" "${frame}"`, { encoding: 'utf8' }).trim();
            const frameHeight = parseInt(dimensions, 10);
            if (!isNaN(frameHeight) && frameHeight > defaultMaxHeight) {
              defaultMaxHeight = frameHeight;
              log(`Final fallback: Found taller frame: ${defaultMaxHeight}px (${frame})`);
            }
          } catch (imgError) {
            // Ignore errors and continue with next frame
          }
        }
        
        // Adjust for density
        const adjustedHeight = Math.ceil(defaultMaxHeight / densityFactor);
        pretty(`Final fallback adjusting max height from ${defaultMaxHeight}px to ${adjustedHeight}px (accounting for density ${densityFactor})`, "info");
        defaultMaxHeight = adjustedHeight;
      } catch (error) {
        log(`Error determining max height for final fallback: ${error}`);
      }
      const vf = fullscreen ? 
        `-vf "scale=w=${defaultWidth}:h=-1,pad=${defaultWidth}:${defaultMaxHeight}:0:0:black"` : 
        '';
      const basicCmd = `ffmpeg -y -pattern_type glob -framerate ${fps} -i "${outDir}/frame_*.png" -c:v libx264 -preset ultrafast ${vf} -pix_fmt yuv420p "${outputVideoPath}"`;
      log(`Running basic fallback command: ${basicCmd}`);
      execSync(basicCmd, { stdio: 'inherit' });
      
      if (fs.existsSync(outputVideoPath)) {
        pretty("✅ Video creation successful with basic fallback method!", "success");
        return outputVideoPath;
      }
    } catch (finalError) {
      log(`Final fallback also failed: ${finalError}`);
      pretty("All video creation attempts failed. Please try manually using ffmpeg.", "error");
    }
    
    // Don't exit the process, allow for graceful handling
    return undefined;
  }

  return undefined;
}