# PROD hotfix plan — `release-v1.37-hotfix-1`

Prepared: 2026-08-14 UTC  
Active sprint: sprint 34  
Release type: hotfix  
Expected baseline: current PROD release branches  
Source changelog: https://bmv2bqg5gpcd.compat.objectstorage.ap-mumbai-1.oraclecloud.com/pl-uat-public-docs/reports/uat-promotion-changelog-2026-08-14.html

This is a readiness and execution plan. It does not authorize branch creation, SQL,
environment/configmap changes, or deployment. Each mutation remains a separate gate.

## 1. Approved code changelog

### Full UAT promotion

| Service | Current PROD branch | Promotion | Summary |
|---|---|---|---|
| `institute-react-v2` | `release-v1.37` | Full `origin/UAT` promotion | TPO dashboard counters, filters, assessment management, diagnosis, schedules, reports, PDF and workbook fixes. The PROD-only containerization commit `063a9f7` must remain in the resulting hotfix branch. |
| `institute-node` | `release-v1.37` | Full `origin/UAT` promotion | Matching dashboard calculations, diagnosis pairing, recurring-report metrics, roster context and scheduled-run ordering. |

### Explicit cherry-picks only

| Service | Commit(s) | Intended change |
|---|---|---|
| `admin-node` | `75c8be1` | Remove null JSON fields before audit-log writes for Prisma 4 compatibility. |
| `corporate-node` | `2bbee205` | Align the Prisma client with UAT/PROD at Prisma 5.22.0. |
| `student-node` | `7f2b2d59`, `c5283f9e` | Convert null JSON fields before profile updates and prevent empty master-sync requests from failing profile saves. |
| `form-data-normalization` | `b3c9240` | Improve student-metrics analytics filters and export coverage, including tests. |
| `admin-react` | `fc8fe1c5`, `ffb77768` | Show active campuses only; validate year values and de-duplicate campuses. |
| `search-service` | `e64ab69` | Refresh course and events materialized views after course create/update/delete operations. |

All listed cherry-pick objects were confirmed after refreshing the configured Git
remote metadata, except `form-data-normalization`, which cannot yet be checked through
the canonical repository configuration (see blockers).

### Explicit exclusions

- Do not promote any other repository wholesale.
- Exclude unrelated notifications, ATS, assessment and search work.
- Exclude the TPO Time Taken export and campus-toggle pending-badge changes in
  `student-node` unless separately approved.
- Exclude the joined-candidate placement count correction in `student-node` and
  `corporate-node` unless separately approved.

## 2. Confirmed blockers and stop conditions

### B1 — `student-node` PROD checkout is dirty

The configured PROD checkout is on `release-v1.37`, but contains an uncommitted change:

```text
M prisma/generated-assessment/schema.prisma
383 insertions, 340 deletions
```

This is a hard preflight failure. The file must be attributed and intentionally
committed, preserved, or reverted by an authorized owner before branch creation or
deployment. The deployment agent must not repair it automatically.

### B2 — `search-service` has no `release-v1.37` PROD baseline

The service is currently on `release-v1.36-hotfix-3` at `30a800c`. Under the configured
branch-naming rules, its natural next hotfix would be `release-v1.36-hotfix-4`, not
`release-v1.37-hotfix-1`.

Before creating a uniform `release-v1.37-hotfix-1` branch, an owner must decide whether
to:

1. establish an approved `release-v1.37` baseline for `search-service`, then cut
   `release-v1.37-hotfix-1`; or
2. retain its existing lineage and deploy a differently named service-specific branch.

Do not silently create `release-v1.37-hotfix-1` from `release-v1.36-hotfix-3`, because
the name would misrepresent its ancestry.

### B3 — Search database prerequisites are unresolved

The saved PROD state records pending search-service migrations blocked by missing
`institute.*_view` objects and authorization portability. Commit `e64ab69` refreshes
course and events materialized views, so the exact PROD view names, existence,
ownership and refresh permissions must be verified before deployment. A missing or
unauthorized materialized view could turn course writes into runtime failures.

### B4 — `form-data-normalization` is absent from `repos.json`

The service is part of the approved changelog and prior deployment state, but has no
canonical path, deploy name, namespace, deployment list, or env mapping in
`repos.json`. The production workflow prohibits guessing these values.

Before branch or deployment work, add/confirm its canonical configuration. Preserve
the known PROD-only `BASE_URL` behavior and deploy its API, worker and cron workloads
from one identical image, as required by the prior release history.

### B5 — PROD-only commits must survive promotion

- `institute-react-v2`: preserve `063a9f7`, which provides the production Dockerfile,
  `.dockerignore`, and standalone Next.js output.
- `admin-node`: preserve `c8fbe1f`, which restores the Dockerfile's
  `.env.${ENVIRONMENT}` copy behavior required by the production build process.
- `form-data-normalization`: preserve its production `BASE_URL` correction.

### B6 — DB and environment discovery is not complete

Pending SQL scripts and dated environment changes still need the formal read-only
Phase 2 scan. No SQL or env/configmap application may be inferred from this code-only
changelog.

### B7 — Slack deploy credential must be available in memory

The last release deployed with Slack disabled. Before the final deploy gate, confirm
that `INFRAHUB_SLACK_TOKEN` is available for in-memory use so start, periodic and final
status messages reach `#infrahub`. Never write the token to a tracked file.

## 3. Deployment procedure

### Gate 1 — Resolve readiness blockers

1. Obtain an owner decision for the dirty `student-node` schema file.
2. Obtain an owner decision for `search-service` branch ancestry.
3. Verify search materialized-view prerequisites using sanctioned read-only PROD DB
   access.
4. Add or confirm the canonical `form-data-normalization` deployment configuration.
5. Complete the pending DB-script and environment discovery report.

Stop if any result is unclear.

### Gate 2 — Create branches

After the user explicitly says **“yes, create these branches”**:

1. For each clean service based on `release-v1.37`, create
   `release-v1.37-hotfix-1` from the current PROD branch and push it.
2. Handle `search-service` only according to the separately approved ancestry
   decision.
3. Abort on a dirty tree, missing base/target branch, existing divergent branch, or
   rejected push.

### Gate 3 — Assemble the hotfix code

On the new branches:

1. Integrate full `origin/UAT` into `institute-react-v2` and `institute-node`, resolving
   conflicts explicitly and preserving the PROD-only commits listed above.
2. Cherry-pick only the manifest commits for the remaining services, in the order
   shown in the changelog.
3. Run service-appropriate build/test checks.
4. Produce a final branch-to-branch diff proving that no unrelated UAT commits entered
   the six cherry-pick-only repositories.
5. Stop and request review for any conflict, failing test, or unexpected diff.

Branch assembly is a separate code mutation and requires explicit approval; it should
not be assumed from branch-creation approval.

### Gate 4 — Apply approved DB scripts

Only if the Phase 2 scan finds pending scripts:

1. Show the ordered file list, summaries and destructive-operation flags.
2. Ask **“run these on PROD DB?”**
3. Reconfirm any destructive file individually.
4. Apply through the sanctioned PROD DB write path and verify each result.
5. After success, update its DB-Scripts header to `PROD — applied 2026-08-14` and push
   that metadata update.

### Gate 5 — Apply approved environment/configmap changes

Only if the Phase 2 scan finds pending values:

1. Show service, exact keys, redacted secret values, and exact destination files.
2. Ask **“apply env for these services?”**
3. Update frontend central env files; rebuild is required for baked variables.
4. For APIs, update both the central env file and Kubernetes configmap, apply the
   configmap, and roll the deployment.
5. Treat special services individually; do not guess their env mechanism.

### Gate 6 — Deploy

After branches, code, DB and env checks are complete, show the final service list and
require the explicit command:

```text
deploy release-v1.37-hotfix-1
```

Then:

1. Preflight every configured checkout: target remote branch exists, working tree is
   clean except explicitly expected generated env files, and
   `~/autodeploy_noprune.sh` exists.
2. Pass the Slack token in memory and run `prod_deploy_notify.sh` for configured
   services in parallel. It performs one Docker prune before parallel builds.
3. Deploy `form-data-normalization` only through its verified one-image procedure,
   updating API, worker and cron together to the same image tag.
4. Stop the run on any preflight/build/deploy failure; do not improvise a repair.
5. Reapply any required restart policies.

### Gate 7 — Post-deployment verification

1. Confirm each Kubernetes deployment is using the expected branch/image tag.
2. Confirm ready replicas, pod health, restart counts and absence of crash loops.
3. Verify `form-data-normalization` API/worker/cron all use the identical image.
4. Smoke-test TPO dashboard, diagnosis/schedules/reports, profile saves, campus filters,
   analytics export, and search course/event refresh behavior.
5. Confirm Slack start/final status delivery to `#infrahub`.
6. Update `state.json` only after the deployed state is verified.

## 4. Current readiness verdict

**BLOCKED — do not create branches or deploy yet.**

The immediate blockers are the dirty `student-node` checkout, unresolved
`search-service` ancestry and DB prerequisites, missing canonical
`form-data-normalization` configuration, and incomplete DB/env discovery.
