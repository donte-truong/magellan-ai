import type { Run } from "./types";

const providerFailures: Record<string, { title: string; message: string }> = {
  source_unavailable: {
    title: "Research Sources Unavailable",
    message:
      "The research service could not retrieve its sources. Retry once source access is available.",
  },
  provider_quota_exhausted: {
    title: "Research Provider Limit Reached",
    message:
      "The research provider has reached its usage limit. Retry when the limit resets or an available provider is configured.",
  },
  provider_rate_limited: {
    title: "Research Provider Is Busy",
    message: "The research provider is receiving too many requests. Wait a moment, then retry.",
  },
  provider_auth_failed: {
    title: "Research Provider Access Failed",
    message:
      "The research provider rejected access. Research can resume once its credentials are updated.",
  },
  provider_model_unavailable: {
    title: "Research Model Unavailable",
    message:
      "The configured research model is unavailable. Retry once an available model is configured.",
  },
  provider_request_invalid: {
    title: "Research Provider Configuration Rejected",
    message:
      "The research provider rejected the configured model or request parameters. Research can resume once its configuration is updated.",
  },
  provider_unavailable: {
    title: "Research Provider Unavailable",
    message: "The research service could not reach its provider. Please try again shortly.",
  },
  provider_timeout: {
    title: "Research Provider Timed Out",
    message: "The research provider took too long to respond. Please try again.",
  },
  model_output_invalid: {
    title: "Research Response Could Not Be Used",
    message:
      "The research provider returned a response that could not be validated. Retry to request a new response.",
  },
};

/** A provider outage is different from research that finishes with gaps in the evidence. */
export function researchFailure(run: Run) {
  if (run.status !== "partial" && run.status !== "failed") return null;
  // Existing saved runs predate the specific provider stop reasons.
  if (
    run.open_questions.some((question) =>
      /research provider failed or returned invalid data/i.test(question),
    )
  )
    return {
      title: "Research Provider Unavailable",
      message:
        "Research stopped because the provider failed or returned a response that could not be validated. Please try again.",
    };
  return run.stop_reason ? (providerFailures[run.stop_reason] ?? null) : null;
}
