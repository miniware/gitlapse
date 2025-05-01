import { describe, test, expect } from 'bun:test';
import { parseArgs } from '../cli';

// Instead of trying to mock complex Puppeteer types, test the CLI options
// which will eventually affect how screenshots are taken

describe('Screenshot options', () => {
  test('fullscreen option should be enabled when flag is provided', () => {
    const config = parseArgs(['--fullscreen']);
    expect(config.fullscreen).toBe(true);
  });
  
  test('fullscreen option should be disabled by default', () => {
    const config = parseArgs([]);
    expect(config.fullscreen).toBe(false);
  });
  
  test('density option should use provided value', () => {
    const config = parseArgs(['--density', '3']);
    expect(config.density).toBe(3);
  });
  
  test('density option should default to 2', () => {
    const config = parseArgs([]);
    expect(config.density).toBe(2);
  });
});