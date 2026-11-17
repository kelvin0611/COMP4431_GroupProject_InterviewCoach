import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Interview } from './Interview';
import { useLiveSession } from '../lib/useLiveSession';
import { azureRecognizer, playQuestion, recordMicrophone } from '../lib/audio';
import { api } from '../lib/api';
import type { Session } from '../lib/types';

vi.mock('../lib/useLiveSession', () => ({ useLiveSession: vi.fn() }));
vi.mock('../lib/audio', () => ({
  recordMicrophone: vi.fn(),
  azureRecognizer: vi.fn(),
  playQuestion: vi.fn(() => vi.fn()),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, transcribe: vi.fn() } };
});
vi.mock('../components/Avatar', () => ({ default: () => <div>Coach portrait</div> }));

const session: Session = {
  id: 's1',
  job_profile_id: 'j1',
  role_title: 'Engineer',
  language: 'en-HK',
  difficulty: 'standard',
  question_count: 3,
  state: 'ready',
  current_question: 1,
  turns: [
    {
      id: 't1',
      question: {
        interviewer_text: 'Tell me about a project.',
        question_type: 'opening',
        targeted_competencies: [],
        adaptive_follow_up_reason: null,
        citations: [],
      },
      answer: null,
      created_at: '2026-11-02T00:00:00Z',
    },
  ],
  created_at: '2026-11-02T00:00:00Z',
  provider: 'demo',
};
const control = vi.fn().mockResolvedValue(undefined);
const answer = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(useLiveSession).mockReturnValue({
    session,
    busy: false,
    error: '',
    setError: vi.fn(),
    state: 'ready',
    streamText: '',
    answer,
    control,
  });
});

type PlaybackCallbacks = Parameters<typeof playQuestion>[3];

function captureQuestionPlayback() {
  const playback: { callbacks?: PlaybackCallbacks } = {};
  vi.mocked(playQuestion).mockImplementation((_text, _language, _consent, callbacks) => {
    playback.callbacks = callbacks;
    return vi.fn();
  });
  return playback;
}

function grantMicrophone() {
  const stop = vi
    .fn()
    .mockResolvedValue({ blob: new Blob(), duration: 6, pauseCount: 1, silenceSeconds: 2 });
  vi.mocked(recordMicrophone).mockResolvedValue({ stream: { active: true } as MediaStream, stop });
  return stop;
}

async function answerHandsFree(playback: { callbacks?: PlaybackCallbacks }) {
  vi.mocked(api.transcribe).mockResolvedValue({ text: 'I led the API fix', provider: 'whisper' });
  await waitFor(() => expect(playback.callbacks).toBeDefined());
  act(() => playback.callbacks!.onEnd('finished'));
  await waitFor(() => expect(recordMicrophone).toHaveBeenCalledOnce());
  const options = vi.mocked(recordMicrophone).mock.calls[0][1];
  await act(async () => options?.onEndOfSpeech?.());
}

describe('hands-free conversation', () => {
  it('starts listening when the question finishes playing', async () => {
    localStorage.setItem('voxprep.handsFree', '1');
    const playback = captureQuestionPlayback();
    grantMicrophone();
    render(
      <Interview id="s1" navigate={vi.fn()} speechConsent={false} onSpeechConsent={vi.fn()} />,
    );
    await waitFor(() => expect(playback.callbacks).toBeDefined());
    act(() => playback.callbacks!.onEnd('finished'));
    await waitFor(() => expect(recordMicrophone).toHaveBeenCalledOnce());
    expect(await screen.findByRole('button', { name: 'Finish recording' })).toBeInTheDocument();
  });
  it('does not start listening when playback was stopped by hand', async () => {
    localStorage.setItem('voxprep.handsFree', '1');
    const playback = captureQuestionPlayback();
    grantMicrophone();
    render(
      <Interview id="s1" navigate={vi.fn()} speechConsent={false} onSpeechConsent={vi.fn()} />,
    );
    await waitFor(() => expect(playback.callbacks).toBeDefined());
    act(() => playback.callbacks!.onEnd('stopped'));
    expect(recordMicrophone).not.toHaveBeenCalled();
  });
  it('sends the transcript after a countdown the user can skip', async () => {
    localStorage.setItem('voxprep.handsFree', '1');
    const playback = captureQuestionPlayback();
    grantMicrophone();
    render(
      <Interview id="s1" navigate={vi.fn()} speechConsent={false} onSpeechConsent={vi.fn()} />,
    );
    await answerHandsFree(playback);
    expect(await screen.findByText(/Sending in \d/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith(
        expect.objectContaining({ transcript: 'I led the API fix' }),
      ),
    );
  });
  it('cancels the automatic send as soon as the user edits the transcript', async () => {
    localStorage.setItem('voxprep.handsFree', '1');
    const playback = captureQuestionPlayback();
    grantMicrophone();
    render(
      <Interview id="s1" navigate={vi.fn()} speechConsent={false} onSpeechConsent={vi.fn()} />,
    );
    await answerHandsFree(playback);
    await screen.findByText(/Sending in \d/);
    await userEvent.setup().type(screen.getByLabelText('Your answer'), ' and tested it');
    expect(screen.queryByText(/Sending in \d/)).not.toBeInTheDocument();
    expect(answer).not.toHaveBeenCalled();
  });
  it('remembers the hands-free choice for the next session', async () => {
    render(
      <Interview id="s1" navigate={vi.fn()} speechConsent={false} onSpeechConsent={vi.fn()} />,
    );
    grantMicrophone();
    await userEvent
      .setup()
      .click(screen.getByRole('checkbox', { name: 'Hands-free conversation' }));
    expect(localStorage.getItem('voxprep.handsFree')).toBe('1');
  });
});

describe('microphone permission recovery', () => {
  it('preserves a typed draft when microphone permission is denied', async () => {
    vi.mocked(recordMicrophone).mockRejectedValue(new Error('Permission denied'));
    render(
      <Interview id="s1" navigate={vi.fn()} speechConsent={false} onSpeechConsent={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your answer'), 'My existing project story');
    await user.click(screen.getByRole('button', { name: 'Re-record answer' }));
    await screen.findByText(
      'Microphone access is unavailable. Type your answer below to continue.',
    );
    expect(screen.getByLabelText('Your answer')).toHaveValue('My existing project story');
  });
  it('closes late microphone access when the user paused during the permission prompt', async () => {
    let resolveCapture!: (value: Awaited<ReturnType<typeof recordMicrophone>>) => void;
    vi.mocked(recordMicrophone).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
    const stop = vi
      .fn()
      .mockResolvedValue({ blob: new Blob(), duration: 0, pauseCount: 0, silenceSeconds: 0 });
    render(<Interview id="s1" navigate={vi.fn()} speechConsent={true} onSpeechConsent={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Record answer' }));
    await user.click(screen.getByRole('button', { name: /^Pause$/ }));
    await act(async () => {
      resolveCapture({ stream: { active: true } as MediaStream, stop });
    });
    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(azureRecognizer).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Finish recording' })).not.toBeInTheDocument();
  });
});
