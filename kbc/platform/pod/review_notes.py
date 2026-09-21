"""Durable compiler investigations; only explicit owner decisions become tickets."""
import json
from datetime import datetime, timezone
from pathlib import Path

import selfcheck

PATH = "authoring/REVIEW_NOTES.json"
MAX_NOTES = 256


def read(workdir):
    path = Path(workdir) / PATH
    if not path.exists():
        return []
    rows = json.loads(path.read_text("utf-8"))
    if not isinstance(rows, list) or any(not isinstance(r, dict) or not isinstance(r.get("id"), str) for r in rows):
        raise ValueError("invalid investigation ledger; preserve it and repair before updating")
    return rows


def save(workdir, rows):
    text = json.dumps(rows, ensure_ascii=False, indent=2) + "\n"
    if len(rows) > MAX_NOTES or len(text.encode()) > 512 * 1024:
        raise ValueError("investigation ledger limit reached; consolidate existing issues")
    path = Path(workdir) / PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    selfcheck._write_text_atomic(path, text)


def text(args, key, maximum=2000):
    value = args.get(key, "")
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError(f"{key} must be text of at most {maximum} characters")
    return value.strip()


def record(workdir, ticket, args, *, defer_owner=False):
    """Returns a note and whether the caller may file it. No semantic auto-judge."""
    action = args.get("review_action", "investigate")
    if action not in {"investigate", "resolved", "needs_owner"}:
        raise ValueError("review_action must be investigate, resolved or needs_owner")
    rows = read(workdir)
    requested = text(args, "review_id", 128)
    identity = requested or ticket["id"]
    previous = next((row for row in rows if row["id"] == identity), None)
    if requested and previous is None:
        raise ValueError("review_id does not exist; read REVIEW_NOTES.json before reusing an issue")
    if previous and (previous.get("ticket_id") or previous.get("proposed_ticket_id")):
        # Reuse the existing ticket's identity, even when the question is reworded.
        ticket["id"] = previous.get("ticket_id") or previous["proposed_ticket_id"]
    tickets, error = selfcheck._read_ticket_ledger(Path(workdir) / selfcheck.CONTRADICTIONS_PATH)
    if error:
        raise ValueError(error)
    requested_ticket = text(args, "existing_ticket_id", 128)
    if requested_ticket:
        if not any(isinstance(row, dict) and row.get("id") == requested_ticket for row in tickets):
            raise ValueError("existing_ticket_id does not exist; read CONTRADICTIONS.json before linking")
        bound = (previous or {}).get("ticket_id") or (previous or {}).get("proposed_ticket_id")
        if bound and bound != requested_ticket:
            raise ValueError("existing_ticket_id conflicts with this investigation's existing binding")
        linked = next((row for row in rows if row.get("ticket_id") == requested_ticket
                       or row.get("proposed_ticket_id") == requested_ticket), None)
        if linked is not None and linked is not previous:
            if requested or previous is not None:
                raise ValueError("existing ticket already has an investigation; reuse its review_id")
            previous = linked
            identity = linked["id"]
        ticket["id"] = requested_ticket
    existing = next((row for row in tickets if isinstance(row, dict) and row.get("id") == ticket["id"]), None)
    investigation = text(args, "investigation")
    impact = text(args, "answer_impact")
    decision = text(args, "owner_decision")
    if action == "resolved" and not investigation:
        raise ValueError("resolved requires the evidence and conclusion in investigation")
    if action == "needs_owner" and (not investigation or not impact or not decision):
        raise ValueError("Before escalating, provide investigation (sources checked and why unresolved), answer_impact (a concrete affected question), and owner_decision (information only the owner can supply). Otherwise use investigate.")
    if action == "resolved" and (existing is not None or (previous and previous.get("ticket_id"))):
        raise ValueError("This issue already has an owner ticket; use its existing ruling/closure workflow")
    if previous is None and len(rows) >= MAX_NOTES:
        raise ValueError("investigation ledger limit reached; consolidate existing issues")
    escalate = action == "needs_owner" and not defer_owner
    state = "pending" if action == "investigate" or (action == "needs_owner" and defer_owner) else action
    note = {"id": identity, "title": ticket["title"], "question": ticket["question"],
            "sources": ticket["sources"], "affected_pages": ticket["affected_pages"],
            "state": state, "investigation": investigation, "answer_impact": impact,
            "owner_decision": decision, "updated_at": datetime.now(timezone.utc).isoformat()}
    if existing is not None:
        note["ticket_id"] = existing["id"]
    elif previous and previous.get("ticket_id"):
        note["ticket_id"] = previous["ticket_id"]
    # A pending record is saved first. A ticket-write failure never creates a
    # false escalation receipt. finish() runs only after the ticket is saved.
    if previous and previous.get("proposed_ticket_id"):
        note["proposed_ticket_id"] = previous["proposed_ticket_id"]
    if escalate:
        note["proposed_ticket_id"] = ticket["id"]
        note["state"] = "pending"
    if previous is None:
        rows.append(note)
    else:
        rows[rows.index(previous)] = note
    # Rediscovery is independent of escalation. Refresh only the existing
    # ticket's operation stamp before saving a successful investigation receipt.
    # No await separates these writes; a failed note save can be retried without
    # erasing the owner's answer or falsely declaring this conflict absent.
    if existing is not None and ticket.get("filed_operation_id"):
        existing["filed_operation_id"] = ticket["filed_operation_id"]
        existing["filed_generation"] = ticket["filed_generation"]
        selfcheck._write_text_atomic(Path(workdir) / selfcheck.CONTRADICTIONS_PATH,
                                    json.dumps(tickets, ensure_ascii=False, indent=2))
    save(workdir, rows)
    return note, escalate


def finish(workdir, note_id, ticket_id):
    rows = read(workdir)
    note = next(row for row in rows if row["id"] == note_id)
    note.update(state="needs_owner", ticket_id=ticket_id)
    save(workdir, rows)
