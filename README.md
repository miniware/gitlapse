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

- `-h, --help`: Show help information
- `-o, --out-dir <dir>`: Output directory for frames and video (default: current directory)
- `-w, --width <pixels>`: Screenshot width (default: 1440)
- `--height <pixels>`: Screenshot height (default: 720)
- `--wait <milliseconds>`: Wait time after starting server (default: 3000)
- `-r, --route <path>`: Route to capture (default: /)
- `-p, --port <number>`: Port to use for the dev server (default: 3000)
- `--branch <name>`: Only include commits from this branch (default: all branches)
- `--max-commits <number>`: Limit number of commits to process
- `--fps <number>`: Frames per second in output video (default: 2)

## How It Works

1. Checks out each commit in your git history
2. Installs dependencies for that commit
3. Starts the development server
4. Takes a screenshot of the specified route
5. Compiles all screenshots into a timelapse video

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
- A JavaScript web project with package.json and a dev or start script
