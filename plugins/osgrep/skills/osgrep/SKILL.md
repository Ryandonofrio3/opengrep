---
name: osgrep
description: Semantic code search. Finds code by concept, compresses files to skeletons. Use instead of grep/ripgrep/reading whole files.
allowed-tools: "Bash(osgrep:*), Read"
---

## When to Use osgrep

**USE osgrep for:**
- "Explain the architecture" 
- "How does X work?"
- "Find where Y happens"
- "What are the main components?"

**DON'T use for:**
- You already know the exact file and line
- Simple string search in one file

## Commands

```bash
osgrep "how requests flow from client to server"   # Semantic search
osgrep skeleton src/server.ts                      # Compress specific file  
osgrep trace handleRequest                         # Who calls / what calls
osgrep symbols                                     # List main symbols
```

## CRITICAL: Skeleton Shows WHERE, Read Shows HOW

Skeleton gives you the map. **You must still read the territory.**

```
skeleton output:
  handleRequest(req: Request): Response {
    // -> validateAuth, routeRequest, sendResponse | C:12 | ORCH
  }
```

This tells you handleRequest is important (ORCH, high complexity, calls 3 key functions).
**But you don't know HOW it works until you Read it.**

## Workflow: Architecture Questions

**Query:** "Explain client-server architecture, identify key files, show request flow"

```bash
# 1. Find entry points
osgrep "where do client requests enter the server"

# 2. Skeleton to see structure and find ORCH functions
osgrep skeleton src/server/handler.ts
# Look for: high complexity (C:8+), ORCH role, many calls

# 3. READ THE ORCHESTRATORS - this is where the logic lives
Read src/server/handler.ts:45-120   # <-- DON'T SKIP THIS

# 4. Trace dependencies if needed
osgrep trace handleRequest

# 5. Read the key callees to understand the full flow
Read src/auth/validator.ts:30-60
Read src/router/dispatch.ts:15-45
```

**The skeleton tells you WHAT exists and WHERE to look.**
**Reading tells you HOW it actually works.**

If you only skeleton and never read, you'll produce confident-sounding but shallow answers.

## Workflow: Find Specific Code

**Query:** "Where is JWT validation?"

```bash
osgrep "JWT token validation and expiration checking"
# -> src/auth/jwt.ts:45  validateToken  ORCH

Read src/auth/jwt.ts:45-80
```

## Output Guide

### Search Results
```
path                lines   score  role  defined
src/auth/jwt.ts     45-89   .94    ORCH  validateToken
```
- **ORCH** = orchestrates other code - **READ THESE for architecture questions**
- **DEF** = definition (class, type)

### Skeleton Output
```typescript
// src/auth/jwt.ts (skeleton, ~85 tokens)
export class JWTService {
  validateToken(token: string): Claims {
    // -> decode, verify, isExpired | C:8 | ORCH
  }
}
```
- Shows signatures, hides bodies
- **C:8 | ORCH = complex orchestrator = READ THIS FUNCTION**

## Query Tips

```bash
# Bad - too vague
osgrep "auth"

# Good - specific intent  
osgrep "where does the server validate JWT tokens before processing requests"
```

## If Index is Building

If you see "Indexing" or "Syncing": STOP. Tell the user the index is building.
