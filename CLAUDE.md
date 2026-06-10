# PluginLive Knowledge Base

Knowledge base is a **local git repo** at `/home/ubuntu/pluginlive-kb`.

## How to Access

**Search KB:**
```bash
grep -rl "<term>" /home/ubuntu/pluginlive-kb --include="*.md"
```

**Read a doc:**
```bash
cat /home/ubuntu/pluginlive-kb/<path>
```

**Update or create a doc:**
```bash
# Edit/create the file, then:
cd /home/ubuntu/pluginlive-kb && git add -A && git commit -m "<msg>" && git push origin main
```

## Structure

- `pluginlive.md` — company overview (SaaS hiring platform, Assessment + ATS products)
- `Assessment/` — assessment system (aptitude, communication, custom, role-based, scheduling)
- `ATS/` — Applicant Tracking System (Admin, Corporate, Institute, Student, ElasticSearch)
- `Infrastructure/` — servers, deployment, MCP servers, skills

Read only what's relevant to the current task. Do not read all docs upfront.
