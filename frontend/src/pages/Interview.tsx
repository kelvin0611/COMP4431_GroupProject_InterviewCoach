import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  ChevronRight,
  Clock3,
  Eye,
  EyeOff,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Send,
  SkipForward,
  Square,
  Volume2,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { azureRecognizer, playQuestion, recordMicrophone } from '../lib/audio';
import type { RecordedAnswer } from '../lib/audio';
import type { Language } from '../lib/types';
import { formatDuration } from '../lib/format';
import { useLiveSession } from '../lib/useLiveSession';
import { ErrorNotice, Loading, ProviderBadge, Sources } from '../components/Common';

const Avatar = lazy(() => import('../components/Avatar'));
const statusLabels: Record<string, string> = {
  ready: 'Ready when you are',
  listening: 'Listening to your story',
  initializing: 'Waiting for microphone permission',
  transcribing: 'Preparing your transcript',
  thinking: 'Thinking about your answer',
  speaking: 'Your interviewer is speaking',
  paused: 'Take a breath. We’re paused.',
  completed: 'Practice complete',
};
const HANDS_FREE_KEY = 'voxprep.handsFree';
// Seconds the transcript stays visible before a hands-free answer is sent.
const AUTO_SEND_SECONDS = 4;

function readHandsFree() {
  try {
    return localStorage.getItem(HANDS_FREE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveHandsFree(on: boolean) {
  try {
    localStorage.setItem(HANDS_FREE_KEY, on ? '1' : '0');
  } catch {
    // A remembered preference is a convenience; the toggle still works for this visit.
  }
}

export function Interview({
  id,
  navigate,
  speechConsent,
  onSpeechConsent,
}: {
  id: string;
  navigate: (path: string) => void;
  speechConsent: boolean;
  onSpeechConsent: (value: boolean) => void;
}) {
  const live = useLiveSession(id);
  const { session, busy } = live;
  const [chosenLanguage, setChosenLanguage] = useState<Language | null>(null);
  const answerLanguage = chosenLanguage || session?.language || 'en-HK';
  const [transcript, setTranscript] = useState('');
  const [corrected, setCorrected] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [started, setStarted] = useState(false);
  const [speechState, setSpeechState] = useState('');
  const [mouth, setMouth] = useState(0);
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState('');
  const [avatarOff, setAvatarOff] = useState(false);
  const [metrics, setMetrics] = useState<RecordedAnswer | null>(null);
  const [handsFree, setHandsFree] = useState(readHandsFree);
  const [listenNext, setListenNext] = useState(false);
  const [silenceStop, setSilenceStop] = useState<number | null>(null);
  const [autoSendIn, setAutoSendIn] = useState<number | null>(null);
  const recorder = useRef<Awaited<ReturnType<typeof recordMicrophone>> | null>(null);
  const recognizer = useRef<Awaited<ReturnType<typeof azureRecognizer>> | null>(null);
  const playback = useRef<(() => void) | null>(null);
  const recognized = useRef('');
  const recognitionFailed = useRef(false);
  const recordingAbort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [captions, setCaptions] = useState('');
  const turn = session?.turns[session.turns.length - 1];
  const paused = session?.state === 'paused';
  const displayState = paused ? 'paused' : speechState || (busy ? 'thinking' : live.state);
  const recording = speechState === 'listening';
  const audioBusy = recording || speechState === 'transcribing' || speechState === 'initializing';
  useEffect(() => {
    if (session?.state === 'completed') navigate(`/report/${id}`);
  }, [session?.state, id, navigate]);
  useEffect(() => {
    setTranscript('');
    setCorrected(false);
    setMetrics(null);
    setElapsed(0);
    setStarted(false);
    setCaptions('');
    setAutoSendIn(null);
    setListenNext(false);
    playback.current?.();
  }, [turn?.id]);
  useEffect(() => {
    if (!started || paused || busy || speechState === 'speaking' || speechState === 'transcribing')
      return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [started, paused, busy, speechState]);
  useEffect(
    () => () => {
      generation.current++;
      recordingAbort.current?.abort();
      playback.current?.();
      void recognizer.current?.stop();
      void recorder.current?.stop();
    },
    [],
  );
  function stopSpeaking() {
    playback.current?.();
    playback.current = null;
    setMouth(0);
    if (speechState === 'speaking') setSpeechState('');
  }
  function speak() {
    if (!turn || !session) return;
    stopSpeaking();
    setNotice('');
    playback.current = playQuestion(
      turn.question.interviewer_text,
      session.language,
      speechConsent,
      {
        onStart: () => setSpeechState('speaking'),
        onMouth: setMouth,
        onEnd: (reason) => {
          if (reason === 'finished') {
            playback.current = null;
            setListenNext(true);
          }
          setSpeechState('');
        },
        onNotice: setNotice,
      },
    );
  }
  const readNewQuestion = useEffectEvent(() => {
    if ((speechConsent || handsFree) && !paused) speak();
  });
  useEffect(() => {
    if (turn?.id) readNewQuestion();
  }, [turn?.id]);
  async function beginRecording() {
    if (!session || paused || busy || audioBusy) return;
    stopSpeaking();
    setAutoSendIn(null);
    const run = ++generation.current;
    setNotice('');
    setSpeechState('initializing');
    try {
      const capture = await recordMicrophone(
        setLevel,
        handsFree ? { onEndOfSpeech: () => setSilenceStop(run) } : {},
      );
      if (run !== generation.current) {
        await capture.stop();
        return;
      }
      recorder.current = capture;
      setTranscript('');
      setCaptions('');
      setCorrected(false);
      setMetrics(null);
      recognized.current = '';
      recognitionFailed.current = false;
      setStarted(true);
      setElapsed(0);
      setSpeechState('listening');
      const abort = new AbortController();
      recordingAbort.current = abort;
      if (speechConsent) {
        try {
          const azure = await azureRecognizer(
            capture.stream,
            answerLanguage,
            (text, final) => {
              if (run !== generation.current) return;
              if (final) {
                recognized.current = `${recognized.current} ${text}`.trim();
                setTranscript(recognized.current);
                setCaptions('');
              } else setCaptions(text);
            },
            (message) => {
              if (run === generation.current) {
                recognitionFailed.current = true;
                setNotice(message);
              }
            },
            abort.signal,
          );
          if (run !== generation.current || !capture.stream.active) {
            await azure.stop();
            return;
          }
          recognizer.current = azure;
        } catch {
          if (run !== generation.current) return;
          recognitionFailed.current = true;
          setNotice(
            'Azure recognition is unavailable. Your recording will be transcribed locally when you stop.',
          );
        }
      } else
        setNotice(
          handsFree
            ? 'Listening. Pause for two seconds when you have finished.'
            : 'Recording on this computer. Local transcription runs when you stop.',
        );
    } catch {
      if (run !== generation.current) return;
      setSpeechState('');
      setNotice('Microphone access is unavailable. Type your answer below to continue.');
    }
  }
  async function finishRecording(discard = false) {
    const capture = recorder.current;
    if (!capture) return;
    setSpeechState(discard ? '' : 'transcribing');
    if (!recognizer.current) recordingAbort.current?.abort();
    await recognizer.current?.stop();
    recordingAbort.current?.abort();
    recordingAbort.current = null;
    recognizer.current = null;
    recorder.current = null;
    const result = await capture.stop();
    generation.current++;
    setCaptions('');
    if (discard) return;
    setMetrics(result);
    setElapsed(Math.round(result.duration));
    try {
      let text = '';
      if (recognized.current.trim() && !recognitionFailed.current) {
        text = recognized.current;
        setNotice('Read your transcript and make any corrections before sending.');
      } else if (session) {
        text = (await api.transcribe(result.blob, answerLanguage)).text;
        setNotice('Local transcription is ready. Please check the wording before sending.');
      }
      setTranscript(text);
      if (handsFree && text.trim()) setAutoSendIn(AUTO_SEND_SECONDS);
    } catch (e) {
      setNotice(`${errorMessage(e)} You can type your answer below.`);
    } finally {
      setSpeechState('');
    }
  }
  const stopAtLimit = useEffectEvent(() => {
    void finishRecording();
  });
  const listenHandsFree = useEffectEvent(() => {
    void beginRecording();
  });
  const sendHandsFree = useEffectEvent(() => {
    void submit();
  });
  // Hands-free: listen once the question has finished playing and the coach is idle.
  useEffect(() => {
    if (!listenNext || !handsFree) return;
    if (paused || busy || audioBusy || speechState === 'speaking') return;
    setListenNext(false);
    listenHandsFree();
  }, [listenNext, handsFree, paused, busy, audioBusy, speechState]);
  // Hands-free: the recorder reported a sustained pause after speech in this recording.
  useEffect(() => {
    if (silenceStop === null) return;
    setSilenceStop(null);
    if (silenceStop === generation.current && recording) stopAtLimit();
  }, [silenceStop, recording]);
  // Hands-free: count down, then send unless the user started editing.
  useEffect(() => {
    if (autoSendIn === null) return;
    if (autoSendIn <= 0) {
      setAutoSendIn(null);
      sendHandsFree();
      return;
    }
    const timer = setTimeout(() => setAutoSendIn((n) => (n === null ? null : n - 1)), 1000);
    return () => clearTimeout(timer);
  }, [autoSendIn]);
  function toggleHandsFree(on: boolean) {
    setHandsFree(on);
    saveHandsFree(on);
    setAutoSendIn(null);
    setListenNext(on && !recording && speechState !== 'transcribing');
  }
  useEffect(() => {
    if (!recording) return;
    const timer = setTimeout(stopAtLimit, 300000);
    return () => clearTimeout(timer);
  }, [recording]);
  async function control(action: 'pause' | 'resume' | 'skip' | 'retry' | 'end' | 'cancel') {
    setAutoSendIn(null);
    setListenNext(false);
    generation.current++;
    recordingAbort.current?.abort();
    recordingAbort.current = null;
    setSpeechState('');
    stopSpeaking();
    if (recorder.current) await finishRecording(true);
    await live.control(action);
  }
  async function submit() {
    setAutoSendIn(null);
    if (!session || !transcript.trim() || paused || busy || audioBusy) return;
    stopSpeaking();
    await live.answer({
      transcript: transcript.trim(),
      language: answerLanguage,
      turn_id: turn?.id,
      elapsed_seconds: Math.max(1, metrics?.duration || elapsed),
      corrected,
      ...(metrics
        ? {
            speech_metrics: {
              pause_count: metrics.pauseCount,
              silence_seconds: metrics.silenceSeconds,
            },
          }
        : {}),
    });
  }
  if (!session) return live.error ? <ErrorNotice message={live.error} /> : <Loading />;
  const question = turn?.question;
  const progressed = Math.max(0, session.current_question - 1);
  return (
    <>
      <div className="interview-top">
        <button className="back-link" onClick={() => navigate('/')}>
          <ArrowLeft size={16} /> {transcript.trim() ? 'Leave & discard draft' : 'Leave practice'}
        </button>
        <ProviderBadge provider={session.provider} />
      </div>
      <div className="page-heading compact">
        <div>
          <p className="eyebrow">YOUR PRACTICE, IN PROGRESS</p>
          <h1 className="interview-title">{session.role_title}</h1>
        </div>
        <span className="step-marker">
          02 <span>/ 03</span>
        </span>
      </div>
      {live.error && <ErrorNotice message={live.error} onDismiss={() => live.setError('')} />}
      <div className="interview-grid">
        <section className="interviewer-panel" aria-label="Interviewer">
          <div className="interviewer-heading">
            <span className="pill neutral">
              <span className="status-dot" /> VOX · YOUR PRACTICE COACH
            </span>
            <button
              className="icon-button"
              aria-label={avatarOff ? 'Enable animated avatar' : 'Disable animated avatar'}
              aria-pressed={avatarOff}
              onClick={() => setAvatarOff((value) => !value)}
            >
              {avatarOff ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <div className="avatar-stage">
            <span className="avatar-ring" />
            <Suspense
              fallback={
                <div className="portrait-placeholder">
                  <AudioLines size={58} />
                </div>
              }
            >
              <Avatar mouth={mouth} state={displayState} disabled={avatarOff} />
            </Suspense>
          </div>
          <div className="coach-state" role="status">
            <span className={`status-dot ${displayState === 'listening' ? 'pulse' : ''}`} />
            {statusLabels[displayState] || 'Ready when you are'}
          </div>
          <div className="waveform" role="img" aria-label="Microphone activity">
            {Array.from({ length: 32 }, (_, i) => (
              <span key={i} style={{ height: `${4 + level * (8 + ((i * 13) % 29))}px` }} />
            ))}
          </div>
          <div className="interviewer-actions">
            <button
              className="button small secondary"
              disabled={busy || audioBusy || paused}
              onClick={speak}
            >
              <Volume2 size={16} /> Repeat question
            </button>
            {speechState === 'speaking' && (
              <button className="button small secondary" onClick={stopSpeaking}>
                <Square size={14} /> Stop audio
              </button>
            )}
          </div>
        </section>
        <div className="answer-column">
          <div className="question-progress">
            <span>
              Question {Math.min(session.current_question, session.question_count)}{' '}
              <span>of {session.question_count}</span>
            </span>
            <span>
              <Clock3 size={15} /> {formatDuration(elapsed)}
            </span>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="Interview progress"
            aria-valuenow={progressed}
            aria-valuemin={0}
            aria-valuemax={session.question_count}
          >
            <span style={{ width: `${(progressed / session.question_count) * 100}%` }} />
          </div>
          <section className="question-card">
            <div className="question-meta">
              <span className="eyebrow">
                {question?.question_type === 'follow_up'
                  ? 'LET’S GO A LITTLE DEEPER'
                  : 'YOUR NEXT QUESTION'}
              </span>
              <span>{session.language === 'zh-HK' ? '廣東話' : 'English'}</span>
            </div>
            <h2 lang={session.language === 'zh-HK' ? 'zh-HK' : 'en'}>
              {question?.interviewer_text}
            </h2>
            {question?.adaptive_follow_up_reason && (
              <p className="follow-up-reason">
                <ChevronRight size={16} /> {question.adaptive_follow_up_reason}
              </p>
            )}
            <div className="competency-tags">
              {question?.targeted_competencies.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            {question && <Sources citations={question.citations} />}
          </section>
          <section className="answer-panel">
            <div className="answer-label">
              <label htmlFor="answer">
                {session.language === 'zh-HK' ? 'Your answer · 你嘅回答' : 'Your answer'}
              </label>
              <label className="hands-free-toggle">
                <input
                  type="checkbox"
                  checked={handsFree}
                  onChange={(event) => toggleHandsFree(event.target.checked)}
                />
                Hands-free conversation
              </label>
            </div>
            <div className="answer-language">
              <label htmlFor="answer-language">Answer language</label>
              <select
                id="answer-language"
                value={answerLanguage}
                disabled={paused || busy || audioBusy}
                onChange={(event) => setChosenLanguage(event.target.value as Language)}
              >
                <option value="en-HK">English</option>
                <option value="zh-HK">廣東話</option>
              </select>
            </div>
            <textarea
              id="answer"
              rows={6}
              placeholder={
                answerLanguage === 'zh-HK'
                  ? '例如：喺大學小組專題入面，我負責…'
                  : 'Think of a specific experience. What happened, what did you do, and what changed?'
              }
              value={transcript + (captions ? ` ${captions}` : '')}
              onFocus={() => {
                setStarted(true);
                setAutoSendIn(null);
              }}
              onChange={(e) => {
                setAutoSendIn(null);
                setTranscript(e.target.value);
                setCorrected(true);
                setStarted(true);
              }}
              readOnly={recording}
              disabled={paused || busy || speechState === 'transcribing'}
              maxLength={12000}
              aria-describedby="answer-hint"
            />
            <div className="answer-hint" id="answer-hint">
              <span />
              <span>{transcript.length.toLocaleString()}/12,000</span>
            </div>
            {notice && (
              <p className="speech-notice" role="status">
                {notice}
              </p>
            )}
            {autoSendIn !== null && (
              <div className="auto-send" role="status">
                <span>Sending in {autoSendIn}s</span>
                <button type="button" className="text-button" onClick={() => void submit()}>
                  Send now
                </button>
                <button type="button" className="text-button" onClick={() => setAutoSendIn(null)}>
                  Keep editing
                </button>
              </div>
            )}
            <div className="answer-actions">
              {recording ? (
                <button className="button recording" onClick={() => void finishRecording()}>
                  <Square size={16} /> Finish recording
                </button>
              ) : (
                <button
                  className="button secondary"
                  disabled={paused || busy || audioBusy}
                  onClick={() => void beginRecording()}
                >
                  <Mic size={17} /> {transcript ? 'Re-record answer' : 'Record answer'}
                </button>
              )}
              <button
                className="button primary"
                disabled={!transcript.trim() || paused || busy || audioBusy}
                onClick={() => void submit()}
              >
                {busy ? 'Thinking…' : 'Send answer'} <Send size={17} />
              </button>
            </div>
            <details className="voice-settings">
              <summary>Voice & privacy settings</summary>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={speechConsent}
                  disabled={audioBusy || speechState === 'speaking'}
                  onChange={(e) => onSpeechConsent(e.target.checked)}
                />
                <span>
                  Use Azure voice. Send audio and interviewer text to Microsoft Speech. With this
                  off, voice uses local services only.
                </span>
              </label>
            </details>
          </section>
          <div className="session-controls">
            {busy && (
              <button className="text-button" onClick={() => void control('cancel')}>
                <Square size={14} /> Stop thinking
              </button>
            )}
            <button
              className="text-button"
              disabled={speechState === 'transcribing'}
              onClick={() => void control(paused ? 'resume' : 'pause')}
            >
              {paused ? <Play size={15} /> : <Pause size={15} />}
              {paused ? 'Resume practice' : 'Pause'}
            </button>
            <button
              className="text-button"
              disabled={busy || paused || audioBusy}
              onClick={() => {
                setAutoSendIn(null);
                setTranscript('');
                setMetrics(null);
                setElapsed(0);
                setStarted(false);
              }}
            >
              <RotateCcw size={15} /> Clear draft
            </button>
            <button
              className="text-button"
              disabled={busy || paused || audioBusy}
              onClick={() => void control('skip')}
            >
              <SkipForward size={15} /> Skip question
            </button>
            <button
              className="text-button finish"
              disabled={recording || speechState === 'transcribing'}
              onClick={() => void control('end')}
            >
              Finish & review <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
