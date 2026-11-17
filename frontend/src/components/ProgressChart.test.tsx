import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { ProgressChart } from './ProgressChart';
import type { ProgressPoint } from '../lib/types';

const point = (id: string, day: string, covered: ProgressPoint['covered']): ProgressPoint => ({
  session_id: id,
  created_at: `2026-11-${day}T08:00:00Z`,
  role_title: 'Engineer',
  language: 'en-HK',
  answer_count: 3,
  covered,
});

afterEach(() => vi.restoreAllMocks());

describe('STAR progress chart', () => {
  it('shows one column per session with the elements that were covered', async () => {
    vi.spyOn(api, 'progress').mockResolvedValue([
      point('a', '15', ['Situation']),
      point('b', '16', ['Situation', 'Task', 'Action', 'Result']),
    ]);
    render(<ProgressChart />);
    const latest = await screen.findByRole('listitem', { name: /4 of 4/ });
    expect(latest.querySelectorAll('.filled')).toHaveLength(4);
    const first = screen.getByRole('listitem', { name: /1 of 4/ });
    expect(first.querySelectorAll('.filled')).toHaveLength(1);
    expect(screen.getByText(/Latest 4 of 4/)).toBeInTheDocument();
  });

  it('stays hidden until there is at least one answered session', async () => {
    const progress = vi.spyOn(api, 'progress').mockResolvedValue([]);
    const { container } = render(<ProgressChart />);
    await vi.waitFor(() => expect(progress).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps only the most recent sessions', async () => {
    vi.spyOn(api, 'progress').mockResolvedValue(
      Array.from({ length: 14 }, (_, i) => point(`s${i}`, String(10 + i), ['Situation'])),
    );
    render(<ProgressChart />);
    expect(await screen.findAllByRole('listitem')).toHaveLength(10);
  });
});
