import hashlib
import json
from pathlib import Path

import selfcheck


def fixture(tmp_path):
    (tmp_path / 'raw').mkdir()
    (tmp_path / 'candidate').mkdir()
    (tmp_path / 'authoring').mkdir()
    (tmp_path / 'raw/a.md').write_text('# Setup\n## Driver\nUse version 1.\n')
    (tmp_path / 'authoring/manifest.yaml').write_text('sources:\n- path: a.md\n  id: source-a\n')
    text = '---\ntitle: Setup\ntype: runbook\nsources:\n- resource: raw/a.md\n---\n## Install\nUse version 1. (source: a.md lines 3-3)\n'
    (tmp_path / 'candidate/guide.md').write_text(text)
    return tmp_path / 'candidate/guide.md'


def test_generated_locations_pin_raw_and_are_idempotent(tmp_path):
    page = fixture(tmp_path)
    selfcheck.attribute_evidence_sections(str(tmp_path))
    before = page.read_text()
    fm, _, _ = selfcheck.parse_okf_frontmatter(before)
    row, = fm['source_locations']
    assert row['raw_sha256'] == hashlib.sha256((tmp_path / 'raw/a.md').read_bytes()).hexdigest()
    assert row['start_line'] == row['end_line'] == 3
    assert selfcheck.attribute_evidence_sections(str(tmp_path)) == []
    assert page.read_text() == before
    assert selfcheck.source_location_violations(str(tmp_path), {'guide.md': {'text': before}}) == []
    (tmp_path / 'raw/a.md').write_text('changed\n')
    assert selfcheck.source_location_violations(str(tmp_path), {'guide.md': {'text': before}})[0]['kind'] == 'source_location_invalid'


def test_out_of_range_is_reported_not_clamped(tmp_path):
    page = fixture(tmp_path)
    page.write_text(page.read_text().replace('lines 3-3', 'lines 30-31'))
    selfcheck.attribute_evidence_sections(str(tmp_path))
    findings = selfcheck.source_location_violations(str(tmp_path), {'guide.md': {'text': page.read_text()}})
    assert 'line count' in findings[0]['detail']


def test_incremental_rebind_preserves_snapshot_hash(tmp_path):
    page = fixture(tmp_path)
    selfcheck.attribute_evidence_sections(str(tmp_path))
    before, _, _ = selfcheck.parse_okf_frontmatter(page.read_text())
    (tmp_path / 'authoring/manifest.yaml').write_text('sources:\n- path: a.md\n  id: replacement\n')
    selfcheck.normalize_evidence_source_ids(str(tmp_path))
    after, _, _ = selfcheck.parse_okf_frontmatter(page.read_text())
    assert after['source_locations'][0]['source_id'] == 'replacement'
    assert after['source_locations'][0]['raw_sha256'] == before['source_locations'][0]['raw_sha256']


def test_legacy_and_unselected_pages_stay_unchanged(tmp_path):
    page = fixture(tmp_path)
    before = page.read_text()
    assert selfcheck.attribute_evidence_sections(str(tmp_path), allowed_pages=set()) == []
    assert page.read_text() == before
    page.write_text(before.replace(' lines 3-3', ''))
    selfcheck.attribute_evidence_sections(str(tmp_path))
    assert 'source_locations:' not in page.read_text()


def test_malformed_source_location_reports_instead_of_crashing(tmp_path):
    page = fixture(tmp_path)
    selfcheck.attribute_evidence_sections(str(tmp_path))
    text = page.read_text()
    fm, _, _ = selfcheck.parse_okf_frontmatter(text)
    fm['source_locations'][0]['source_id'] = ['not-an-id']
    import re
    text = re.sub(r'(?m)^source_locations: .+$', 'source_locations: ' + json.dumps(fm['source_locations']), text)
    result = selfcheck.source_location_violations(str(tmp_path), {'guide.md': {'text': text}})
    assert result[0]['kind'] == 'source_location_invalid'


def test_code_example_locator_is_not_evidence(tmp_path):
    page = fixture(tmp_path)
    page.write_text(page.read_text().replace('(source: a.md lines 3-3)', '`(source: a.md lines 3-3)`'))
    selfcheck.attribute_evidence_sections(str(tmp_path))
    assert 'source_locations:' not in page.read_text()


def test_workspace_symlink_does_not_invalidate_locations(tmp_path):
    actual = tmp_path / 'actual'
    actual.mkdir()
    page = fixture(actual)
    alias = tmp_path / 'alias'
    alias.symlink_to(actual, target_is_directory=True)
    selfcheck.attribute_evidence_sections(str(alias))
    assert 'source_locations:' in page.read_text()
    assert selfcheck.source_location_violations(str(alias), {'guide.md': {'text': page.read_text()}}) == []


def test_oversized_raw_does_not_generate_invalid_optional_locations(tmp_path):
    page = fixture(tmp_path)
    with (tmp_path / 'raw/a.md').open('ab') as f:
        f.write(b'x' * (16 * 1024 * 1024))
    selfcheck.attribute_evidence_sections(str(tmp_path))
    assert 'source_locations:' not in page.read_text()
    assert 'source-a' in page.read_text()
    assert selfcheck.source_location_violations(str(tmp_path), {'guide.md': {'text': page.read_text()}}) == []


def test_symlink_inside_raw_remains_rejected(tmp_path):
    page = fixture(tmp_path)
    selfcheck.attribute_evidence_sections(str(tmp_path))
    outside = tmp_path / 'outside.md'
    outside.write_bytes((tmp_path / 'raw/a.md').read_bytes())
    (tmp_path / 'raw/a.md').unlink()
    (tmp_path / 'raw/a.md').symlink_to(outside)
    findings = selfcheck.source_location_violations(str(tmp_path), {'guide.md': {'text': page.read_text()}})
    assert 'symlink' in findings[0]['detail']
