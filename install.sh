#!/bin/bash

# Exit on error
set -e

# Check if running on macOS
if [[ "$(uname)" != "Darwin" ]]; then
    echo "This install script is designed for macOS only."
    exit 1
fi

# Determine script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Build the executable
echo "Building gitlapse executable..."
bun build index.ts --compile --outfile ./dist/gitlapse

# Create bin directory in user home if it doesn't exist
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

# Create symlink
SYMLINK_PATH="$BIN_DIR/gitlapse"
echo "Creating symlink at $SYMLINK_PATH..."
ln -sf "$SCRIPT_DIR/dist/gitlapse" "$SYMLINK_PATH"

# Check if .local/bin is in PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    # Determine which shell config to use
    SHELL_CONFIG=""
    if [[ -f "$HOME/.zshrc" ]]; then
        SHELL_CONFIG="$HOME/.zshrc"
    elif [[ -f "$HOME/.bashrc" ]]; then
        SHELL_CONFIG="$HOME/.bashrc"
    fi

    if [[ -n "$SHELL_CONFIG" ]]; then
        echo "Adding $BIN_DIR to your PATH in $SHELL_CONFIG..."
        echo "export PATH=\"\$PATH:$BIN_DIR\"" >> "$SHELL_CONFIG"
        echo "Please run: source $SHELL_CONFIG"
    else
        echo "Warning: Could not find shell config file. Please manually add $BIN_DIR to your PATH."
    fi
fi

echo "Installation complete! You can now use gitlapse command from anywhere."
echo "Tip: If gitlapse command is not found, restart your terminal or run: source $SHELL_CONFIG"