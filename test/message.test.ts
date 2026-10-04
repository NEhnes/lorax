import { describe, expect, test } from "bun:test";
import { MESSAGE_CHARACTER_LIMIT, splitMessage } from "../src/message";

describe("splitMessage", () => {
  test("leaves messages below 250 characters intact and splits at 250", () => {
    expect(splitMessage("Short message.")).toEqual(["Short message."]);
    expect(splitMessage("a".repeat(249))).toEqual(["a".repeat(249)]);
    expect(splitMessage("a".repeat(250))).toEqual(["a".repeat(249), "a"]);
  });

  test("splits at the latest sentence ending within each limit", () => {
    const text = `${"a".repeat(100)}. ${"b".repeat(100)}! ${"c".repeat(150)}?`;
    const chunks = splitMessage(text);

    expect(chunks).toEqual([`${"a".repeat(100)}. ${"b".repeat(100)}!`, ` ${"c".repeat(150)}?`]);
    expect(chunks.every((chunk) => chunk.length <= MESSAGE_CHARACTER_LIMIT)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  test("falls back to the limit when no sentence ending fits", () => {
    const text = `${"a".repeat(250)}. done.`;
    const chunks = splitMessage(text);

    expect(chunks).toEqual(["a".repeat(249), "a. done."]);
    expect(chunks.every((chunk) => chunk.length <= MESSAGE_CHARACTER_LIMIT)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  test("keeps whitespace exactly when splitting", () => {
    const text = `${"a".repeat(248)}  ${"b".repeat(10)}`;
    const chunks = splitMessage(text);

    expect(chunks).toEqual(["a".repeat(248) + " ", " " + "b".repeat(10)]);
    expect(chunks.join("")).toBe(text);
  });

  test("preserves surrogate pairs at a fallback split", () => {
    const text = `${"a".repeat(248)}😀${"b".repeat(10)}`;
    const chunks = splitMessage(text);

    expect(chunks).toEqual(["a".repeat(248), `😀${"b".repeat(10)}`]);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= MESSAGE_CHARACTER_LIMIT && chunk.isWellFormed())).toBe(true);
  });

  test("returns no chunks for blank input", () => {
    expect(splitMessage(" \n ")).toEqual([]);
  });
});
