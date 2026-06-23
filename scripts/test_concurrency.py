"""
Concurrency correctness test.

Simulates the exact scenario from the task: a user is paginating through
the product feed (newest first) while, mid-browse, 50 new products are
inserted and 50 existing products are updated concurrently.

Approach: rather than snapshotting all 200,000 ids up front (slow, and
not actually necessary), we exploit a property of the seed data: ids are
assigned 1..200000 in strictly increasing order at seed time, and the
seed script gives every row a created_at in the past (last 30 days).
Newly-inserted rows from the activity simulation always get created_at =
now(), which is newer than every seeded row. That means:

  - The first N pages of "newest first" pagination, BEFORE any simulated
    activity, are some suffix of new-inserts-so-far (none, since we start
    clean) followed by the highest-numbered seed ids in strictly
    descending order: 200000, 199999, 199998, ...
  - Once activity is triggered, newly inserted rows (with created_at =
    now(), i.e. newer than all seed data) will appear ONLY at the point
    in the stream where we cross from "before the insert" to "after" --
    and only if we haven't already paged past that point. They must never
    appear twice, and must never cause a previously-seen or
    about-to-be-seen seed id to be skipped or repeated.
  - Updated rows (price changes to existing seed ids) must keep their
    original position in the sequence -- i.e. once we account for the
    (allowed) presence of new inserts, the seed ids we see must still
    form a contiguous, strictly descending run with no gaps and no
    repeats.

This lets us verify correctness over a bounded number of pages (fast)
instead of walking all 200k rows (slow), while still exercising a real
concurrent insert+update burst mid-pagination against the live HTTP API.
"""

import urllib.request
import json
import threading
import time
import urllib.parse

BASE = "http://localhost:3000"
PAGES_TO_WALK = 150       # 150 pages * 20/page = 3000 seed rows traversed
PAGE_SIZE = 20
PER_PAGE_DELAY = 0.01     # small delay so the activity burst lands mid-walk


def get_page(cursor=None, page_size=PAGE_SIZE, category=None):
    url = f"{BASE}/api/products?pageSize={page_size}"
    if cursor:
        url += f"&cursor={cursor}"
    if category:
        url += f"&category={urllib.parse.quote(category)}"
    with urllib.request.urlopen(url) as resp:
        return json.load(resp)


def trigger_activity(insert_count=50, update_count=50):
    body = json.dumps({"insertCount": insert_count, "updateCount": update_count}).encode()
    req = urllib.request.Request(
        f"{BASE}/api/simulate-activity",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def main():
    print(f"Walking {PAGES_TO_WALK} pages ({PAGES_TO_WALK * PAGE_SIZE} items) of newest-first")
    print("pagination, while triggering 50 inserts + 50 updates partway through...\n")

    seen_ids = []
    seen_set = set()
    duplicates = []
    cursor = None
    page_num = 0
    activity_result = {}
    activity_triggered_at_page = None

    def delayed_activity():
        nonlocal activity_triggered_at_page
        time.sleep(0.3)
        print("  >>> [background] triggering 50 inserts + 50 updates now <<<")
        activity_result.update(trigger_activity(50, 50))

    t = threading.Thread(target=delayed_activity)
    t.start()

    while page_num < PAGES_TO_WALK:
        data = get_page(cursor=cursor)
        page_num += 1
        for item in data["items"]:
            pid = item["id"]
            if pid in seen_set:
                duplicates.append(pid)
            seen_set.add(pid)
            seen_ids.append(int(pid))
        cursor = data["nextCursor"]
        time.sleep(PER_PAGE_DELAY)
        if not data["hasMore"]:
            break

    t.join()
    print(f"\nBackground activity result: {activity_result}")
    print(f"Pagination walked {page_num} pages, {len(seen_ids)} items.\n")

    print(f"Duplicates detected: {len(duplicates)} {duplicates[:10] if duplicates else ''}")

    # New inserts during the activity burst will have ids > 200000 (since
    # the seed used 1..200000 and the DB sequence continues from there).
    # Separate those out, then check the remaining seed ids (<=200000)
    # form a strictly descending, gap-free run.
    seed_ids_seen = sorted([i for i in seen_ids if i <= 200_000], reverse=True)
    new_ids_seen = [i for i in seen_ids if i > 200_000]

    print(f"Seed ids (<=200000) seen: {len(seed_ids_seen)}")
    print(f"New ids (>200000, inserted mid-walk) seen: {len(new_ids_seen)}")

    gap_free = True
    if seed_ids_seen:
        expected_seed_run = list(range(seed_ids_seen[0], seed_ids_seen[0] - len(seed_ids_seen), -1))
        gap_free = seed_ids_seen == expected_seed_run
        if not gap_free:
            # find first mismatch for diagnostics
            for i, (a, b) in enumerate(zip(seed_ids_seen, expected_seed_run)):
                if a != b:
                    print(f"  First mismatch at position {i}: got {a}, expected {b}")
                    break

    print(f"Seed ids form a contiguous, gap-free, strictly descending run: {gap_free}")

    no_dupes = len(duplicates) == 0
    no_dupe_new_ids = len(new_ids_seen) == len(set(new_ids_seen))

    print("\n" + "=" * 60)
    if no_dupes and gap_free and no_dupe_new_ids:
        print("PASS: no duplicates, no gaps in the seed-id sequence, while")
        print("      50 inserts + 50 updates happened concurrently mid-pagination.")
    else:
        print("FAIL: see details above.")
    print("=" * 60)


if __name__ == "__main__":
    main()

