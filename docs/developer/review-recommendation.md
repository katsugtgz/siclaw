# Optional review recommendations

Set `SICLAW_REVIEW_RECOMMENDATION=1` in the AgentBox environment to make the `report_analysis_recommendation` tool eligible for discovery. The Agent's existing tool allow-list still applies: explicitly allow the tool where the policy restricts workflow tools. No prompt override or extra judge model is installed.

The tool asks the model to submit a bounded recommendation before its final answer. Calling it is optional; missing data is unknown, not a negative verdict. It admits `high`, `medium`, `low`, `unknown`, at most six distinct reason codes, and a bounded confidence enum. One accepted call per prompt turn avoids repeated annotations. The reply is brief; the structured values live in the result `details`.

The existing shared `persistableToolDetails` path retains these fields in persisted tool-message metadata for Web and delegated/synthetic persistence paths. A consumer must require the exact tool name and successful outcome, ignore failed calls, and exclude automated-review sessions from candidate enumeration. This is a model's self-report and must not override errors or explicit user feedback.

Enable on a sample of Agents first. Measure invocation coverage, extra model/tool round trips, and false negatives against independently reviewed samples before using recommendations to suppress reviews. There is no claim that every completed turn emits a recommendation, or that tool success proves the original user task succeeded.
