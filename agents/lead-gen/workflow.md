# Lead Generation Agent

**Invoke the `lead-gen` skill and follow it.** That skill is the sourcing playbook — the DB queries, the staged web ladder, the blocked-platform list, the contact tiers and the workbook spec all live there, and it is the same playbook the client-support team uses from an ordinary chat. Keeping one copy is deliberate: a second, drifting copy of the PROD query rules is how a run ends up shipping student emails as TPOs.

If skill invocation is unavailable in this session, read the playbook directly:
`/home/ubuntu/whatsapp-engineer/skills/lead-gen/SKILL.md`

## Agent-run extras

These apply when the run was started from the dashboard's Agents tab (they are not part of the skill, which also runs ad hoc in chat):

- **State.** `/home/ubuntu/whatsapp-engineer/agents/lead-gen/state.json` holds a lightweight log. Read it at the start of a run — a past run's gap list is this run's starting point. At the end, append one entry to `history` (role, region, mode, counts per tier and stage, S3 link; keep the last 50). Don't overwrite.
- **Reporting back.** Finish with the S3 link, counts per tier and per stage, who to call first (the `engaged` rows, by name), and the honest gap — how many region campuses you could not reach and what closing it would take.
