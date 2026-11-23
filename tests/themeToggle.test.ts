import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RepoWelcome } from '../src/client/components/RepoWelcome.js';
import { StageProgressBar } from '../src/client/components/StageProgressBar.js';
import { ThemeToggleButton } from '../src/client/components/ThemeToggleButton.js';
import {
  applyDocumentTheme,
  getDocumentTheme,
  readStoredTheme,
  THEME_STORAGE_KEY,
  toggleThemeMode,
  writeStoredTheme,
} from '../src/client/utils/theme.js';
import type { SessionPublicState } from '../src/shared/types.js';

describe('Light & Dark Theme Toggle', () => {
  it('defaults to light theme and persists/restores user preference', () => {
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, val: string) => {
        store.set(key, val);
      },
    };

    expect(readStoredTheme(mockStorage)).toBe('light');

    writeStoredTheme('dark', mockStorage);
    expect(store.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(readStoredTheme(mockStorage)).toBe('dark');

    writeStoredTheme('light', mockStorage);
    expect(readStoredTheme(mockStorage)).toBe('light');

    store.set(THEME_STORAGE_KEY, 'invalid-value');
    expect(readStoredTheme(mockStorage)).toBe('light');
  });

  it('toggles between light and dark modes and updates documentElement attributes', () => {
    expect(toggleThemeMode('light')).toBe('dark');
    expect(toggleThemeMode('dark')).toBe('light');

    const attrs = new Map<string, string>();
    const mockDoc = {
      documentElement: {
        setAttribute: (k: string, v: string) => attrs.set(k, v),
        getAttribute: (k: string) => attrs.get(k) ?? null,
        style: { colorScheme: '' },
      },
    } as unknown as Document;

    applyDocumentTheme('dark', mockDoc);
    expect(getDocumentTheme(mockDoc)).toBe('dark');
    expect(mockDoc.documentElement.style.colorScheme).toBe('dark');

    applyDocumentTheme('light', mockDoc);
    expect(getDocumentTheme(mockDoc)).toBe('light');
    expect(mockDoc.documentElement.style.colorScheme).toBe('light');
  });

  it('renders ThemeToggleButton with accessible labels for light and dark themes', () => {
    const lightHtml = renderToStaticMarkup(
      createElement(ThemeToggleButton, {
        theme: 'light',
        onToggle: () => {},
      })
    );
    expect(lightHtml).toContain('aria-label="Switch to dark theme"');
    expect(lightHtml).toContain('aria-pressed="false"');
    expect(lightHtml).toContain('data-theme-mode="light"');

    const darkHtml = renderToStaticMarkup(
      createElement(ThemeToggleButton, {
        theme: 'dark',
        onToggle: () => {},
      })
    );
    expect(darkHtml).toContain('aria-label="Switch to light theme"');
    expect(darkHtml).toContain('aria-pressed="true"');
    expect(darkHtml).toContain('data-theme-mode="dark"');
  });

  it('includes the theme toggle button in both RepoWelcome and StageProgressBar', () => {
    const welcomeHtml = renderToStaticMarkup(
      createElement(RepoWelcome, {
        health: null,
        provider: { provider: 'demo', model: 'local-grounded-demo' },
        loading: false,
        error: null,
        onStartSession: () => {},
        onOpenSettings: () => {},
        theme: 'light',
        onToggleTheme: () => {},
      })
    );
    expect(welcomeHtml).toContain('theme-toggle-btn');
    expect(welcomeHtml).toContain('aria-label="Switch to dark theme"');

    const mockSession: SessionPublicState = {
      id: 'sess_1',
      repoPath: '/tmp/repo',
      repoName: 'repo',
      currentStage: 1,
      completedStages: [0],
      diagnostic: { inferredLevel: 'intermediate', completed: true },
      learning: {
        activeTopicId: 'pillar:purpose',
        activeTopicTitle: 'Repo Purpose & Domain',
        topics: [
          {
            id: 'pillar:purpose',
            title: 'Repo Purpose & Domain',
            kind: 'pillar',
            pillarId: 'purpose',
            mastery: 'introduced',
            lastStudiedAt: new Date().toISOString(),
          },
        ],
        pendingCheckIn: [],
        suggestedNextSteps: [],
      },
      provider: { provider: 'demo', model: 'local-grounded-demo' },
      rootRecon: {
        repoName: 'repo',
        repoPath: '/tmp/repo',
        isGitRepo: true,
        topLevelTree: 'src/\npackage.json',
        topLevelEntries: [],
        manifests: [],
        recentMilestones: [],
        recentTags: [],
        topContributors: [],
        detectedStack: ['TypeScript'],
        inspectedAt: new Date().toISOString(),
      },
      messages: [],
      observedFilesCount: 3,
      observedCommitsCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const topbarHtml = renderToStaticMarkup(
      createElement(StageProgressBar, {
        session: mockSession,
        disabled: false,
        onSelectPillar: () => {},
        onOpenSettings: () => {},
        onResetSession: () => {},
        theme: 'dark',
        onToggleTheme: () => {},
      })
    );
    expect(topbarHtml).toContain('theme-toggle-btn');
    expect(topbarHtml).toContain('aria-label="Switch to light theme"');
  });
});
