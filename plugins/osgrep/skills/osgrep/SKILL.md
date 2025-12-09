---
name: osgrep
description: Semantic code search. Use alongside grep - grep for exact strings, osgrep for concepts.
allowed-tools: "Bash(osgrep:*), Read"
---

## What osgrep does

Finds code by meaning. When you'd ask a colleague "where do we handle auth?", use osgrep.

- grep/ripgrep: exact string match, fast
- osgrep: concept match, finds code you couldn't grep for

## Primary command
```bash
osgrep "where do we validate user permissions"
```

Returns ~10 results with code snippets (15+ lines each). Usually enough to understand what's happening.

## Output explained
```
ORCHESTRATION src/auth/handler.ts:45
Defines: handleAuth | Calls: validate, checkRole, respond | Score: .94

export async function handleAuth(req: Request) {
  const token = req.headers.get("Authorization");
  const claims = await validateToken(token);
  if (!claims) return unauthorized();
  const allowed = await checkRole(claims.role, req.path);
  ...
```

- **ORCHESTRATION** = contains logic, coordinates other code
- **DEFINITION** = types, interfaces, classes
- **Score** = relevance (1 = best match)
- **Calls** = what this code calls (helps you trace flow)

## When to Read more

The snippet often has enough context. But if you need more:
```bash
# osgrep found src/auth/handler.ts:45-90 as ORCH
Read src/auth/handler.ts:45-120
```

Read the specific line range, not the whole file.

## Other commands
```bash
# Trace call graph (who calls X, what X calls)
osgrep trace handleAuth

# Skeleton of a huge file (to find which ranges to read)
osgrep skeleton src/giant-2000-line-file.ts

# Just file paths when you only need locations
osgrep "authentication" --compact
```

## Workflow: architecture questions
```bash
# 1. Find entry points
osgrep "where do requests enter the server"
# Review the ORCH results - code is shown

# 2. If you need deeper context on a specific function
Read src/server/handler.ts:45-120

# 3. Trace to understand call flow
osgrep trace handleRequest
```

## Tips

- More words = better results. "auth" is vague. "where does the server validate JWT tokens" is specific.
- ORCH results contain the logic - prioritize these
- Don't read entire files. Use the line ranges osgrep gives you.
- If results seem off, rephrase your query like you'd ask a teammate

## If Index is Building

If you see "Indexing" or "Syncing": STOP. Tell the user the index is building. Ask if they want to wait or proceed with partial results.
