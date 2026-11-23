import { Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '../utils/theme';

export interface ThemeToggleButtonProps {
  theme: ThemeMode;
  onToggle: () => void;
  className?: string;
  showLabel?: boolean;
}

export function ThemeToggleButton({
  theme,
  onToggle,
  className = 'icon-button theme-toggle-btn',
  showLabel = false,
}: ThemeToggleButtonProps) {
  const isDark = theme === 'dark';
  const actionLabel = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      className={className}
      onClick={onToggle}
      title={actionLabel}
      aria-label={actionLabel}
      aria-pressed={isDark}
      data-theme-mode={theme}
    >
      {isDark ? <Sun size={17} /> : <Moon size={17} />}
      {showLabel && <span>{isDark ? 'Light' : 'Dark'}</span>}
    </button>
  );
}
