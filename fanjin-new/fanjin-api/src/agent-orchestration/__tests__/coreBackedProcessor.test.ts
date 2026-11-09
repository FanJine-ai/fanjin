import { describe, it, expect, vi } from "vitest";
import { CoreBackedToolLoopProcessor } from "../coreBackedProcessor";
import { StubSnapshotReader } from "../snapshotReader";
import type { AgentRunProcessInput } from "@/agent-runtime/runProcessor";
import type { Knex } from "knex";

function makeInput(overrides: Partial<AgentRunProcessInput> = {}): AgentRunProcessInput {
  return {
    claimedRun: {
      id: "run-1",
      workspaceId: "ws-1",
      projectId: 1,
      threadId: "thread-1",
      rootRunId: "run-1",
      triggerMessageId: "msg-1",
      responseMessageId: null,
      agentRole: "main",
      status: "running",
      policySnapshot: {},
      leaseOwner: "worker-1",
      leaseExpiresAt: Date.now() + 60_000,
      attempt: 1,
      version: 1,
    } as unknown as AgentRunProcessInput["claimedRun"],
    workerId: "worker-1",
    ...overrides,
  };
}

// Mock database
function createMockDatabase(mockRun?: any, mockTrigger?: any) {
  const mockDb = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnThis(),
    first: vi.fn().mockImplementation(() => {
      return Promise.resolve(mockRun || {
        id: "run-1",
        triggerMessageId: "msg-1",
        responseMessageId: "resp-1",
      });
    }),
    forUpdate: vi.fn().mockReturnThis(),
    update: vi.fn().mockResolvedValue(1),
    insert: vi.fn().mockResolvedValue(1),
  });
  return mockDb as unknown as Knex;
}

// Mock model
function createMockModel() {
  return {
    executeTurn: vi.fn().mockResolvedValue({
      kind: "final",
      content: [{ type: "text", text: "done" }],
    }),
  };
}

// Mock gateway
function createMockGateway() {
  return {
    listModelToolCandidates: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue({ output: null }),
  };
}

// Mock eventAppender
function createMockEventAppender() {
  return vi.fn().mockResolvedValue("event-1");
}

describe("CoreBackedToolLoopProcessor", () => {
  it("骨架实现：absent modelStep → dispatch_model → 返回 queued", async () => {
    const reader = new StubSnapshotReader();
    const database = createMockDatabase();
    const model = createMockModel();
    const gateway = createMockGateway();
    const eventAppender = createMockEventAppender();

    const processor = new CoreBackedToolLoopProcessor({
      snapshotReader: reader,
      database,
      toolMeta: {},
      clock: () => Date.now(),
      limits: {
        maxTurns: 4,
        maxToolCalls: 8,
        maxArgumentBytes: 32768,
        maxResultBytes: 65536,
        maxFinalTextBytes: 65536,
      },
      model: model as any,
      gateway: gateway as any,
      messageIdFactory: () => "msg-" + Math.random(),
      stepIdFactory: () => "step-" + Math.random(),
      eventAppender: eventAppender as any,
    });
    const result = await processor.process(makeInput());
    // 骨架实现对 dispatch_model 返回 queued
    expect(result.status).toBe("queued");
    expect(result.runId).toBe("run-1");
  });

  it("自定义 snapshotReader 返回 final → 成功", async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({
        transcript: [],
        turn: 1,
        persistedToolCallsUsed: 0,
        modelStep: { phase: "committed", result: { kind: "final", content: [{ type: "text", text: "done" }] } },
        persistedToolCalls: [],
        approval: { present: false },
        cancellationRequested: false,
        toolMeta: {},
        limits: { maxTurns: 4, maxToolCalls: 8, maxArgumentBytes: 32768, maxResultBytes: 65536, maxFinalTextBytes: 65536 },
      }),
    };
    const database = createMockDatabase();
    const model = createMockModel();
    const gateway = createMockGateway();
    const eventAppender = createMockEventAppender();

    const processor = new CoreBackedToolLoopProcessor({
      snapshotReader: reader,
      database,
      toolMeta: {},
      clock: () => Date.now(),
      limits: {
        maxTurns: 4,
        maxToolCalls: 8,
        maxArgumentBytes: 32768,
        maxResultBytes: 65536,
        maxFinalTextBytes: 65536,
      },
      model: model as any,
      gateway: gateway as any,
      messageIdFactory: () => "msg-" + Math.random(),
      stepIdFactory: () => "step-" + Math.random(),
      eventAppender: eventAppender as any,
    });
    const result = await processor.process(makeInput());
    expect(result.status).toBe("succeeded");
  });

  it("自定义 snapshotReader 返回 halt_cancelled → cancelled", async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({
        transcript: [],
        turn: 1,
        persistedToolCallsUsed: 0,
        modelStep: { phase: "absent" },
        persistedToolCalls: [],
        approval: { present: false },
        cancellationRequested: true,
        toolMeta: {},
        limits: { maxTurns: 4, maxToolCalls: 8, maxArgumentBytes: 32768, maxResultBytes: 65536, maxFinalTextBytes: 65536 },
      }),
    };
    const database = createMockDatabase();
    const model = createMockModel();
    const gateway = createMockGateway();
    const eventAppender = createMockEventAppender();

    const processor = new CoreBackedToolLoopProcessor({
      snapshotReader: reader,
      database,
      toolMeta: {},
      clock: () => Date.now(),
      limits: {
        maxTurns: 4,
        maxToolCalls: 8,
        maxArgumentBytes: 32768,
        maxResultBytes: 65536,
        maxFinalTextBytes: 65536,
      },
      model: model as any,
      gateway: gateway as any,
      messageIdFactory: () => "msg-" + Math.random(),
      stepIdFactory: () => "step-" + Math.random(),
      eventAppender: eventAppender as any,
    });
    const result = await processor.process(makeInput());
    expect(result.status).toBe("cancelled");
  });
});
