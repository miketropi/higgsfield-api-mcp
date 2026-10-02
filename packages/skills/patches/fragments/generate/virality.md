## Virality Predictor — unavailable

Virality Predictor (the video-in / text-out creative scoring model, `brain_activity`) is **not available through the gateway**.

Why: no endpoint in the catalog takes a video and returns a score report. The gateway's video endpoints generate media; they do not analyse it.

What to do instead:

- Say the video-analysis workflow is unavailable through MCP and name the reason.
- Do not invent scores, and do not present a generation job as an analysis.

If the user asks to "analyze this video", "score this ad" or "evaluate the hook", that request routes to this unavailable entry — even though the upstream surface returned text rather than media.
