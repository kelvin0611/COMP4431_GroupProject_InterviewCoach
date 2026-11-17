import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { StarAnswers } from './StarAnswers';
import type { AnsweredTurn, PolishedAnswer } from '../lib/types';

const answered: AnsweredTurn[] = [
  {
    turn_id: 't1',
    question: 'Tell me about a project.',
    transcript: 'In our project the API was slow. I implemented caching.',
    language: 'zh-HK',
    segments: [
      { text: 'In our project the API was slow. ', element: 'Situation' },
      { text: 'I implemented caching.', element: 'Action' },
    ],
  },
];
const polished: PolishedAnswer = {
  turn_id: 't1',
  target_language: 'en-HK',
  provider: 'llama',
  parts: [
    { element: 'Situation', text: 'Our API was slow during a project.', placeholder: false },
    { element: 'Task', text: '[Add what you were responsible for]', placeholder: true },
    { element: 'Action', text: 'I implemented caching.', placeholder: false },
    { element: 'Result', text: '[Add the outcome and how you know it]', placeholder: true },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe('STAR-highlighted answers', () => {
  it('colours each sentence by the STAR element it shows', async () => {
    vi.spyOn(api, 'answers').mockResolvedValue(answered);
    render(<StarAnswers sessionId="s1" />);
    const situation = await screen.findByText('In our project the API was slow.');
    expect(situation).toHaveAttribute('data-element', 'Situation');
    expect(screen.getByText('I implemented caching.')).toHaveAttribute('data-element', 'Action');
  });

  it('rewrites an answer into English STAR parts and marks gaps to fill in', async () => {
    vi.spyOn(api, 'answers').mockResolvedValue(answered);
    const polish = vi.spyOn(api, 'polish').mockResolvedValue(polished);
    render(<StarAnswers sessionId="s1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Show a stronger version/ }));
    expect(polish).toHaveBeenCalledWith('s1', 't1', 'en-HK');
    const panel = await screen.findByRole('region', { name: 'Stronger version' });
    expect(within(panel).getByText('Our API was slow during a project.')).toBeInTheDocument();
    expect(within(panel).getByText('[Add what you were responsible for]')).toHaveClass(
      'placeholder',
    );
  });

  it('asks for a Cantonese rewrite when the user picks it', async () => {
    vi.spyOn(api, 'answers').mockResolvedValue(answered);
    const polish = vi.spyOn(api, 'polish').mockResolvedValue({
      ...polished,
      target_language: 'zh-HK',
    });
    render(<StarAnswers sessionId="s1" />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Rewrite in'), 'zh-HK');
    await user.click(screen.getByRole('button', { name: /Show a stronger version/ }));
    expect(polish).toHaveBeenCalledWith('s1', 't1', 'zh-HK');
  });

  it('shows a recoverable error when the rewrite fails', async () => {
    vi.spyOn(api, 'answers').mockResolvedValue(answered);
    vi.spyOn(api, 'polish').mockRejectedValue(
      new Error('A reliable rewrite could not be generated.'),
    );
    render(<StarAnswers sessionId="s1" />);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: /Show a stronger version/ }));
    expect(await screen.findByText(/reliable rewrite could not be generated/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show a stronger version/ })).toBeEnabled();
  });

  it('renders nothing when the session has no answers', async () => {
    const answers = vi.spyOn(api, 'answers').mockResolvedValue([]);
    const { container } = render(<StarAnswers sessionId="s1" />);
    await vi.waitFor(() => expect(answers).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
