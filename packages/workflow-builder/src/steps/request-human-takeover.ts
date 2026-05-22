// requestHumanTakeoverStep — registry port of
// plugins/workflow-builder/steps/request-human-takeover.
//
// The first-party implementation:
//   1. read `connection_settings.human_takeover_disabled` for the integration
//   2. called `setHumanControl(integrationId, threadId, true, {summary, needsHumanReply})`
//      which upserted into `connection_thread_history`
//   3. optionally posted a notice in-thread via the in-process connection
//      registry (`getConnection(...).handle.chat.getAdapter` + `ThreadImpl.fromJSON`)
//
// Steps 1 + 2 translate cleanly to `api.db.{read,write}` (publisher="tupiflow"
// is allowed cross-cutting). Step 3 cannot be replicated through the current
// PluginHostAPI surface — there is no exposed connection-registry handle, and
// `ThreadImpl.fromJSON` requires the integration-type's chat adapter which
// lives on the host. We therefore set `notified: false` and surface the
// limitation in the success-data message. The takeover state itself is
// engaged correctly; the in-thread courtesy notice just doesn't go out.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export type RequestTakeoverInput = {
  integrationId?: string;
  threadId?: string;
  reason?: string;
  notifyMessage?: string;
  connectionThreadJson?: unknown;
};

export async function requestHumanTakeoverStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  const input = ctx.input as RequestTakeoverInput;
  try {
    const integrationId = input.integrationId?.trim();
    const threadId = input.threadId?.trim();
    if (!integrationId) {
      return {
        success: false,
        error: {
          message:
            "request_human_takeover requires integrationId (passed automatically when invoked from a chat connection workflow).",
        },
      };
    }
    if (!threadId) {
      return {
        success: false,
        error: {
          message:
            "request_human_takeover requires threadId (passed automatically when invoked from a chat connection workflow).",
        },
      };
    }

    // Step 1 — gate on the connection's `human_takeover_disabled` switch.
    // `connection_settings` row is OPTIONAL; absence means takeover is allowed.
    const settingsRow = await api.db.read<{
      human_takeover_disabled: boolean | null;
    }>(
      "SELECT human_takeover_disabled FROM connection_settings WHERE integration_id = $1 LIMIT 1",
      [integrationId]
    );
    if (settingsRow[0]?.human_takeover_disabled === true) {
      return {
        success: false,
        error: {
          message:
            "Human takeover is disabled for this connection. Enable it in the connection settings before calling request_human_takeover.",
        },
      };
    }

    // Step 2 — upsert the takeover state on connection_thread_history. Mirrors
    // setHumanControl(integrationId, threadId, true, {summary, needsHumanReply:true}).
    // When `summary` is null/empty we still want the row's takeover_summary to
    // be cleared because the first-party helper persisted whatever was passed
    // (including null) when turning takeover ON with an explicit summary; the
    // "undefined → leave unchanged" path is collapsed here because v0 always
    // writes a fresh summary on engage.
    const summary = input.reason?.trim() || null;
    await api.db.write(
      `INSERT INTO connection_thread_history (
         integration_id, thread_id, human_control, needs_human_reply,
         takeover_summary, updated_at
       ) VALUES ($1, $2, TRUE, TRUE, $3, NOW())
       ON CONFLICT (integration_id, thread_id) DO UPDATE SET
         human_control = TRUE,
         needs_human_reply = TRUE,
         takeover_summary = EXCLUDED.takeover_summary,
         updated_at = NOW()`,
      [integrationId, threadId, summary]
    );

    // Step 3 — in-thread courtesy notice.
    let notified = false;
    const threadJson = ctx.threadJson;
    if (integrationId) {
      try {
        if (threadJson == null) {
          throw new Error("threadJson is missing, which is required to send a courtesy notice");
        }
        const text =
          input.notifyMessage?.trim() ||
          "An operator has been requested to take over this conversation. AI responses are now paused.";
        const replyResult = await api.connections.sendReply({
          integrationId,
          threadJson: threadJson as NonNullable<unknown>,
          text,
        });
        if (replyResult.delivered) {
          notified = true;
        }
      } catch (err) {
        api.logger.warn(
          `Failed to send human takeover courtesy notice: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return {
      success: true,
      data: {
        integrationId,
        threadId,
        humanControl: true,
        notified,
        message:
          "Human takeover engaged. AI replies are suppressed for this thread until release_human_takeover is called or the operator releases control in /chat-connections.",
        // workflow + node ids are forwarded only so consumers can correlate
        // takeover engage events with the originating execution.
        _node: ctx.nodeId,
        _execution: ctx.executionId,
        _notifyMessageProvided: typeof input.notifyMessage === "string" && input.notifyMessage.trim() !== "",
        _connectionThreadJsonProvided: input.connectionThreadJson !== undefined,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
