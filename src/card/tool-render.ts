import type { ToolEntry } from './run-state';

const HEADER_SUMMARY_MAX = 80;

/** aiduCAT: header without any category emoji (used inside the aiduPOP panel body). */
export function toolHeaderPlain(tool: ToolEntry): string {
  const summary = summarizeInput(tool.name, tool.input);
  const base = summary ? `**${tool.name}** — ${summary}` : `**${tool.name}**`;
  return tool.status === 'error' ? `${base} ❌` : tool.status === 'stopped' ? `${base} ⏹` : base;
}

export function toolHeaderText(tool: ToolEntry): string {
  // aiduCAT: per-tool emoji aligned with Hangzhou aiduPOP layout.
  const emoji = toolEmoji(tool.name);
  const stateIcon = tool.status === 'error' ? '❌' : tool.status === 'stopped' ? '⏹' : '';
  const summary = summarizeInput(tool.name, tool.input);
  const base = summary ? `${emoji} **${tool.name}** — ${summary}` : `${emoji} **${tool.name}**`;
  return stateIcon ? `${base} ${stateIcon}` : base;
}

/** aiduCAT: stable emoji per tool family (猴哥钦定 f0.2 点菜单 2026-10-19). */
function toolEmoji(name: string): string {
  switch (name) {
    case 'Bash':
      return '🖥️';
    case 'Read':
      return '📖';
    case 'Edit':
      return '⌨️';
    case 'Write':
    case 'NotebookEdit':
      return '📝';
    case 'Grep':
      return '🔍';
    case 'Glob':
      return '🗂️';
    case 'WebFetch':
    case 'WebSearch':
      return '🌐';
    case 'Agent':
    case 'Task':
      return '🤖';
    case 'command_execution':
      return '🖥️';
    default:
      return '💻';
  }
}

function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const pick = (key: string, max = HEADER_SUMMARY_MAX): string => {
    const v = rec[key];
    if (typeof v !== 'string') return '';
    const oneLine = v.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  };
  switch (name) {
    case 'Bash':
      return pick('command');
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return shortenPath(pick('file_path'));
    case 'Grep': {
      const pat = pick('pattern', 40);
      const path = pick('path', 30);
      return path ? `${pat} in ${shortenPath(path)}` : pat;
    }
    case 'Glob':
      return pick('pattern');
    case 'WebFetch':
      return pick('url');
    case 'WebSearch':
      return pick('query', 60);
    case 'Agent':
    case 'Task':
      return pick('description') || pick('subagent_type');
    default:
      return pick('command') || pick('file_path') || pick('path') || pick('query');
  }
}

function shortenPath(p: string): string {
  return p;
}
