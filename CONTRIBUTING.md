# Contributing to Scavenger

Thanks for helping improve Scavenger! This guide walks you through everything from reporting a bug to getting a pull request merged.

**The one rule to know up front:** the `main` branch is protected. Every change, including the maintainer's own, lands through a pull request. Pushing directly to `main` and force-pushing are both blocked.

---

## Ways to contribute

- **Report a bug:** [open an issue](https://github.com/marcopt74/scavenger/issues/new). Include what you did, what you expected, what happened instead, your OS and Node version, and which LLM provider you used (or Demo Mode).
- **Suggest a feature:** open an issue that describes the problem you want solved, not just the solution you have in mind.
- **Send a fix or improvement:** follow the workflow below. For anything larger than a small fix, open an issue first so we can agree on the approach before you invest time in code.

---

## Development setup

### Prerequisites

- **Node.js** `>= 20`
- **pnpm** (`npm install -g pnpm` or `corepack enable`)
- *(Optional)* the **[D2 CLI](https://d2lang.com/)** if you're working on D2 diagram rendering

### Install and run

```bash
pnpm install
pnpm dev
```

The client runs at <http://localhost:5173> and the API at <http://localhost:3001>.

You **don't need an API key** to develop. With no provider configured, Scavenger runs in **Demo Mode**, which does real read-only inspection against whatever repository you point it at. See the [README](README.md) for provider configuration and a tour of the architecture.

### Useful scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Run the backend (`tsx watch`) and frontend (`vite`) together |
| `pnpm test` | Run the Vitest suite once |
| `pnpm typecheck` | Typecheck the whole project with `tsc --noEmit` |
| `pnpm build` | Build the production client and server into `dist/` |
| `pnpm start` | Run the compiled production server |

---

## Making a change

### 1. Get the code

**External contributors:** fork the repository on GitHub, then clone your fork:

```bash
git clone git@github.com:<your-username>/scavenger.git
cd scavenger
git remote add upstream https://github.com/marcopt74/scavenger.git
```

**Maintainers** with write access can clone the repository directly and push branches to it.

### 2. Create a branch from an up-to-date `main`

```bash
git switch main
git pull upstream main     # or: git pull origin main
git switch -c feat/short-description
```

Name the branch after the kind of change:

| Prefix | Use for |
| --- | --- |
| `feat/` | New user-facing functionality |
| `fix/` | Bug fixes |
| `docs/` | Documentation only |
| `refactor/` | Code changes that don't alter behavior |
| `test/` | Adding or improving tests |
| `chore/` | Tooling, dependencies, config |

### 3. Make your change

Keep each pull request focused on one thing. Two unrelated fixes are easier to review as two PRs.

### 4. Check your work locally

There is no CI yet, so these checks are up to you. Run both and make sure they pass before you open a PR:

```bash
pnpm typecheck
pnpm test
```

If you changed anything in the build or server startup path, also run `pnpm build`.

### 5. Commit

Use [Conventional Commits](https://www.conventionalcommits.org/), as the rest of the history does:

```text
feat: add keyboard shortcut to open the Knowledge Map
fix: flush SSE stream before close
docs: explain Demo Mode in the README
```

Write the subject in the imperative mood ("add", not "added") and keep it under about 72 characters. Use the body to explain *why* when the reason isn't obvious.

**Don't bump the `version` in `package.json`.** The maintainer does that in a separate release commit.

### 6. Open a pull request

```bash
git push -u origin feat/short-description
gh pr create --base main --repo marcopt74/scavenger   # or use the GitHub web UI
```

In the PR description, include:

- **What** changed and **why**, plus a link to the related issue (`Closes #123`)
- **How you tested it:** which commands you ran and what you tried by hand
- **Screenshots or a short recording** for any UI change

Give the PR a Conventional Commit-style title (`feat: …`, `fix: …`). If the PR is squash-merged, that title becomes the commit message on `main`.

### 7. Review and merge

A maintainer will review your PR. Push follow-up commits to the same branch to address feedback; don't force-push over commits that have already been reviewed unless you're asked to. Once the PR is approved, a maintainer merges it.

---

## Code conventions

- **TypeScript in strict mode** throughout. Avoid `any`. Put types shared between client and server in `src/shared/types.ts`.
- **Import paths:**
  - In `src/server/`, `src/shared/` and `tests/`, write relative imports with a `.js` suffix (`import { runReadOnlyGit } from '../guardrails/gitGuard.js';`). The server compiles to native ES modules, which require the extension at runtime.
  - In `src/client/`, leave the suffix off (`import { browseDirectory } from '../api/client';`). Vite resolves those paths.
- **Formatting:** the project has no formatter configured yet, so match the surrounding code: 2-space indentation, single quotes, semicolons.
- **Tests** live in `tests/*.test.ts` and run in a Node environment with Vitest. Add or update tests alongside any change in behavior.

---

## The read-only guarantee (please read before touching server code)

Scavenger's core promise is that it **never modifies the repository it inspects**. People point it at repositories they care about, so this guarantee is non-negotiable:

- **All filesystem access to the inspected repository goes through [`pathGuard.ts`](src/server/guardrails/pathGuard.ts).** Don't call `fs` directly on user-supplied paths.
- **All git access goes through [`gitGuard.ts`](src/server/guardrails/gitGuard.ts)**, which enforces a read-only subcommand allowlist, runs without a shell, and disables optional locks.
- **Open an issue before you** widen the git allowlist, add a new agent tool that touches the filesystem, or introduce any code path that writes, deletes or runs other programs. These changes need discussion before they need code.
- **Guardrail changes must come with tests.** Cover both the allowed case and the blocked cases (traversal, symlink escapes, mutating flags, and so on). [`fsAndGitTools.test.ts`](tests/fsAndGitTools.test.ts) shows how to prove that a tool leaves the repository unchanged.

---

## Secrets and local configuration

- **Never commit `.env`, API keys, or anything from `~/.scavenger/`.** `.gitignore` already covers the usual files, but check `git status` before you commit.
- If you add a new environment variable, add it to [`.env.example`](.env.example) with a safe placeholder and document it in the README's configuration table.
- Don't paste real API keys into issues, PRs or screenshots.

---

## Reporting a security issue

If you find a way to make Scavenger read outside the chosen repository, write to disk, run arbitrary commands, or leak API keys, **please don't post the details publicly**. Open a short issue saying you've found a security problem, without exploit details, and the maintainer will arrange a private way to share the specifics.

---

Thanks again for contributing!
