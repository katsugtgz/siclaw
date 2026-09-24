# source-kinds fixture

Canonical registry lists and per-path answers of `source_kinds.py`
(`is_managed_source_path`, `is_text_source_path`). Sicore keeps an identical
copy in `internal/siclaw/knowledge/testdata/source-kinds/` and checks its Go
port (`source_kinds.go`) against it; `test_source_kinds.py` checks the Python
module here.

When `source_kinds.py` or the `CASES` in `generate.py` change, regenerate from
`kbc/platform/pod`:

```sh
python3 fixtures/source-kinds/generate.py ../../.. > fixtures/source-kinds/source_kinds.json
```

Then copy `generate.py` and `source_kinds.json` into Sicore and update
`source_kinds.go` in the same change. `siclaw_commit` records the checkout the
fixture was generated from; the tests ignore it.
