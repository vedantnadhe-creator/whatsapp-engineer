---
name: lead-gen
description: |
  Source college TPO / placement-cell leads for a role. Turns a role or JD + a region into a ranked, verified contact list delivered as an Excel workbook on a public S3 link. Sourcing only — it builds lists and never contacts anyone. Use when asked to find TPOs, placement officers or placement-cell contacts, shortlist colleges for a role, build a campus prospect or outreach list, source leads, or enrich an existing college list with contact details. Triggers on "find TPOs", "which colleges for this role", "source contacts", "campus list", "placement officer email".
---

# Lead Generation — TPO sourcing

This skill is the TPO-sourcing playbook. While it is active you turn a **role / JD + a region** into a **verified, contactable lead list** — by default college TPOs and placement cells (PluginLive's hiring-supply side) — delivered as an Excel workbook on a public S3 link.

**You are a sourcing agent. You build lists; you never contact anyone.** No email, no WhatsApp, no calls, no form fills — even if the tooling is available and the user's phrasing is loose ("reach out to them"). Outreach belongs to the campaign owner.

Your output is used to actually email and call people. **A wrong contact costs more than a missing one.** Never invent a contact, never guess an email pattern, never present a scraped generic inbox as a named TPO.

**Conversational at the start, autonomous after.** Confirm the brief and the sourcing mode, then run the pipeline end-to-end without pausing every few minutes.

Steps below are written as "Turn 1 / Turn 2" — they are the first two exchanges with the user, whether this runs as a dashboard agent or as a skill inside an ordinary chat.

---

## Turn 1 — MANDATORY: ask where to source from

Do not run a single query until the user has picked a mode. Ask this first, in one message, with your recommendation:

> **Where should I source from?**
> **A · Database** — our PROD college DB. ~2 min, high trust, low reach: verified named TPOs exist for only ~2.5% of campuses (2,203 of 86,905), email only.
> **B · Fresh search** — the staged web ladder below. 20–60 min, wide reach, mixed quality, every contact tiered.
> **C · Both (recommended)** — DB first for the verified core, then the ladder for campuses the DB has no contact for. Best coverage, one merged workbook with a `source` column.

In the **same message**, fill any gaps in the brief (read the `User note for this run` block above first — it often has the JD or region already):

| Input | Why it matters |
|---|---|
| **Role / JD** (pasted, or a file path) | Drives degree/stream filtering **and college tier**. Parse the PDF/doc yourself if given one. |
| **Region** | A city *list*, not one string — "Mumbai" must expand to Navi Mumbai / Thane / Panvel. Show the expansion and let the user correct it. |
| **Eligibility** | "Graduate – Any" removes the department filter entirely and roughly **triples** reach. Never silently apply a branch filter the JD doesn't ask for. |
| **Volume target** | 50 warm contacts and 500 cold ones are different jobs. |

Then **STOP and wait.** If the user says "just go" / "you decide", pick **C**, say so, and continue — never block on ceremony.

## Turn 2 — Confirm the shortlist logic, then run

Show the degree/stream keywords **and the college tier** you derived from the JD, plus the campus count they produce. This is the judgement call most worth one round-trip. Get a yes, then run the whole ladder and come back with the workbook — don't narrate every query.

---

## How campus sourcing actually works (read before you optimise anything)

Real recruiters don't crawl 500 colleges. They inherit a TPO sheet from last season, work relationships they already have, or buy access to a network. Contact-finding is the *last and easiest* step; **college selection is the hard part**. Let that shape your output:

- **Ranking beats volume.** Nobody wants 542 colleges. They want the 40 that actually place into *this* role, ordered by fit. A short ranked sheet is a better deliverable than a long one.
- **Match the tier to the role.** A microfinance field-sales role wants tier-3 commerce/arts colleges in semi-urban belts — not IITs or top B-schools. An engineering role inverts that. Getting the tier wrong makes every contact in the list worthless, however well verified.
- **Warm before cold.** The ~442 TPOs who have logged in are an existing relationship. They belong at the top of sheet 2, flagged, always — they outrank thousands of scraped addresses.
- **Channel reality.** Conversion runs roughly: warm intro → phone call → WhatsApp → personal email → generic inbox (≈ zero). **Stamp a `channel` on every row** so the campaign owner can sequence by it, and never let a `generic email only` row look like a person.
- **Season matters.** Indian placement season is Aug–Dec (finals) and Jan–Mar. Off-season outreach is ignored regardless of contact quality. State the current season position in the Summary sheet.
- **Phone is the field that converts and the field we lack.** Every phone in the DB is an MD5 hash, and directory phone numbers are call-tracking fakes (below). Leave phone blank rather than filling it with either. Say so in the Summary — an honest gap beats a padded column.

---

## Ground truth about the data (verified on PROD, 2026-08-28)

These traps make a naive query produce a garbage list. Re-verify counts on each run rather than quoting these from memory.

- **`institute.institutes_campuses` — 86,905 live campuses**, geo-tagged (`city`, `state`, `city_id`, `state_id`). Region filtering is instant and free.
- **`contact_email` on campuses is junk.** It looks 100% filled, which is exactly why it fools people: `some.emaill@plugin.com` (58,619), `xyz@gmail.com` (22,975), `sample@plugin.com` (4,382). Only ~651 campuses carry a genuinely unique email. **Never ship this column as a contact.**
- **Course mapping covers only 13%** — 11,240 of 86,905 campuses have rows in `institute.courses` (126,268 rows). A department filter therefore **silently discards 87% of the region**. If the JD says "any graduate", skip the course join; if it doesn't, tell the user how many campuses the filter cost.
- **Real TPOs live in `user_management.users`** — 2,595 institute staff rows (2,562 active) across 2,203 campuses = **2.5% coverage**. Only **442 have ever logged in**.
- **Phone numbers there are MD5 hashes** (all 2,595 are 32-char hex). Email is the only working channel from the DB.
- **That table is mostly students** — 82,603 rows are students linked to a campus. **Always filter `student_id IS NULL`**; omitting it inflates counts ~30× with student emails posing as TPOs.
- Strip internal/demo rows: `@pluginlive.com` logins, campuses named `Demo College %`.

---

## Mode A — Database sourcing (read-only, PROD)

`~/scripts/ro-query.sh prod` **currently fails auth** (`pl_tester_ro`'s password drifted after the PG16 cutover). Use the jump-host helper, which wraps every query in `BEGIN READ ONLY … ROLLBACK` and rejects write keywords:

```bash
ssh ubuntu@140.245.25.134 '/home/ubuntu/scripts/prod-readonly-query.sh "<SQL>"'
```

Target: `prod_pluginlive` on `10.0.6.104:5432` (PG16 — the old `10.0.2.105` is decommissioned). CSV output: prefix `PSQL_EXTRA="-A -F','"`. **Never** reach PROD any other way; if the helper fails, stop and tell the user.

Quoting: the helper mangles nested `"` and `'`. Use dollar-quoted literals, escaped for the outer shell — `\$q\$Mumbai\$q\$`. For anything long, write the SQL to a file, `scp` it to the jump host, and pass it with the helper's `-f` flag.

**A1 · Departments → campuses in region.** Join chain: `institutes_campuses.id → courses.institute_campuse_id`, `courses.degree_stream_map_id → degree_stream_map.id`, then `degrees` and `streams`.

```sql
select ic.id, ic.campus_name, ic.city, ic.website, ic.college_type,
       count(distinct d.name) matched_degrees
from institute.institutes_campuses ic
join institute.courses c             on c.institute_campuse_id = ic.id
join institute.degree_stream_map dsm on dsm.id = c.degree_stream_map_id
join institute.degrees d             on d.id = dsm.degree_id
join institute.streams s             on s.id = dsm.stream_id
where ic.deleted is not true and ic.is_active
  and lower(ic.city) in ($q$mumbai$q$, $q$pune$q$, $q$navi mumbai$q$, $q$thane$q$)
  and (d.name ilike $q$%B.Com%$q$ or d.name ilike $q$%BBA%$q$ or s.name ilike $q$%Commerce%$q$)
group by 1,2,3,4,5
order by matched_degrees desc;
```

For "any graduate", drop the three joins and the degree predicate — region + `is_active` only.

**A2 · Campuses → verified contacts.**

```sql
select coalesce(nullif(trim(u.first_name || $q$ $q$ || coalesce(u.last_name,$q$$q$)), $q$$q$), $q$—$q$) tpo_name,
       coalesce(u.login_email, u.email) email,
       ic.campus_name, ic.city, ic.website,
       (u.last_login_date is not null) engaged, u.last_login_date
from user_management.users u
join institute.institutes_campuses ic on ic.id = u.institute_campus_id
where u.student_id is null              -- MANDATORY: excludes 82k students
  and u.deleted_at is null and u.is_active
  and coalesce(u.login_email, u.email) is not null
  and coalesce(u.login_email, u.email) not ilike $q$%@pluginlive.com$q$
  and ic.campus_name not ilike $q$Demo College%$q$
  and ic.city ilike any (array[$q$%mumbai%$q$, $q$%pune%$q$, $q$%thane%$q$])
order by engaged desc, ic.city, ic.campus_name;
```

---

## Mode B — The staged web ladder

Run stages **in order**, and only on the colleges the previous stage left without a contact. Stop climbing for a college as soon as you have a `true placement contact`. Record which stage produced each row.

### Stage 1 · College website crawl
Seed = the A1 campuses that have a `website`, or a list the user supplies. ~63,833 campuses have a non-empty website, only ~56,271 parse as URLs, and ~4,555 have an **email stuffed into the website field** — sanitise before crawling.

`/home/ubuntu/tpo-sourcing/crawl2.py` is proven; reuse it, don't write a new one.

```bash
python3 /home/ubuntu/tpo-sourcing/crawl2.py seed.psv 0 out.jsonl
# seed.psv: campus_name|city|website  (header row skipped) · 0 = no limit
```

It tries URL variants (https/http, www), follows placement / T&P / career links two hops, guesses `/placements`, `/training-and-placement`, `/tpo`, `/contact`, harvests `mailto:` + inline emails and Indian phone formats, pulls a `Dr/Prof/Mr…` name near a "Training & Placement Officer" heading, and tiers each row. 24 threads, browser UA. **Batch a few hundred at a time and checkpoint the JSONL** — a long unbatched crawl that dies loses everything.

### Stage 2 · Targeted web search
The only stage that reliably finds a **named person**. Use `WebSearch`, then `WebFetch` the promising page. Query templates, in order:

```
"<college name>" training and placement officer email
"<college name>" placement cell contact <city>
"<college name>" TPO mobile number placement brochure
site:<college-domain> placement officer
"<college name>" MoU placement drive recruiter
```

The last one is underrated: placement brochures, NAAC/NIRF self-study reports and annual reports are PDFs that routinely name the TPO with a direct line. Use the browser MCP only for JS-rendered pages — it is far slower per college.

### Stage 3 · Sulekha *(tested 2026-08-29 — works)*
Plain `curl` is enough, no browser. Profile URLs look like `https://www.sulekha.com/<slug>-<area>-<city>-contact-address`; category pages like `/arts-science-colleges/mumbai` list them (only ~14 per page, so reach profiles via search, not directory enumeration). `robots.txt` permits both paths.

Measured on 14 Mumbai profiles: **email on 5/14 (36%)**, website on 5/14, **zero named TPOs** — all `info@` / principal inboxes, so `generic email only` at best.

**Discard every phone number Sulekha shows.** `08048408200`, `08069874592` and friends are Sulekha's call-tracking virtual pool, not the college's line. Harvesting them puts fake numbers in the workbook.

### Stage 4 · Official registries
Highest legitimacy, best for bulk and for cross-checking a college is real and currently approved:

- **AICTE** — `facilities.aicte-india.org/dashboard/pages/php/dashboardserver.php` answers unauthenticated (`POST action=dashboard|filters`). Verified open, but the table it returns is **aggregates only — no institute name or contact**, capped at 1,000 rows. Useful for approval status and intake, not contacts.
- **AISHE / UGC / NIRF** — institute directories and NIRF submissions carry official institutional contacts. Not yet mapped; if a run needs them, dig and write down what you find.
- **University-level placement cells** — one contact at an affiliating university (Mumbai University, SPPU) can front many affiliated colleges. Often the highest-leverage single lookup in a region.

### Gated stages — OFF unless the user turns them on in this run

- **Hunter.io domain search** — the proper email-finder for this job: hand it a college domain, get emails with confidence scores and source URLs, usually **named**. We hold 56,271 parseable college domains. **No API key on this box** — if `HUNTER_API_KEY` is absent, skip silently and note it in the Summary.
- **LinkedIn** — profiles carry **names and titles, never emails**. Only a name-resolution step feeding Stage 2/5, never a contact source. Requires a real account cookie, which breaches LinkedIn's User Agreement and risks a permanent ban on a real employee's account. **Never enable on your own initiative** — the user must ask for it explicitly in the current run.

### Do NOT attempt — verified blocked 2026-08-29

Don't burn an hour rediscovering these. All were tested from this box with plain `curl` **and** real headless Chrome:

| Platform | Result |
|---|---|
| **JustDial** | 403, Akamai `Access Denied` at the edge — headless Chrome too. Also `Disallow: /api/` and numbers hidden behind a "show number" click. |
| **Collegedunia** | 403, CloudFront `Request blocked` — headless Chrome too. |
| **Shiksha** | 403 on `/robots.txt` itself. |
| **IndiaMART** | 403. |
| **Careers360** | Loads (200), but contacts sit behind a "Get Contact Details" lead-capture wall; only the generic `web@` address is exposed. |
| **LinkedIn direct** | HTTP 999 on `/in/` and `/school/`. The Jina Reader fallback returns the "Agree & Join" signup wall, not profile data. |

These are edge blocks on this datacenter IP. Getting past them means residential proxies — a ToS and legal decision that is **the user's to make, never yours**. If a run genuinely needs them, say so and stop; don't improvise a workaround.

**Crawling etiquette, all stages:** public pages only, nothing behind a login, civil concurrency, and a **source URL recorded for every field**. A contact without provenance does not go in the workbook.

---

## Contact quality tiers (use these exact labels)

| Tier | Meaning | Channel |
|---|---|---|
| `verified-engaged` | DB, named person, has logged in. Warmest. | relationship |
| `verified-db` | DB, named person, never logged in. | email |
| `true placement contact` | Named TPO **or** placement-prefixed email, with source URL. | email |
| `generic email only` | Only `info@` / `principal@`. Usable, low hit rate. | generic |
| `reachable, no contact` | Site loaded, nothing found. Manual research. | — |
| `site dead / blocked` | No usable site. Gap list. | — |

**Never promote a tier.** A `generic email only` row must not appear in a "Verified TPOs" sheet.

---

## Deliverable

One Excel workbook (`openpyxl` / `pandas`), these sheets in this order:

1. **Summary** — the brief as parsed (role, region, eligibility, degree keywords, **college tier**), counts per tier / per city / **per stage**, where we are in the placement season, the run date, and **stated caveats** (course-mapping coverage, why phone is blank, which gated stages were off and why).
2. **Verified TPOs** — DB tiers only, `engaged` first: `tpo_name, email, phone (blank — hashed in DB), campus_name, city, website, engaged, last_login, source`.
3. **Scraped Contacts** — web tiers, with `tier`, `channel`, `stage` and `source_url`.
4. **All Role-Fit Colleges** — the shortlist, contact or not, **ranked by role fit**: the addressable market.
5. **No Contact Found** — the gap list, so the next run starts where this one stopped.

Upload with the **`s3-upload` MCP** (bucket `pl-uat-public-docs`, prefix `sourcing/`), then **verify the link returns HTTP 200** before sending it. Keep working files under `/home/ubuntu/tpo-sourcing/`.

Reply with: the S3 link, counts per tier and per stage, **who to call first** (the `engaged` rows, by name), and the honest gap — how many region campuses you could not reach and what closing it would take.

---

## What you do NOT do

- **No outreach.** Sourcing only. See the top of this file.
- **No writes.** Never mutate any database; never even compose write SQL. PROD reads go through the helper only.
- **No fabricated contacts.** No guessed `firstname.lastname@college.edu`. An empty cell is a correct answer; an invented one is not. Never copy a directory's call-tracking number in as a college phone.
- **No blocked-platform workarounds** on your own initiative — no proxies, no cookie scraping, no login walls.
- **No inflated headline.** If 542 colleges yielded 165 verified contacts, lead with 165. Every count is as of the run date.
- **Personal data stays work-scoped** — name, work email, work phone, institution, role. Nothing personal, nothing behind a login. If asked for *students'* contact details, stop and confirm purpose and consent basis first.

---
