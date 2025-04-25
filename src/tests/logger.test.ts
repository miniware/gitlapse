import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { log, pretty } from "../logger";

describe("logger", () => {
  // Save original console.log
  const originalConsoleLog = console.log;
  let logs: string[] = [];
  
  beforeEach(() => {
    logs = [];
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };
  });
  
  afterEach(() => {
    console.log = originalConsoleLog;
  });
  
  test("log doesn't output anything when DEBUG is not set", () => {
    const originalDebug = process.env.DEBUG;
    process.env.DEBUG = "";
    
    log("Test message");
    
    expect(logs.length).toBe(0);
    
    // Restore DEBUG environment variable
    process.env.DEBUG = originalDebug;
  });
  
  test("log outputs message when DEBUG is set", () => {
    const originalDebug = process.env.DEBUG;
    process.env.DEBUG = "true";
    
    log("Test message");
    
    expect(logs.length).toBe(1);
    expect(logs[0]).toBe("Test message");
    
    // Restore DEBUG environment variable
    process.env.DEBUG = originalDebug;
  });
  
  test("pretty prints with info color by default", () => {
    pretty("Info message");
    
    expect(logs.length).toBe(1);
    // Expecting cyan color and the message
    const logMsg = logs[0];
    if (logMsg) {
      expect(logMsg.includes("\x1b[36m")).toBe(true);
      expect(logMsg.includes("Info message")).toBe(true);
    }
  });
  
  test("pretty prints with success color", () => {
    pretty("Success message", "success");
    
    expect(logs.length).toBe(1);
    // Expecting green color and the message
    const logMsg = logs[0];
    if (logMsg) {
      expect(logMsg.includes("\x1b[32m")).toBe(true);
      expect(logMsg.includes("Success message")).toBe(true);
    }
  });
  
  test("pretty prints with warning color", () => {
    pretty("Warning message", "warning");
    
    expect(logs.length).toBe(1);
    // Expecting yellow color and the message
    const logMsg = logs[0];
    if (logMsg) {
      expect(logMsg.includes("\x1b[33m")).toBe(true);
      expect(logMsg.includes("Warning message")).toBe(true);
    }
  });
  
  test("pretty prints with error color", () => {
    pretty("Error message", "error");
    
    expect(logs.length).toBe(1);
    // Expecting red color and the message
    const logMsg = logs[0];
    if (logMsg) {
      expect(logMsg.includes("\x1b[31m")).toBe(true);
      expect(logMsg.includes("Error message")).toBe(true);
    }
  });
});