# Candidate write feedback and batch navigation

Compiler writes now return advisory, page-local format and declared-source
checks in the same tool response as the persistence acknowledgement. A write
remains successful when the checker reports issues or cannot run. The response
explicitly distinguishes persistence from validation. Checks never rewrite
claims, infer citations from reads, or mark coverage complete. Future-page links
and whole-library reachability remain completion checks.

The compiler supplies a read-only `candidate_lookup` host tool to all supported
execution adapters. It supports exact source ownership lookup, literal search
over page paths/titles/descriptions/bodies, and browsing without filters. Results
carry page hashes and a tree revision. Continuation requires the same revision;
changed trees require restarting the query. Invalid metadata is disclosed, not
silently treated as an exhaustive source map. Existing source-slice read guards
and Candidate/Raw read tools remain authoritative.

Map sessions receive the author's index preview and headings plus paginated
same-source page metadata. They still read BRIEF and INTENT, consult relevant
pages in full, and can read the complete index/state or search other topics.
The preview is explicitly partial and is not a generated semantic summary.
Recommendations do not restrict visibility. Custom tool allowlists without
`candidate_lookup`, or unavailable handoff data, retain the previous full-state
reading instructions. The durable compilation state and checkpoint protocol are
unchanged.

Regression coverage exercises malformed-write repair within one session,
checker failure after successful persistence, source registration errors,
future links, source mappings spanning more than one page of results, cross-topic
search, stale pagination, restricted tool lists, and symlink refusal. It also
checks both prompt locales. These deterministic tests establish workflow and
boundary behavior, not unchanged LLM answer quality or a measured cost saving.
Live evaluation should compare the same frozen input/model configuration for
source coverage, cross-document answers, unresolved contradictions, complete
tables, automatic exclusions, and unverified media, alongside calls/tokens and
repair-session counts.
