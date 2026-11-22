import { ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { ToolActivity } from '../../shared/types';

export function ToolActivityPill({ activities }: { activities: ToolActivity[] }) {
  const [open, setOpen] = useState(false);

  if (!activities || activities.length === 0) return null;

  const running = activities.some((a) => a.status === 'running');
  const readCount = activities.filter((a) => ['list_tree', 'read_file', 'grep_search'].includes(a.toolName)).length;
  const gitCount = activities.filter((a) => a.toolName === 'git_inspect').length;

  const summaryParts: string[] = [];
  if (readCount > 0) summaryParts.push(`${readCount} repo read${readCount === 1 ? '' : 's'}`);
  if (gitCount > 0) summaryParts.push(`${gitCount} git quer${gitCount === 1 ? 'y' : 'ies'}`);
  const summaryLabel = running
    ? activities.find((a) => a.status === 'running')?.summary || 'Inspecting repository…'
    : summaryParts.length > 0
      ? `Grounded in ${summaryParts.join(' · ')}`
      : `${activities.length} tool step${activities.length === 1 ? '' : 's'}`;

  return (
    <div className="tool-pill-container">
      <button
        type="button"
        className="tool-pill-trigger"
        onClick={() => setOpen((prev) => !prev)}
      >
        <ShieldCheck size={14} className="readonly-icon" />
        <span>{summaryLabel}</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>

      {open && (
        <div className="tool-pill-list">
          {activities.map((act) => (
            <div key={act.id} className="tool-pill-item">
              <span className={`tool-status-dot ${act.status}`} />
              <span className="tool-name-tag">{act.toolName}</span>
              <span>{act.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
