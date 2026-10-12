"""source_kinds.py agrees with its cross-repo fixture.

Sicore ports is_managed_source_path / is_text_source_path to Go and checks the
port against fixtures/source-kinds/source_kinds.json. This test is the Siclaw
half of that contract: editing source_kinds.py without regenerating the
fixture fails here instead of letting the two sides drift silently.
"""

import importlib.util
import json
from pathlib import Path

import source_kinds as sk

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "source-kinds"

REGENERATE = (
    "source_kinds.py and fixtures/source-kinds/source_kinds.json disagree. "
    "From kbc/platform/pod run "
    "`python3 fixtures/source-kinds/generate.py ../../.. > fixtures/source-kinds/source_kinds.json`, "
    "then copy generate.py and source_kinds.json into Sicore "
    "internal/siclaw/knowledge/testdata/source-kinds/ and update source_kinds.go "
    "in the same change so the Go port keeps matching."
)


def load_fixture():
    return json.loads((FIXTURE_DIR / "source_kinds.json").read_text(encoding="utf-8"))


def load_generator():
    spec = importlib.util.spec_from_file_location(
        "source_kinds_fixture_generate", FIXTURE_DIR / "generate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_registry_lists_match_fixture():
    fx = load_fixture()
    actual = {
        "document_text_exts": sorted(sk.DOCUMENT_TEXT_EXTS),
        "code_text_exts": sorted(sk.CODE_TEXT_EXTS),
        "text_source_basenames": sorted(sk.TEXT_SOURCE_BASENAMES),
        "text_source_prefixes": list(sk.TEXT_SOURCE_PREFIXES),
        "visible_hidden_source_dirs": sorted(sk.VISIBLE_HIDDEN_SOURCE_DIRS),
        "visible_hidden_source_files": sorted(sk.VISIBLE_HIDDEN_SOURCE_FILES),
    }
    for key, value in actual.items():
        assert value == fx[key], f"{key}: {REGENERATE}"


def test_case_answers_match_fixture():
    fx = load_fixture()
    for case in fx["cases"]:
        path = case["path"]
        assert sk.is_managed_source_path(path) == case["managed"], f"managed {path!r}: {REGENERATE}"
        assert sk.is_text_source_path(path) == case["text"], f"text {path!r}: {REGENERATE}"


def test_fixture_covers_generator_cases():
    fx = load_fixture()
    assert [case["path"] for case in fx["cases"]] == load_generator().CASES, REGENERATE
