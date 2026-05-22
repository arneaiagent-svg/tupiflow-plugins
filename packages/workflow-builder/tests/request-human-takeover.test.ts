import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PluginHostAPI, RegistryStepInput, ConnectionSendReplySpec } from "@tupiflow-plugins/shared/host-api-types";
import { requestHumanTakeoverStep } from "../src/steps/request-human-takeover.ts";

interface DbReadCall {
  query: string;
  params: any[];
}

interface DbWriteCall {
  query: string;
  params: any[];
}

function makeMockCtx(args: {
  input: Record<string, unknown>;
  threadJson?: unknown;
  humanTakeoverDisabled?: boolean | null;
  sendReplyResult?: { delivered: boolean; threadId: string };
  sendReplyError?: Error;
}): {
  stepInput: RegistryStepInput;
  dbReads: DbReadCall[];
  dbWrites: DbWriteCall[];
  sendReplyCalls: ConnectionSendReplySpec[];
  warnLogs: string[];
} {
  const dbReads: DbReadCall[] = [];
  const dbWrites: DbWriteCall[] = [];
  const sendReplyCalls: ConnectionSendReplySpec[] = [];
  const warnLogs: string[] = [];

  const stepInput: RegistryStepInput = {
    api: {
      db: {
        read: async (query: string, params: any[]) => {
          dbReads.push({ query, params });
          return [{ human_takeover_disabled: args.humanTakeoverDisabled ?? null }];
        },
        write: async (query: string, params: any[]) => {
          dbWrites.push({ query, params });
        },
      },
      connections: {
        sendReply: async (spec: ConnectionSendReplySpec) => {
          sendReplyCalls.push(spec);
          if (args.sendReplyError) {
            throw args.sendReplyError;
          }
          return args.sendReplyResult ?? { delivered: true, threadId: "t-123" };
        },
      },
      logger: {
        info: () => {},
        warn: (msg: string) => {
          warnLogs.push(msg);
        },
        error: () => {},
      },
    } as unknown as PluginHostAPI,
    ctx: {
      input: args.input,
      threadJson: args.threadJson,
      userId: "u-test",
      nodeId: "n-test",
      workflowId: "w-test",
      executionId: "exec-test",
    },
  };

  return { stepInput, dbReads, dbWrites, sendReplyCalls, warnLogs };
}

test("requestHumanTakeoverStep - successful takeover with courtesy notice sent", async () => {
  const { stepInput, dbReads, dbWrites, sendReplyCalls, warnLogs } = makeMockCtx({
    input: {
      integrationId: "i-telegram",
      threadId: "t-chat1",
      reason: "Needs human review",
      notifyMessage: "Operator is on the way!",
    },
    threadJson: { chat_id: 12345 },
    humanTakeoverDisabled: false,
    sendReplyResult: { delivered: true, threadId: "t-chat1" },
  });

  const result = await requestHumanTakeoverStep(stepInput);

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.integrationId, "i-telegram");
    assert.equal(result.data.threadId, "t-chat1");
    assert.equal(result.data.humanControl, true);
    assert.equal(result.data.notified, true);
  }

  // Verify DB read
  assert.equal(dbReads.length, 1);
  assert.match(dbReads[0].query, /SELECT human_takeover_disabled/);
  assert.deepEqual(dbReads[0].params, ["i-telegram"]);

  // Verify DB write
  assert.equal(dbWrites.length, 1);
  assert.match(dbWrites[0].query, /INSERT INTO connection_thread_history/);
  assert.deepEqual(dbWrites[0].params, ["i-telegram", "t-chat1", "Needs human review"]);

  // Verify sendReply
  assert.equal(sendReplyCalls.length, 1);
  assert.deepEqual(sendReplyCalls[0], {
    integrationId: "i-telegram",
    threadJson: { chat_id: 12345 },
    text: "Operator is on the way!",
  });

  assert.equal(warnLogs.length, 0);
});

test("requestHumanTakeoverStep - default courtesy message when not provided in input", async () => {
  const { stepInput, sendReplyCalls } = makeMockCtx({
    input: {
      integrationId: "i-telegram",
      threadId: "t-chat1",
    },
    threadJson: { chat_id: 12345 },
  });

  const result = await requestHumanTakeoverStep(stepInput);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.notified, true);
  }

  assert.equal(sendReplyCalls.length, 1);
  assert.match(sendReplyCalls[0].text, /An operator has been requested to take over/);
});

test("requestHumanTakeoverStep - fails if human takeover is disabled in connection settings", async () => {
  const { stepInput, dbWrites, sendReplyCalls } = makeMockCtx({
    input: {
      integrationId: "i-telegram",
      threadId: "t-chat1",
    },
    humanTakeoverDisabled: true,
  });

  const result = await requestHumanTakeoverStep(stepInput);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /Human takeover is disabled for this connection/);
  }

  assert.equal(dbWrites.length, 0);
  assert.equal(sendReplyCalls.length, 0);
});

test("requestHumanTakeoverStep - courtesy notice fails (sendReply throws) but step still succeeds", async () => {
  const { stepInput, sendReplyCalls, warnLogs } = makeMockCtx({
    input: {
      integrationId: "i-telegram",
      threadId: "t-chat1",
    },
    threadJson: { chat_id: 12345 },
    sendReplyError: new Error("Network timeout sending message"),
  });

  const result = await requestHumanTakeoverStep(stepInput);

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.notified, false); // failed to notify
  }

  assert.equal(sendReplyCalls.length, 1);
  assert.equal(warnLogs.length, 1);
  assert.match(warnLogs[0], /Failed to send human takeover courtesy notice: Network timeout sending message/);
});

test("requestHumanTakeoverStep - courtesy notice skipped if threadJson is missing but step still succeeds", async () => {
  const { stepInput, sendReplyCalls, warnLogs } = makeMockCtx({
    input: {
      integrationId: "i-telegram",
      threadId: "t-chat1",
    },
    threadJson: undefined,
  });

  const result = await requestHumanTakeoverStep(stepInput);

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.notified, false); // skipped
  }

  assert.equal(sendReplyCalls.length, 0);
  assert.equal(warnLogs.length, 1);
  assert.match(warnLogs[0], /Failed to send human takeover courtesy notice: threadJson is missing/);
});
