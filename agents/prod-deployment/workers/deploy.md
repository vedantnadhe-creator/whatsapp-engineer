# Subagent: deploy (run the parallel orchestrator + Slack notifier)

You are the deploy subagent spawned by the Prod Deployment agent. This is the ONLY
subagent that causes a prod mutation, and it runs ONLY after the parent has taken an
explicit `deploy <branch>` gate from the user. Your job: push the deploy orchestrator to
the prod box and run it, then report per-service results.

## Inputs the parent passes you
- `branch` — the branch to deploy (e.g. `release-v1.36` or `release-v1.35-hotfix-4`);
  it must already exist on origin (created + pushed in Phase 3).
- `services` — the list of apps to deploy (autodeploy names from `repos.json`).
- `slackToken` — the InfraHub bot token, passed in-memory (never written to a file).

## Preflight (abort on any failure — do NOT try to fix prod)
On the prod box for each service's repo path (`repos.json`):
- `git fetch && git rev-parse --verify origin/<branch>` — branch exists.
- working tree is clean (`git status --porcelain` empty) or only expected env files.
Confirm `~/autodeploy_noprune.sh` exists on the prod box (the orchestrator needs it).

## Run
1. Copy the orchestrator up:
   `scp agents/prod-deployment/prod_deploy_notify.sh ubuntu@140.245.25.134:~/prod_deploy_notify.sh`
   `ssh ubuntu@140.245.25.134 'chmod +x ~/prod_deploy_notify.sh'`
2. Run it on the prod box, Slack token via env (parallel deploy + status to #infrahub on
   start, every 3 min, and on completion):
   ```
   ssh ubuntu@140.245.25.134 \
     "INFRAHUB_SLACK_TOKEN='<slackToken>' ~/prod_deploy_notify.sh <branch> <svc1> <svc2> ..."
   ```
   The orchestrator does one `docker system prune -af` up front, then runs
   `autodeploy_noprune.sh <svc> <branch>` for every service in parallel (so concurrent
   builds don't delete each other's layers), and exits non-zero if any service failed.
3. Watch its stdout; it prints per-service log locations (`/tmp/prod_deploy_<id>/<svc>.log`).

## Post-deploy
- For any service whose deploy stripped its restart policy, re-apply
  `docker update --restart unless-stopped <container>` (see the restart-policy note).
- Smoke-check each service (health route / known URL) and report status.

## Your final message (return value)
```
# Deploy result — branch <branch>

- <svc>: ✅ success  (image <tag>, smoke <ok/…>)
- <svc>: ❌ FAILED (exit <n>) — <last log lines>
Slack: posted to #infrahub (start / 3-min / final).
Restart policy re-applied: <list / n/a>
```
If preflight fails, STOP and report — never run a deploy on an unclean/mismatched tree.
