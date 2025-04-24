# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build/Test Commands
- Build/Run: `bun start`
- Type Check: `bun run typecheck`

## Code Style Guidelines
- TypeScript with strict mode enabled
- ESM modules with `.ts` extension
- Error handling: Use try/catch blocks with specific error messages
- Function/interface documentation with JSDoc-style comments
- Clear type definitions with descriptive interfaces
- CLI arguments use both short (-o) and long (--out-dir) forms
- Error messages should be concise and actionable
- Use async/await pattern for asynchronous code
- Prefer early returns for validation errors
- Command parsing follows the conventions in cli.ts
- Don't add comments to self-explanatory code
- Always run checks / tests before confirming something is complete