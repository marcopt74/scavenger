# Scavenger — Repository Onboarding Agent

A working prototype of a **read-only Repository Onboarding Agent** with a clean, minimalist chat interface inspired by Gemini. Acting as a **Senior Software Architect** and **Senior Software Engineer**, Scavenger guides you progressively onto any local repository from the root outward—adapting to your experience level and rendering architecture/flow diagrams directly as inline visuals.

## Core Capabilities

- **Staged Discovery Starting at the Root (Stages 0 → 4):**
  - **Stage 0 (Diagnostic & Root Recon):** Automatically inspects the repository root (top-level tree, README, root manifests/configs, and recent git milestones) while asking 2–3 concise calibration questions.
  - **Stage 1 (Repo Purpose & Domain):** Explains what the repository does, who/what it serves, and core domain boundaries.
  - **Stage 2 (System Architecture):** Maps real modules, boundaries, and architectural style with inline visual diagrams.
  - **Stage 3 (Core Flows & Implementation):** Traces real execution flows and entry-point files/symbols at your calibrated depth.
  - **Stage 4 (Git Evolution, Conventions & Next Steps):** Surfaces historical milestones/churn, local conventions, and concrete files to inspect next.
- **Adaptive Explanation Depth:** Automatically calibrates to `foundational`, `intermediate`, or `advanced` and lets you re-calibrate smoothly mid-conversation (in chat or via the top-bar Depth selector).
- **Strict Backend-Enforced Read-Only Guardrails:**
  - Filesystem tools (`list_tree`, `read_file`, `grep_search`) pass through canonical `realpath` confinement (`src/server/guardrails/pathGuard.ts`), blocking `../` traversal, external absolute paths, symlink escapes outside the repository, null bytes, and `.git/` internal file reads.
  - Git inspection (`git_inspect`) passes through `src/server/guardrails/gitGuard.ts`, invoking `execFile('git', ...)` with `shell: false`, strict read-only subcommand allowlists (`log`, `show`, `diff`, `blame`, `shortlog`, `status`, `rev-parse`, `branch --list`, `tag --list`, `ls-files`), dangerous flag blocking, and `GIT_OPTIONAL_LOCKS=0` so even `git status` never writes lockfiles.
- **Visual-First Explanations:**
  - Mermaid diagrams render inline as interactive SVGs (with zoom lightbox and SVG download) rather than raw code blocks.
  - Optional D2 rendering automatically compiles via local `d2` CLI (`d2 - -`, zero disk writes) when installed, with graceful fallback otherwise.
  - Optional concept/metaphor visuals use Gemini Imagen or OpenAI Images when configured, automatically falling back to clean vector concept cards.
- **Provider-Agnostic LLM Layer:** Built on the Vercel AI SDK (`google` Gemini, `openai`, `anthropic`, `openai-compatible` for Ollama/LM Studio/OpenRouter) plus a built-in zero-key **`demo` mode** grounded in real read-only inspection of your target repository.

---

## Quickstart

### 1. Install dependencies
```bash
pnpm install
```

### 2. Configure an LLM provider (optional — Demo Mode works out of the box)
Copy `.env.example` to `.env` and add your preferred provider key:

```bash
cp .env.example .env
```

Supported providers in `.env`:
- **Google Gemini:** `LLM_PROVIDER=google` + `GOOGLE_GENERATIVE_AI_API_KEY=...` (or `GEMINI_API_KEY`)
- **OpenAI:** `LLM_PROVIDER=openai` + `OPENAI_API_KEY=...`
- **Anthropic Claude:** `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY=...`
- **Ollama / OpenAI-compatible:** `LLM_PROVIDER=openai-compatible` + `OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1` + `LLM_MODEL=llama3.2`
- **Demo Mode (zero API key):** Leave keys unset or set `LLM_PROVIDER=demo`

### 3. Run in development
```bash
pnpm dev
```

- Frontend (Vite + React): `http://localhost:5173`
- Backend API (Hono): `http://localhost:3001`

### 4. Build & run production bundle
```bash
pnpm build
pnpm start
```

---

## Architecture

```text
src/
├── shared/
│   └── types.ts                 # Shared domain types, stages, visuals, SSE events
├── server/
│   ├── index.ts                 # Hono server entrypoint & health/static routes
│   ├── config.ts                # Provider-agnostic Vercel AI SDK model factory
│   ├── guardrails/
│   │   ├── pathGuard.ts         # Canonical realpath repo confinement & symlink-escape defense
│   │   └── gitGuard.ts          # Lock-free, shell-free read-only git allowlist
│   ├── tools/
│   │   ├── fsTools.ts           # Read-only list_tree, read_file, grep_search
│   │   ├── gitTools.ts          # Read-only git_inspect wrapper
│   │   ├── rootRecon.ts         # Deterministic Stage 0 root reconnaissance
│   │   ├── visualTools.ts       # D2 CLI SVG renderer & concept visual gen + SVG fallback
│   │   └── agentTools.ts        # Vercel AI SDK tool assembly bound to session state
│   ├── session/
│   │   ├── sessionStore.ts      # Session store & Stage 0 opening composer
│   │   └── stageMachine.ts      # Stage 0–4 transition rules & level calibration heuristics
│   ├── agent/
│   │   ├── systemPrompt.ts      # Senior Architect & Engineer persona + stage/level rubrics
│   │   ├── orchestrator.ts      # Multi-step streaming agent loop (SSE)
│   │   └── demoAgent.ts         # Grounded zero-key local demo responder
│   └── routes/
│       ├── sessions.ts          # POST/GET/PATCH /api/sessions
│       ├── chat.ts              # POST /api/sessions/:id/chat (SSE)
│       └── visuals.ts           # POST /api/render/d2
└── client/
    ├── App.tsx                  # Minimalist chat shell & SSE consumer
    ├── api/client.ts            # Typed REST & SSE client
    ├── styles/index.css         # Gemini-inspired minimalist design system
    └── components/
        ├── RepoWelcome.tsx      # Distraction-free repo path landing screen
        ├── StageProgressBar.tsx # Top bar with Stage 0–4 rail & Depth recalibration popover
        ├── ChatMessageList.tsx  # Centered prose stream with inline visuals
        ├── MarkdownRenderer.tsx # Intercepts mermaid/d2 fences into visual DiagramCards
        ├── DiagramCard.tsx      # Client Mermaid SVG & D2 renderer with lightbox + fallback
        ├── ConceptVisualCard.tsx# Raster or fallback vector concept illustration card
        ├── ToolActivityPill.tsx # Collapsible grounded read-only inspection summary
        ├── Composer.tsx         # Floating pill composer with contextual stage/depth nudges
        └── SettingsModal.tsx    # Provider switcher & active read-only guardrail summary
```

---

## Verification & Testing

Run the automated test suite and type/build checks:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Test suites under `tests/` cover:
- `tests/pathGuard.test.ts` — blocks `../` traversal, external absolute paths, null bytes, `.git/` direct reads, and symlink escapes outside the target repo.
- `tests/gitGuard.test.ts` — validates read-only git allowlist and rejects mutating subcommands (`checkout`, `reset`, `commit`, `clean`, `merge`, `rebase`, `stash`, `push`, etc.) and dangerous flags.
- `tests/fsAndGitTools.test.ts` — end-to-end inspection of a fixture git repository proving zero mutations (`git status --porcelain` clean, `HEAD` unchanged, no `.git/index.lock`).
- `tests/rootRecon.test.ts` — Stage 0 root recon on git and non-git directories.
- `tests/stageMachine.test.ts` — Stage 0→4 progression, diagnostic level inference, smooth recalibration, and end-to-end grounded demo flow.
- `tests/visualFallback.test.ts` — D2 unavailable fallback and concept visual vector fallback.
