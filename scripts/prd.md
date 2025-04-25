# Project Brain – Product Requirements Document (PRD)

*Version: 0.2 · Last updated: <!--CURSOR_DATE-->*

---

## 1. Project Overview
Project Brain is a multi-tenant web platform for architects that offers a **single source of truth** for each building project.  It combines a project-scoped **Knowledge-Graph RAG** (graph database + vector store) with role-based portals so that Directors, Team members, Clients, and Builders always see the right information and never duplicate data entry.

**One-sentence value prop**:  *"Enter data once, and every stakeholder sees the up-to-date truth for the lifetime of the project."*

**Primary goals**
1. Eliminate double-handling of project data.  
2. Enforce fine-grained permissions per project.  
3. Provide AI-assisted search / Q&A over all project artefacts.  
4. Offer an admin toolkit so Directors can self-manage templates, fees, users, and visibility.

---

## 2. Tech-Stack Snapshot
| Layer | Chosen Technology | Rationale |
|-------|-------------------|-----------|
| Front-end | **Next.js 14**, React, TypeScript, Tailwind CSS | File-system routing, React Server Components, strong TS DX |
| State / Data Fetch | **TanStack Query**, **Zustand**, **supabase-js** | Cached queries + local state with optimistic updates |
| API Layer | **tRPC** with **Supabase** for data access | Type safety with simplified DB access |
| Auth | **Supabase Auth** (email+pwd, Google OAuth, magic link) | Out-of-box multi-tenant + JWT claims |
| RBAC / Policy | **Supabase RLS** + optional **Casbin** (client-side) | Database-enforced permissions with UI policy mirror |
| Graph DB | **Neo4j AuraDB** | Purpose-built graph database with efficient traversals |
| Vector Store | **Pinecone** | Hybrid semantic search w/ OpenAI embeddings |
| File Storage | **Supabase Storage** | Built-in CDN, versioning, and webhooks |
| Realtime | **Supabase Realtime** | Low-latency WebSocket connections |
| AI / RAG | **LangChain TS** + OpenAI gpt-4o | Chunk, embed, and query docs |
| CI/CD | GitHub Actions, Turborepo | Monorepo; lint, test, build |
| Testing | Vitest (unit) · Playwright (e2e) | Fast TS tests + browser flows |

---

## 3. Core Functionalities & User Flows
### 3.1 Project Lifecycle
1. **Create Project from Template** (Director)  
   • Enter address, client, scope → system instantiates phases, tasks, checklists, fees.  
2. **Data Propagation** – Core fields auto-populate fee proposal, client brief, variation tracker, builder scope, QA tools.  
3. **Realtime Updates** – Any file upload / task edit emits an event; UI & graph refresh in <1 s.

### 3.2 Role Portals (What each user sees)
| Role | Key Screens | Editable? |
|------|-------------|-----------|
| Director | Global dashboard, any project, admin tools | Full CRUD |
| Team | Assigned projects, QA checklist | Tick/complete only |
| Client | My project(s), briefs, fee proposals, uploads | Brief, approve fees, upload |
| Builder | Assigned projects, tasks, plan downloads, variation form | Submit variations |

### 3.3 Admin Toolkit (Director-only)
• Reassign users   • Clone / edit templates   • Custom tasks   • Fee changes w/ re-approval   • Archive/reopen projects   • Visibility toggles   • File replace & pin   • Manual milestone logs

### 3.4 AI Search / Q&A
Prompt → vector store → context → gpt-4o → answer + citations.

---

## 4. Detailed Requirements (MVP)
1. **Authentication & RBAC**  
   • Supabase Auth issues JWT with `role`, `projectId`, `userId`.  
   • Supabase RLS policies enforce basic permissions; Casbin reinforces for complex cases.  
2. **Project Template Engine**  
   • CRUD `templates` table in Supabase Postgres.  
3. **Graph Upsert Service**  
   • Each CRUD event produces a `GraphEvent` that triggers Neo4j updates via a worker.
   • A `sync_service` ensures consistency between Supabase and Neo4j.  
4. **File Upload Pipeline**  
   • Front-end → Supabase Storage upload → webhook → Lambda processes file → extracts text → LangChain chunk/embed → Pinecone + Neo4j upsert.  
5. **Realtime Layer**  
   • Supabase Realtime channels broadcast changes to connected clients.  
6. **AI Endpoint**  
   • Edge Function queries both Neo4j (graph context) and Pinecone (vector similarity) → OpenAI chat w/ citations.

---

## 5. Libraries, Docs & Code Examples
### 5.1 tRPC Router with Supabase (Tasks)
```ts
// server/routers/task.ts
import { z } from 'zod';
import { publicProcedure, router } from '../trpc';
import { createClient } from '@supabase/supabase-js';

// Initialize inside context provider
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

export const taskRouter = router({
  list: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .eq('project_id', input.projectId);
      
      if (error) throw new Error(error.message);
      return data;
    }),

  toggleComplete: publicProcedure
    .input(z.object({ taskId: z.string(), done: z.boolean() }))
    .mutation(async ({ input }) => {
      const { data, error } = await supabase
        .from('tasks')
        .update({ done: input.done })
        .eq('id', input.taskId)
        .select()
        .single();
      
      if (error) throw new Error(error.message);
      
      // Sync to Neo4j graph via worker
      await fetch('/api/jobs/sync-graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          entity: 'task', 
          operation: 'update',
          data
        })
      });
      
      return data;
    }),
});
```
*Docs*: https://supabase.com/docs/reference/javascript/introduction and https://trpc.io/docs

### 5.2 Supabase Storage Upload
```ts
// app/api/upload/route.ts
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!, 
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  const { fileName, fileType, projectId } = await req.json();
  
  // Get presigned URL for upload
  const { data, error } = await supabase.storage
    .from('project-files')
    .createSignedUploadUrl(`${projectId}/${Date.now()}_${fileName}`, {
      expiresIn: 600,
      contentType: fileType,
    });
  
  if (error) return Response.json({ error }, { status: 500 });
  return Response.json({ url: data.signedUrl, key: data.path });
}
```
*Docs*: https://supabase.com/docs/guides/storage

### 5.3 Neo4j Graph Operations
```ts
// lib/neo4j.ts
import neo4j from 'neo4j-driver';

const driver = neo4j.driver(
  process.env.NEO4J_URI!,
  neo4j.auth.basic(process.env.NEO4J_USER!, process.env.NEO4J_PASSWORD!)
);

export async function createProjectNode(projectData) {
  const session = driver.session();
  try {
    const result = await session.run(`
      CREATE (p:Project {
        id: $id,
        name: $name,
        address: $address,
        clientId: $clientId,
        createdAt: datetime()
      })
      RETURN p
    `, projectData);
    
    return result.records[0].get('p').properties;
  } finally {
    await session.close();
  }
}

export async function linkTaskToProject(taskId, projectId) {
  const session = driver.session();
  try {
    await session.run(`
      MATCH (p:Project {id: $projectId})
      MERGE (t:Task {id: $taskId})
      MERGE (t)-[:BELONGS_TO]->(p)
    `, { taskId, projectId });
  } finally {
    await session.close();
  }
}
```
*Docs*: https://neo4j.com/docs/javascript-manual/current/

---

## 6. Environment Variables
| Key | Example | Purpose |
|-----|---------|---------|
| `SUPABASE_URL` | `https://abcxyz.supabase.co` | Project API endpoint |
| `SUPABASE_ANON_KEY` | `eyJhbGciOi...` | Public client key |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGciOi...` | Server-only admin key |
| `NEO4J_URI` | `neo4j+s://xyz.databases.neo4j.io` | Graph DB connection |
| `NEO4J_USER` / `NEO4J_PASSWORD` | — | Neo4j credentials |
| `PINECONE_API_KEY` | `pc-abcd…` | Vector store |
| `OPENAI_API_KEY` | `sk-…` | Chat & embeddings |

> Store in `.env.local` or Supabase project secrets; never commit.

---

## 7. Proposed File Structure (Monorepo)
```
project-brain/
├─ apps/
│  └─ web/                  # Next.js 14 frontend
│     ├─ app/               # RSC routes
│     ├─ components/
│     └─ ...
├─ packages/
│  ├─ api/                  # tRPC routers
│  └─ db/                   # Database clients & helpers
│     ├─ supabase.ts        # Supabase client
│     └─ neo4j.ts           # Neo4j driver & helpers
├─ workers/
│  └─ graph-sync/           # Sync service between Supabase/Neo4j
├─ supabase/
│  ├─ functions/            # Edge Functions
│  ├─ migrations/           # SQL migrations
│  └─ webhooks/             # Storage event handlers
├─ .github/workflows/
├─ .env.example
└─ turbo.json
```
*(Run `tree -L 2` in repo root to update as directories evolve.)*

---

## 8. Data Flow Architecture
```
┌───────────┐    ┌───────────┐    ┌────────────┐
│  Supabase │    │  Workers  │    │   Neo4j    │
│  Postgres │───►│ Graph Sync│───►│            │
└───────────┘    └───────────┘    └────────────┘
       ▲                                ▲
       │                                │
       │         ┌───────────┐          │
       └─────────┤   tRPC    ├──────────┘
                 │   Server  │
                 └───────────┘
                       ▲
                       │
       ┌───────────────┴───────────────┐
       │        Next.js Frontend       │
       └───────────────────────────────┘
```

---

## 9. Milestones & Acceptance Criteria
| Sprint | Deliverable | Acceptance Criteria |
|--------|-------------|---------------------|
| 0 | Repo + CI + lint | All PRs run lint & tests in GH Actions |
| 1 | Auth (Supabase) + RBAC spike | Login works; RLS blocks unauthorized access |
| 2 | Project template CRUD | Director can create template & instantiate project |
| 3 | Neo4j + Supabase sync layer | Data flows bidirectionally with consistency |
| 4 | File upload pipeline with Supabase | File appears in Storage; text extracted & searchable |
| 5 | AI Q&A endpoint | Ask "Who is the client?" → returns correct name w/ citation |
| 6 | MVP portals | Each role sees allowed data only |

---

## 10. Glossary
• **Graph RAG** – Retrieval-Augmented Generation backed by a graph DB + vector store.  
• **Template** – JSON blob defining phases, tasks, checklists, fees.  
• **Phase** – Top-level stage (Establishment, Concept Design, …).  
• **Variation** – Builder/Client change request impacting fees or scope.  
• **RLS** – Row-Level Security, Supabase's mechanism for enforcing data access policies.

---

## 11. Next Steps for Developers
1. **Create Supabase project** and configure authentication providers.  
2. **Configure Neo4j AuraDB** instance and set up connection.  
3. **Define Supabase schema** with appropriate RLS policies.  
4. **Create graph model** in Neo4j for project data.  
5. **Implement sync worker** between Supabase and Neo4j.
6. **Set up `.env.local`** with required keys.

*End of PRD* 