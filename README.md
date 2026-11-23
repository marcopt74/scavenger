# Scavenger

> **Understand any local codebase from the root up — through interactive whiteboard lessons, live diagrams, and strictly read-only exploration.**

Scavenger is a local **Repository Onboarding Agent** with a clean, Gemini-inspired chat interface. Instead of dumping raw file listings or flat API summaries, Scavenger acts like a **Senior Software Architect & Whiteboard Mentor** sitting next to you: it inspects your repository strictly read-only, adapts explanations to your experience level, draws architectural and runtime diagrams inline, and tracks your evolving mastery as you explore.

---

## Highlights

- **Pre-Onboarding Repo Scanner Agent & Persistent Knowledge Base:** Before onboarding starts, Scavenger scans the repository (indexing files, exported symbols with line numbers, cross-file imports/dependencies, entry points, and module boundaries) and synthesizes a **Repository Knowledge Map**. The onboarding agent answers architectural, module, and flow questions immediately from the Knowledge Map and dives into raw code lines on demand.
- **Auto-Refresh on `git pull` & On-Demand Refresh:** Scavenger tracks the repository's `HEAD` commit SHA, automatically detects when a `git pull` updates the local repo, incrementally re-indexes only the diffed files (`git diff --name-status`), and provides a 1-click **Refresh KB** button in the top bar.
- **Zero-Commit Knowledge Storage (`~/.scavenger/knowledge/`):** Knowledge maps are cached outside the target repo with `0600` permissions and an automatic inner `.gitignore` (`*`), plus explicit `.gitignore` and `pathGuard` exclusions so knowledge folders are **never** committed or pushed.
- **Whiteboard Mentor Pedagogy:** Teaches in flowing, grounded narratives — mental models first, then interdependencies, behavior over time, subtle pitfalls, and memorable takeaways — never dry file-inventory bullet soup.
- **Non-Linear, Mastery-Driven Learning:** Explore the 5 core repository pillars (**Recon**, **Purpose**, **Architecture**, **Flows**, **Evolution**) in any order, or ask to learn *any* module, file, or behavior directly. An interactive **Knowledge Map**, optional **Quick Check** questions (≤ 3), and clickable **Suggested Next Steps** adapt as your understanding grows.
- **Visual-First Diagrams & Concept Art:**
  - Crisp **Mermaid** SVG diagrams rendered on an architectural dot-grid canvas with semantic color-coded roles, a 1-click **Clean / Sketch** whiteboard style toggle, **Copy Source**, **SVG** and **2× Retina PNG** export, and an interactive **Zoom & Pan Lightbox**.
  - Optional local **D2** CLI rendering (`d2 --theme=1 --pad=28 - -`, zero disk writes) with automatic fallback.
  - **Concept Illustrations:** Generates text-free editorial metaphor art via Gemini Imagen or OpenAI Images paired with structured component legends — or renders instant multi-layout vector concept maps (`pipeline`, `hub`, `layers`) offline.
- **Built-In Local File Explorer:** Click **Browse** on the welcome screen to pick any repository on disk visually with Git repository badges, clickable breadcrumbs, OS shortcuts (`Home`, `Workspace`, `Desktop`, `Documents`, `Root`), instant folder filtering, and keyboard navigation.
- **In-App Settings Menu (No `.env` Required):** Configure API keys, switch between **GitHub Copilot** (auto-detects local Copilot IDE/CLI auth or signs in via in-app GitHub Device Flow and discovers live models enabled on your subscription), **Google Gemini**, **OpenAI**, **Anthropic Claude**, **OpenAI-Compatible** (Ollama, LM Studio, OpenRouter), or zero-key **Demo Mode**, pick curated model presets or custom model IDs, and **Test Connection** live — persisted locally with `0600` permissions and zero restarts.
- **Strict Backend-Enforced Read-Only Guardrails:** Every filesystem and git inspection tool is strictly confined and lock-free — Scavenger never modifies files, creates git locks, or mutates your repository.

---

## Quickstart

### Prerequisites

- **Node.js** `>= 20`
- **pnpm** (`npm install -g pnpm` or via `corepack enable`)
- *(Optional)* **[D2 CLI](https://d2lang.com/)** (`brew install d2`) if you want local D2 diagram rendering alongside Mermaid

### 1. Clone and install

```bash
git clone https://github.com/marcopt74/scavenger.git
cd scavenger
pnpm install
```

### 2. Start Scavenger

```bash
pnpm dev
```

Open **[http://localhost:5173](http://localhost:5173)** in your browser (the Hono backend API runs on `http://localhost:3001`).

> **Zero-key Demo Mode works out of the box.** You can onboard any local repository immediately without configuring an API key — Demo Mode runs real read-only filesystem and git inspection against your codebase and renders grounded lessons and diagrams.

### Production Build

```bash
pnpm build
pnpm start
```

The production server serves both the API and the compiled frontend bundle from `http://localhost:3001` (or `PORT` if set).

---

## Configuring LLM Providers & API Keys

### Option 1: In-App Settings Menu *(Recommended)*

No need to edit `.env` files or restart the server:

1. Click the **Provider** chip on the welcome screen (or the **⚙ Settings** icon in the top bar at any time).
2. Under **Models & Provider**, choose your provider:
   - **GitHub Copilot** — automatically detects existing local Copilot authentication (`~/.config/github-copilot/{hosts,apps}.json`, `~/.copilot/config.json`, or `gh auth token`), supports 1-click **Sign in with GitHub Copilot** Device Flow, and dynamically loads all chat models enabled on your Copilot subscription (`gpt-4.1`, `gpt-4o`, `claude-sonnet-4`, `gemini-2.5-pro`, `o3-mini`, etc.)
   - **Google Gemini** (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.0-flash`, or custom model ID)
   - **OpenAI** (`gpt-4o`, `gpt-4.1`, `gpt-4.1-mini`, `o3-mini`, or custom model ID)
   - **Anthropic Claude** (`claude-sonnet-4-20250514`, `claude-3-7-sonnet-latest`, `claude-3-5-haiku-latest`, or custom model ID)
   - **OpenAI-Compatible** — includes 1-click endpoint presets for **Ollama** (`http://localhost:11434/v1`), **LM Studio** (`http://localhost:1234/v1`), and **OpenRouter** (`https://openrouter.ai/api/v1`)
   - **Local Demo Mode** (zero API key)
3. Add your API key inline or under the **API Keys** tab, then click **Test Connection** to verify credentials and latency before saving.
4. *(Optional)* Under **Visuals & Safety**, toggle **AI Concept Image Generation** or customize the Gemini / OpenAI image model IDs.
5. Click **Save Settings**.

**Where settings are stored:** Settings are written atomically to `~/.scavenger/config.json` (outside the git repository) with owner-only `0600` file permissions. Raw API keys are **never** sent back to the browser — the UI only displays masked previews (e.g. `AIza••••3x8Q`) and source badges (`Saved in Settings` vs `From .env`).

### Option 2: `.env` File *(Optional)*

You can also configure defaults via `.env` (UI Settings override `.env` at runtime, and removing a key in Settings falls back cleanly to `.env`):

```bash
cp .env.example .env
```

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Backend server port | `3001` |
| `LLM_PROVIDER` | `copilot` \| `google` \| `openai` \| `anthropic` \| `openai-compatible` \| `demo` | Auto-detected or `demo` |
| `LLM_MODEL` | Optional default model override | Provider default |
| `GITHUB_COPILOT_TOKEN` | GitHub Copilot OAuth token (optional if auto-detected locally or signed in via UI) | Auto-detected |
| `GITHUB_COPILOT_DOMAIN` | Optional organizational / Enterprise GitHub domain (e.g. `company.ghe.com` or `github.company.com`) | `github.com` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini API key (`GEMINI_API_KEY` also supported) | — |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | — |
| `OPENAI_COMPATIBLE_BASE_URL` | Base URL for Ollama / LM Studio / OpenRouter / vLLM | — |
| `OPENAI_COMPATIBLE_API_KEY` | Optional API key for OpenAI-compatible servers | — |
| `IMAGE_GEN_ENABLED` | Enable raster concept illustrations (`true` \| `false`) | `true` |
| `GEMINI_IMAGE_MODEL` | Gemini Imagen model ID | `imagen-3.0-generate-002` |
| `OPENAI_IMAGE_MODEL` | OpenAI Images model ID | `gpt-image-1` |
| `SCAVENGER_CONFIG_PATH` | Override path for local persistent settings file | `~/.scavenger/config.json` |

---

## Using Scavenger

### 1. Select a Local Repository
On the welcome screen, choose a repository in any of three ways:
- Click **Browse** inside the path bar to open the **File Explorer modal** — jump via **Places** shortcuts, spot Git repositories via `git` badges, filter folders instantly, double-click (or click `›`) to drill down, and click **Select Folder**.
- Click **Inspect current workspace** to immediately onboard the directory Scavenger was launched from.
- Type or paste any local path (including `~` expansion) and click **Start Onboarding**.

### 2. Root Recon & Quick Calibration
Scavenger immediately performs deterministic read-only root reconnaissance (top-level layout, README, root manifests/configs, and recent git commits) and opens with a grounded orientation plus quick depth calibration nudges:
- **Foundational:** Mental models, everyday analogies, plain definitions before abstractions.
- **Intermediate:** Balanced architecture, module contracts, runtime flows, and entry points.
- **Advanced:** Staff-level invariants, state/lifecycle trade-offs, coupling tensions, and git rationale.

You can recalibrate depth at any time using the **Depth** selector in the top bar or by simply asking in chat (*"Explain simpler"* / *"Go deeper"*).

### 3. Learn Non-Linearly
You are never locked into a rigid script:
- Click any **Core Pillar** (`Recon`, `Purpose`, `Architecture`, `Flows`, `Evolution`) in the top bar.
- Open the **Map** popover to view mastery progress across core pillars and custom topics you've asked about, and click any topic to revisit or deepen it.
- Reply to inline **Quick Check** questions to reinforce or advance mastery, click any **Suggested Next Step** card, or type any question directly (*"Teach me how `pathGuard.ts` works"*, *"Walk through the SSE chat flow over time"*).
- Click the **Tool Activity pill** above any response to inspect the exact read-only files and git commands Scavenger grounded its answer in.

### 4. Inspect & Export Visuals
Every diagram and concept visual renders directly inline as an interactive studio card:
- **Sketch / Clean toggle** (Mermaid): Switch between crisp architectural vector styling and hand-drawn whiteboard sketch mode.
- **Expand (Lightbox):** Inspect dense diagrams full-screen with zoom (`+`, `-`, `0`, `Ctrl/⌘ + scroll`), click-and-drag panning, and `Esc` to close.
- **Export:** Download crisp **SVG**, **2× Retina PNG**, or copy raw diagram source with one click.

---

## Read-Only Security Guardrails

Scavenger is designed so you can point it at important local repositories with confidence:

- **Filesystem confinement ([`pathGuard.ts`](src/server/guardrails/pathGuard.ts)):** Every agent tool (`list_tree`, `read_file`, `grep_search`) resolves canonical `fs.realpath` paths strictly inside the chosen repository root — blocking `../` traversal, external absolute paths, null bytes, symlink escapes outside the repo, and direct `.git/` internal file reads.
- **Lock-free, shell-free Git ([`gitGuard.ts`](src/server/guardrails/gitGuard.ts)):** Runs `execFile('git', ...)` with `shell: false`, enforces a strict read-only subcommand allowlist (`log`, `show`, `diff`, `blame`, `shortlog`, `status`, `rev-parse`, `branch --list`, `tag --list`, `ls-files`), blocks mutating flags, and injects `GIT_OPTIONAL_LOCKS=0` so even `git status` never writes `.git/index.lock`.
- **Read-only folder browser ([`dirBrowser.ts`](src/server/tools/dirBrowser.ts)):** Lists directory metadata only (never reads file contents), caps listings at 500 entries, and detects `.git` markers without spawning subprocesses.
- **Local-only secret storage ([`settingsStore.ts`](src/server/settingsStore.ts)):** API keys stay on your machine in `~/.scavenger/config.json` (`0600`) and are never echoed back in API responses.

---

## Architecture

```mermaid
flowchart LR
  subgraph Client["React + Vite Client (src/client)"]
    UI["RepoWelcome · Chat UI\nKnowledge Map · Composer"]
    Modals["FileExplorerModal\nSettingsModal · VisualLightbox"]
    Mermaid["Mermaid Studio Theme\n(Clean/Sketch · SVG/PNG Export)"]
  end

  subgraph Server["Hono Node Server (src/server)"]
    Routes["REST & SSE Routes\n/sessions · /chat · /fs · /settings · /render"]
    Orch["Orchestrator & Pedagogy\n(Vercel AI SDK + Demo Agent)"]
    Store["settingsStore (~/.scavenger/config.json)\nsessionStore · learningEngine"]
    Guards["Read-Only Guardrails\npathGuard · gitGuard · dirBrowser"]
    Tools["Read-Only Inspection & Visuals\nfsTools · gitTools · rootRecon · visualTools"]
  end

  UI <-->|"REST + SSE Stream"| Routes
  Modals <-->|"REST"| Routes
  Routes --> Orch
  Routes --> Store
  Routes --> Guards
  Orch --> Tools
  Tools --> Guards
  Orch -->|"Visual Artifacts"| Mermaid
```

```text
src/
├── shared/
│   └── types.ts                   # Shared domain, learning, visual, browse & settings types
├── server/
│   ├── index.ts                   # Hono entrypoint, /api/health & static production serving
│   ├── config.ts                  # Provider-agnostic Vercel AI SDK model resolver
│   ├── settingsStore.ts           # Persistent local config store (~/.scavenger/config.json)
│   ├── guardrails/
│   │   ├── pathGuard.ts           # Canonical realpath repo confinement & symlink defense
│   │   └── gitGuard.ts            # Lock-free, shell-free read-only git allowlist
│   ├── tools/
│   │   ├── fsTools.ts             # Read-only list_tree, read_file, grep_search
│   │   ├── gitTools.ts            # Read-only git_inspect wrapper
│   │   ├── dirBrowser.ts          # Read-only local directory browser for FileExplorerModal
│   │   ├── rootRecon.ts           # Deterministic Stage 0 root reconnaissance
│   │   ├── visualTools.ts         # D2 CLI renderer, raster prompts & multi-layout SVG composer
│   │   └── agentTools.ts          # Vercel AI SDK tool suite bound to session state
│   ├── session/
│   │   ├── sessionStore.ts        # In-memory session store & Stage 0 opening composer
│   │   ├── learningEngine.ts      # Non-linear topic mastery, check-ins & next-step engine
│   │   └── stageMachine.ts        # Stage progression & depth calibration heuristics
│   ├── agent/
│   │   ├── pedagogy.ts            # Whiteboard Mentor 5-beat teaching framework
│   │   ├── systemPrompt.ts        # Grounded architect persona & visual guidelines
│   │   ├── orchestrator.ts        # Multi-step streaming agent loop (SSE)
│   │   └── demoAgent.ts           # Grounded zero-key local demo responder
│   └── routes/
│       ├── sessions.ts            # POST/GET/PATCH /api/sessions
│       ├── chat.ts                # POST /api/sessions/:id/chat (SSE)
│       ├── fs.ts                  # GET /api/fs/browse
│       ├── settings.ts            # GET/PUT /api/settings & POST /api/settings/test
│       └── visuals.ts             # POST /api/render/d2
└── client/
    ├── App.tsx                    # Minimalist chat shell, session state & SSE consumer
    ├── api/client.ts              # Typed REST & SSE API client
    ├── utils/mermaidTheme.ts      # Curated Mermaid v12 theme, lightbox SVG prep & PNG/SVG export
    ├── styles/index.css           # Gemini-inspired minimalist design system
    └── components/
        ├── RepoWelcome.tsx        # Distraction-free landing screen with Browse & quick actions
        ├── FileExplorerModal.tsx  # Local folder picker with breadcrumbs, filter & Git badges
        ├── SettingsModal.tsx      # 3-tab Settings UI (Models, API Keys, Visuals & Safety)
        ├── StageProgressBar.tsx   # Top bar with Pillar rail, Knowledge Map & Depth selector
        ├── ChatMessageList.tsx    # Centered prose stream with inline visuals & tool pills
        ├── LessonFooter.tsx       # Inline Quick Check card & clickable Next Steps cards
        ├── MarkdownRenderer.tsx   # Intercepts fenced mermaid/d2 blocks into DiagramCards
        ├── DiagramCard.tsx        # Mermaid/D2 studio card with Clean/Sketch toggle & export
        ├── ConceptVisualCard.tsx  # Raster artwork + legend or editorial vector concept card
        ├── VisualLightbox.tsx     # Shared interactive zoom & drag-to-pan fullscreen lightbox
        ├── ToolActivityPill.tsx   # Collapsible grounded read-only inspection summary
        └── Composer.tsx           # Floating pill composer with contextual learning nudges
```

---

## Development & Testing

| Script | Description |
| --- | --- |
| `pnpm dev` | Run backend (`tsx watch`, port `3001`) and frontend (`vite`, port `5173`) concurrently |
| `pnpm test` | Run all 11 Vitest suites (49 tests) |
| `pnpm typecheck` | Run TypeScript typechecking (`tsc --noEmit`) |
| `pnpm build` | Build production client (`dist/client`) and server (`dist/server`) |
| `pnpm start` | Run the compiled production server |

### Test Coverage (`tests/`)

- `pathGuard.test.ts` — Blocks `../` traversal, external absolute paths, null bytes, `.git/` direct reads, and symlink escapes.
- `gitGuard.test.ts` — Enforces read-only git allowlists and rejects mutating subcommands and dangerous flags.
- `fsAndGitTools.test.ts` — Proves zero repository mutations (`git status --porcelain` clean, `HEAD` unchanged, no `.git/index.lock`).
- `dirBrowser.test.ts` — Verifies read-only directory browsing, `.git` repo/worktree detection, hidden folders, symlinks, breadcrumbs, fallback, and HTTP error codes.
- `settingsStore.test.ts` — Verifies masked key responses, `0600` local config persistence, `.env` override/fallback, key preservation across model edits, and connection testing.
- `visualFallback.test.ts` — Verifies `pipeline`/`hub`/`layers` SVG concept layouts, word-boundary wrapping, unique `<defs>` IDs, and D2 graceful degradation.
- `rootRecon.test.ts` — Verifies Stage 0 root reconnaissance on git and non-git directories.
- `stageMachine.test.ts`, `learningEngine.test.ts`, `pedagogy.test.ts`, `chatStream.test.ts` — Verify non-linear mastery progression, Whiteboard Mentor pedagogy, SSE flushing, and grounded Demo Mode end-to-end.
