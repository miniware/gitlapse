import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { log, pretty } from "../logger";

describe("logger", () => {
  // Save the original console.log function
  const originalConsoleLog = console.log;
  let consoleOutput: string[] = [];
  
  beforeEach(() => {
    // Replace console.log with a mock function for testing
    console.log = (...args: any[]) => {
      consoleOutput.push(args.join(" "));
    };
    consoleOutput = [];
  });
  
  afterEach(() => {
    // Restore console.log
    console.log = originalConsoleLog;
  });
  
  test("log doesn't output anything when DEBUG is not set", () => {
    const originalDebug = process.env.DEBUG;
    process.env.DEBUG = "";
    
    log("Test message");
    
    expect(consoleOutput.length).toBe(0);
    
    // Restore DEBUG environment variable
    process.env.DEBUG = originalDebug || "";
  });
  
  test("log outputs message when DEBUG is set", () => {
    const originalDebug = process.env.DEBUG;
    process.env.DEBUG = "true";
    
    log("Test message");
    
    expect(consoleOutput.length).toBe(1);
    expect(consoleOutput[0]).toBe("Test message");
    
    // Restore DEBUG environment variable
    process.env.DEBUG = originalDebug || "";
  });
  
  test("pretty prints with info color by default", () => {
    pretty("Info message");
    
    expect(consoleOutput.length).toBe(1);
    expect(consoleOutput[0] && consoleOutput[0].includes("Info message")).toBe(true);
  });
  
  test("pretty prints with success color", () => {
    pretty("Success message", "success");
    
    expect(consoleOutput.length).toBe(1);
    expect(consoleOutput[0] && consoleOutput[0].includes("Success message")).toBe(true);
  });
  
  test("pretty prints with warning color", () => {
    pretty("Warning message", "warning");
    
    expect(consoleOutput.length).toBe(1);
    expect(consoleOutput[0] && consoleOutput[0].includes("Warning message")).toBe(true);
  });
  
  test("pretty prints with error color", () => {
    pretty("Error message", "error");
    
    expect(consoleOutput.length).toBe(1);
    expect(consoleOutput[0] && consoleOutput[0].includes("Error message")).toBe(true);
  });
});