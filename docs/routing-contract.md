# Forced routing choice

Set `decisionType` to `"routing"` on `vex_choose` when the caller must select one supplied workflow or model route. Vex returns the supplied option with the highest probability even when confidence or the lead is small. Exact probability ties use the caller's option order. The response keeps `confidence` and all caller-option probabilities for analysis.

Routing responses never abstain. Missing, incomplete, or invalid probability data produces a tool error. The caller should validate the returned option ID and retry or surface the error. Omitting `decisionType` preserves the ordinary bounded-decision contract, including abstention on weak evidence.

Forced routing accepts one to twelve supplied options. Ordinary bounded decisions still require at least two.

Example request:

```json
{
  "question": "Which route meets the requested quality at the least cost?",
  "context": { "originalRequest": "Locate the owner of session storage." },
  "options": [
    { "id": "luna:low", "description": "Focused repository lookup" },
    { "id": "sol:high", "description": "Complex implementation" }
  ],
  "decisionType": "routing"
}
```
