# PluginLive Knowledge Base

Knowledge base is stored in **Outline wiki** (not local files).

## How to Access

**Search KB:**
```bash
curl -s -X POST https://app.getoutline.com/api/documents.search \
  -H "Authorization: Bearer $OUTLINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"<search term>","collectionId":"a53d4587-1881-4d8d-b254-601638589b71"}'
```

**Read a doc:**
```bash
curl -s -X POST https://app.getoutline.com/api/documents.info \
  -H "Authorization: Bearer $OUTLINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"<doc_id>"}'
```

**Update a doc:**
```bash
curl -s -X POST https://app.getoutline.com/api/documents.update \
  -H "Authorization: Bearer $OUTLINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"<doc_id>","text":"<new markdown content>"}'
```

**Create a new KB doc:**
```bash
curl -s -X POST https://app.getoutline.com/api/documents.create \
  -H "Authorization: Bearer $OUTLINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"<title>","text":"<content>","collectionId":"a53d4587-1881-4d8d-b254-601638589b71","publish":true}'
```

## Collections

- **Knowledge Base:** `a53d4587-1881-4d8d-b254-601638589b71` — Assessment, ATS, Infrastructure docs
- **PRDs:** `4600ac73-0c6f-4a3f-ae0d-4fade716d0d7` — Product Requirements Documents

## Structure

- `pluginlive.md` — company overview (SaaS hiring platform, Assessment + ATS products)
- `Assessment/` — assessment system (aptitude, communication, custom, role-based, scheduling)
- `ATS/` — Applicant Tracking System (Admin, Corporate, Institute, Student, ElasticSearch)
- `Infrastructure/` — servers, deployment, MCP servers, skills

Read only what's relevant to the current task. Do not read all docs upfront.
