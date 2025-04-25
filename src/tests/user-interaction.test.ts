import { describe, test, expect } from "bun:test";
import { 
  getUserConfirmation
} from "../user-interaction";

describe("User Interaction", () => {
  test("getUserConfirmation returns true in test environment", async () => {
    process.env.NODE_ENV = 'test';
    const result = await getUserConfirmation("Confirm?");
    expect(result).toBe(true);
    process.env.NODE_ENV = 'development';
  });
});