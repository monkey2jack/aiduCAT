import { describe, expect, it } from "vitest";
import { OpencodeAdapter } from "../../../src/agent/opencode/adapter";
import type { AgentEvent } from "../../../src/agent/types";

describe("OpencodeAdapter Live Integration", () => {
  it("runs opencode headlessly and streams text and done events", async () => {
    const adapter = new OpencodeAdapter({
      binary: "/usr/local/bin/opencode",
    });

    const isAvail = await adapter.isAvailable();
    expect(isAvail).toBe(true);

    const run = adapter.run({
      runId: "test-run-1",
      prompt: "respond with pong",
      cwd: "/tmp",
      model: "opencode/hy4-flash-free",
    });

    const receivedEvents: AgentEvent[] = [];
    for await (const evt of run.events) {
      receivedEvents.push(evt);
    }

    const textEvents = receivedEvents.filter((e) => e.type === "text");
    const doneEvents = receivedEvents.filter((e) => e.type === "done");
    const systemEvents = receivedEvents.filter((e) => e.type === "system");

    expect(systemEvents.length).toBeGreaterThanOrEqual(1);
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    expect(doneEvents.length).toBe(1);

    const fullText = textEvents.map((e) => (e as any).delta).join("");
    expect(fullText.toLowerCase()).toContain("pong");
  }, 30000);

  it("continues conversation across turns using session id", async () => {
    const adapter = new OpencodeAdapter({
      binary: "/usr/local/bin/opencode",
    });

    // Turn 1: establish context
    const run1 = adapter.run({
      runId: "turn-1",
      prompt: "Remember this secret code: BANANA42. Just say OK.",
      cwd: "/tmp",
      model: "opencode/hy4-flash-free",
    });

    let sessionId: string | undefined;
    for await (const evt of run1.events) {
      if (evt.type === "system" && evt.sessionId) {
        sessionId = evt.sessionId;
      }
      if (evt.type === "done" && evt.sessionId) {
        sessionId = evt.sessionId;
      }
    }

    expect(sessionId).toBeDefined();
    expect(sessionId).toMatch(/^ses_/);

    // Turn 2: recall context with sessionId
    const run2 = adapter.run({
      runId: "turn-2",
      sessionId,
      prompt: "What was the secret code I gave you?",
      cwd: "/tmp",
      model: "opencode/hy4-flash-free",
    });

    const textEvents: string[] = [];
    for await (const evt of run2.events) {
      if (evt.type === "text") {
        textEvents.push(evt.delta);
      }
    }

    const recalled = textEvents.join("");
    expect(recalled).toContain("BANANA42");
  }, 45000);
});
