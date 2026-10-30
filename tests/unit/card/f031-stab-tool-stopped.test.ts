import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { consumeCotEvents, CotPublisher } from '../../../src/bot/cot';
import { renderCard } from '../../../src/card/run-renderer';
import {
  initialState,
  markEmptyRun,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../../../src/card/run-state';

// f031-stab-#289 (card mode): a round cut off mid-tool (/stop, idle/tool
// timeout, agent error) left that tool's entry in status 'running' forever —
// the finished card listed it exactly like a completed call, and the COT
// timeline kept its "running" title. A tool that never got its result must be
// closed as stopped (⏹) once the round ends.

const withRunningTool = (): RunState =>
  [
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 999' } },
    { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a/b.ts' } },
    { type: 'tool_result', id: 't2', output: 'ok', isError: false },
  ].reduce((s, e) => reduce(s, e as AgentEvent), initialState);

const toolStatuses = (s: RunState) =>
  s.blocks.flatMap((b) => (b.kind === 'tool' ? [[b.tool.id, b.tool.status]] : []));

describe('f031-stab-#289 interrupted rounds leave no running tool behind', () => {
  const enders: Array<[string, (s: RunState) => RunState]> = [
    ['/stop (markInterrupted)', markInterrupted],
    ['idle/tool timeout (markIdleTimeout)', (s) => markIdleTimeout(s, 30, 'Bash')],
    ['empty-run error (markEmptyRun)', markEmptyRun],
    ['done(interrupted)', (s) => reduce(s, { type: 'done', terminationReason: 'interrupted' } as AgentEvent)],
    ['done(timeout)', (s) => reduce(s, { type: 'done', terminationReason: 'timeout' } as AgentEvent)],
    ['error(failed)', (s) => reduce(s, { type: 'error', message: 'boom', terminationReason: 'failed' })],
  ];
  for (const [name, end] of enders) {
    it(`f031-stab-#289 ${name}: unfinished tool → stopped, finished tool untouched`, () => {
      const s = end(withRunningTool());
      expect(toolStatuses(s)).toEqual([
        ['t1', 'stopped'],
        ['t2', 'done'],
      ]);
    });
  }

  it('f031-stab-#289 the finished card marks the cut-off tool with ⏹ (and only that one)', () => {
    const json = JSON.stringify(renderCard(markInterrupted(withRunningTool())));
    expect(json).toMatch(/Bash\*\* — sleep 999 ⏹/);
    expect(json).not.toMatch(/b\.ts ⏹/);
  });

  it('f031-stab-#289 COT timeline closes a tool that never got its result', async () => {
    const events: Array<{ event_type: string; content: string }> = [];
    const client = {
      create: async () => ({ cot_id: 'c', message_id: 'm' }),
      update: async (_r: unknown, evts: readonly { event_type: string; content: string }[]) => {
        events.push(...evts);
      },
      complete: async () => {},
    };
    const publisher = new CotPublisher({
      client: client as never,
      chatId: 'oc_chat',
      originMessageId: 'om_o',
      runId: 'r',
      scope: 'oc_chat',
      inputPreview: 'x',
    });
    await publisher.start();
    async function* it(): AsyncIterable<AgentEvent> {
      yield { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 999' } } as AgentEvent;
      yield { type: 'done', terminationReason: 'interrupted' } as AgentEvent;
    }
    await consumeCotEvents(it(), publisher, { detail: 'brief' });
    const results = events.filter((e) => e.event_type === 'TOOL_CALL_RESULT');
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0]!.content).content).toContain('⏹');
  });
});
