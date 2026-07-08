import { describe, expect, test } from "bun:test";
import { AnthropicTransport, MockTransport } from "./transport.js";

describe("MockTransport", () => {
  test("returns scripted responses in order and records requests", async () => {
    const t = new MockTransport(["first", "second"]);
    const r1 = await t.complete({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      model: "m",
      maxTokens: 10,
    });
    expect(r1.text).toBe("first");
    const r2 = await t.complete({
      messages: [{ role: "user", content: [{ type: "text", text: "again" }] }],
      model: "m",
      maxTokens: 10,
    });
    expect(r2.text).toBe("second");
    expect(t.requests.length).toBe(2);
  });

  test("throws when queue is exhausted", async () => {
    const t = new MockTransport([]);
    await expect(t.complete({ messages: [], model: "m", maxTokens: 10 })).rejects.toThrow(
      /queue exhausted/,
    );
  });
});

describe("AnthropicTransport", () => {
  test("throws without an API key", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new AnthropicTransport()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test("accepts an explicit key without throwing", () => {
    expect(() => new AnthropicTransport("sk-test")).not.toThrow();
  });
});
