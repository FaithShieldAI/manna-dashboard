#!/usr/bin/env python3
"""
Import Michael's contact databases into Manna's influencers table.

Sources:
- Pastor emails: ~/workspace/goals/faithshield-and-angel-warriors-marketing-funnels/files/*pastor*.csv
  -> category='pastor'
- Influencer emails: ~/workspace/goals/faithshield-and-angel-warriors-marketing-funnels/files/influencer-youtube-scraped.csv
  -> category='influencer', tier parsed from audience_size

Deduplicates by email (case-insensitive). Inserts for tenant_id=1.
Existing records are preserved; only new emails are added.

Usage:
    python3 scripts/import-contacts.py [--db PATH] [--dry-run]

Default DB: data/staging.db (relative to repo root)
"""

import argparse
import csv
import glob
import os
import re
import sqlite3
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(REPO_ROOT, "data", "staging.db")
FILES_DIR = os.path.expanduser(
    "~/workspace/goals/faithshield-and-angel-warriors-marketing-funnels/files"
)
INFLUENCER_CSV = os.path.join(FILES_DIR, "influencer-youtube-scraped.csv")
PASTOR_GLOB = os.path.join(FILES_DIR, "*pastor*.csv")

TENANT_ID = 1


def parse_audience_size(raw):
    """Convert '1.3M subscribers' / '687K subscribers' / '980 subscribers' to int. Returns None if unparseable."""
    if not raw:
        return None
    raw = raw.strip()
    m = re.match(r"^([\d,.]+)\s*([KMB]?)\b", raw, re.IGNORECASE)
    if not m:
        return None
    num_str, suffix = m.group(1), m.group(2).upper()
    try:
        num = float(num_str.replace(",", ""))
    except ValueError:
        return None
    multiplier = {"": 1, "K": 1_000, "M": 1_000_000, "B": 1_000_000_000}.get(suffix, 1)
    return int(num * multiplier)


def size_to_tier(size):
    """Map subscriber count to tier."""
    if size is None:
        return None
    if size >= 1_000_000:
        return "mega"
    if size >= 100_000:
        return "macro"
    if size >= 10_000:
        return "micro"
    if size >= 1_000:
        return "nano"
    return None  # below nano threshold


def read_pastor_csvs():
    """Yield dicts: handle, platform, email, tier, category, status, notes."""
    records = []
    files = sorted(glob.glob(PASTOR_GLOB))
    for path in files:
        try:
            with open(path, newline="", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    email = (row.get("email") or "").strip()
                    if not email or "@" not in email:
                        continue
                    pastor_name = (row.get("pastor_name") or "").strip()
                    title = (row.get("title") or "").strip()
                    church = (row.get("church_name") or "").strip()
                    handle = pastor_name or church or email
                    notes_parts = []
                    if title:
                        notes_parts.append(title)
                    if church:
                        notes_parts.append(church)
                    denom = (row.get("denomination") or "").strip()
                    if denom:
                        notes_parts.append(denom)
                    extra_notes = (row.get("notes") or "").strip()
                    if extra_notes:
                        notes_parts.append(extra_notes)
                    records.append({
                        "handle": handle[:200],
                        "platform": None,
                        "email": email.lower(),
                        "tier": None,
                        "category": "pastor",
                        "status": "unvetted",
                        "notes": "; ".join(notes_parts)[:1000] or None,
                    })
        except Exception as e:
            print(f"  WARNING: could not read {os.path.basename(path)}: {e}", file=sys.stderr)
    return records, len(files)


def read_influencer_csv():
    """Yield dicts from the YouTube influencer scrape."""
    records = []
    if not os.path.exists(INFLUENCER_CSV):
        print(f"  WARNING: influencer CSV not found: {INFLUENCER_CSV}", file=sys.stderr)
        return records
    with open(INFLUENCER_CSV, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            email = (row.get("email") or "").strip()
            if not email or "@" not in email:
                continue
            name = (row.get("name") or "").strip()
            platforms = (row.get("platforms") or "").strip()
            platform = None
            if platforms:
                # Take first platform, normalize
                platform = platforms.split(",")[0].strip().lower()
            size = parse_audience_size(row.get("audience_size") or "")
            tier = size_to_tier(size)
            niche = (row.get("niche") or "").strip()
            vet_notes = (row.get("vet_notes") or "").strip()
            notes_parts = []
            if niche:
                notes_parts.append(niche)
            if vet_notes:
                notes_parts.append(vet_notes)
            # Map vet_status to our status values
            vet_status = (row.get("vet_status") or "").strip().upper()
            status = "unvetted"
            if vet_status in ("VETTED",):
                status = "vetted"
            elif vet_status in ("CONTACTED",):
                status = "contacted"
            elif vet_status in ("REJECTED",):
                status = "rejected"
            records.append({
                "handle": (name or email)[:200],
                "platform": platform,
                "email": email.lower(),
                "tier": tier,
                "category": "influencer",
                "status": status,
                "notes": "; ".join(notes_parts)[:1000] or None,
            })
    return records


def main():
    parser = argparse.ArgumentParser(description="Import contacts into Manna influencers table")
    parser.add_argument("--db", default=DEFAULT_DB, help="Path to SQLite DB")
    parser.add_argument("--dry-run", action="store_true", help="Parse and report without inserting")
    args = parser.parse_args()

    if not os.path.exists(args.db):
        print(f"ERROR: DB not found: {args.db}", file=sys.stderr)
        sys.exit(1)

    print("Reading pastor CSVs...")
    pastor_records, pastor_files = read_pastor_csvs()
    print(f"  {pastor_files} files, {len(pastor_records)} raw pastor records")

    print("Reading influencer CSV...")
    influencer_records = read_influencer_csv()
    print(f"  {len(influencer_records)} raw influencer records")

    # Deduplicate by email, pastors first (they take precedence on collision)
    seen = {}
    for r in pastor_records:
        if r["email"] not in seen:
            seen[r["email"]] = r
    pastor_dupes = len(pastor_records) - len([r for r in pastor_records if r["email"] in seen and seen[r["email"]] is r])
    for r in influencer_records:
        if r["email"] not in seen:
            seen[r["email"]] = r

    all_records = list(seen.values())
    n_pastors = sum(1 for r in all_records if r["category"] == "pastor")
    n_influencers = sum(1 for r in all_records if r["category"] == "influencer")
    print(f"Deduplicated: {len(all_records)} unique emails "
          f"({n_pastors} pastors, {n_influencers} influencers)")

    # Tier breakdown for influencers
    tier_counts = {}
    for r in all_records:
        if r["category"] == "influencer":
            tier_counts[r["tier"] or "unknown"] = tier_counts.get(r["tier"] or "unknown", 0) + 1
    print(f"  Influencer tiers: {tier_counts}")

    conn = sqlite3.connect(args.db)
    cur = conn.cursor()

    # Verify tenant exists
    cur.execute("SELECT id FROM tenants WHERE id = ?", (TENANT_ID,))
    if not cur.fetchone():
        print(f"ERROR: tenant_id={TENANT_ID} does not exist in {args.db}", file=sys.stderr)
        sys.exit(1)

    # Existing emails for this tenant
    cur.execute("SELECT LOWER(email) FROM influencers WHERE tenant_id = ? AND email IS NOT NULL AND email != ''", (TENANT_ID,))
    existing = {row[0] for row in cur.fetchall()}
    print(f"Existing influencer emails for tenant {TENANT_ID}: {len(existing)}")

    to_insert = [r for r in all_records if r["email"] not in existing]
    skipped = len(all_records) - len(to_insert)
    print(f"New records to insert: {len(to_insert)} (skipped {skipped} already present)")

    if args.dry_run:
        print("DRY RUN - no changes made.")
        conn.close()
        return

    inserted = 0
    for r in to_insert:
        try:
            cur.execute(
                """INSERT INTO influencers
                   (tenant_id, handle, platform, email, tier, category, status, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (TENANT_ID, r["handle"], r["platform"], r["email"],
                 r["tier"], r["category"], r["status"], r["notes"]),
            )
            inserted += 1
        except sqlite3.IntegrityError as e:
            print(f"  WARNING: skipped {r['email']}: {e}", file=sys.stderr)

    conn.commit()

    # Final counts
    cur.execute(
        "SELECT category, COUNT(*) FROM influencers WHERE tenant_id = ? GROUP BY category",
        (TENANT_ID,),
    )
    final = dict(cur.fetchall())
    conn.close()

    print(f"\nInserted {inserted} new records.")
    print(f"Final counts for tenant {TENANT_ID}: {final}")


if __name__ == "__main__":
    main()
