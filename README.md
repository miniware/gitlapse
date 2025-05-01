# gitlapse

Create timelapse videos of your web project's development.

## Installation

```bash
# Clone and install
git clone https://github.com/miniware/gitlapse.git
cd gitlapse
bun install

# Optional: install globally
bun run build
chmod +x install.sh
./install.sh
```

## Usage

Run gitlapse from the root directory of a JavaScript web project:

```bash
gitlapse [options]
```

Or without global installation:

```bash
bun start [options]
```

### Options

- `-h, --help`: Show help message
- `-o, --out-dir <dir>`: Output directory for frames and video (default: ./timelapse)
- `-w, --width <pixels>`: Screenshot width (default: 1440)
- `--height <pixels>`: Screenshot height (default: 720)
- `--wait-before <ms>`: Wait time before page load (default: 3000)
- `--wait-after <ms>`: Wait time after page load before screenshot (default: 0)
- `-r, --route <path>`: Route to capture (default: /)
- `-p, --port <number>`: Port to use for the dev server (default: 3000)
- `--branch <name>`: Only include commits from this branch (default: all)
- `--max-commits <number>`: Limit number of commits to process
- `--fps <number>`: Frames per second in output video (default: 12)
- `--density <number>`: Screenshot pixel density (default: 2)
- `--fullscreen`: Capture full page height in screenshots

### Examples

Create a timelapse with default settings:

```bash
gitlapse
```

Create a timelapse with custom width and height:

```bash
gitlapse --width 1920 --height 1080
```

Create a high-resolution timelapse with fullscreen capture:

```bash
gitlapse --density 2 --fullscreen
```

## How It Works

1. Checks out each commit in your git history
2. Installs dependencies for that commit
3. Starts the development server
4. Takes a screenshot of the specified route
5. Compiles all screenshots into a video

### Resume Feature

If the process is interrupted, gitlapse can resume from where it left off:

- When you run gitlapse and it finds existing frames in the output directory,
  you'll be prompted to resume from the last processed commit or start over
- This is useful for long projects where the process might be interrupted,
  or when you encounter errors and need to fix them before continuing

## Requirements

- [Bun](https://bun.sh) v1.0+
- [Git](https://git-scm.com/)
- [ffmpeg](https://ffmpeg.org/) (for video generation)
- [ImageMagick](https://imagemagick.org/) (for fullscreen mode)
- A JavaScript web project with package.json and a dev or start script

## New Features

### High Resolution Screenshots

Use the `--density` option to create high-resolution screenshots:

```bash
gitlapse --density 2
```

This creates screenshots with double the pixel density, resulting in sharper images.

### Fullscreen Capture

Use the `--fullscreen` option to capture the full height of each page:

```bash
gitlapse --fullscreen
```

When this option is enabled:
- Each screenshot captures the entire page height (not just the visible viewport)
- The resulting video uses the height of the tallest screenshot
- All frames are aligned to the top of the video
- Black background is used to fill any empty space
