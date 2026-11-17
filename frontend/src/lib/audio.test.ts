import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEndOfSpeechDetector, encodeWav, recordMicrophone, visemeOpenness } from './audio';

afterEach(() => vi.unstubAllGlobals());

describe('end-of-speech detection for hands-free answers', () => {
  const SPEECH = 0.1;
  const QUIET = 0.001;
  it('does not fire while the speaker has not started talking', () => {
    const detect = createEndOfSpeechDetector({ endSilenceSeconds: 2, minSpeechSeconds: 0.8 });
    const fired = Array.from({ length: 50 }, () => detect(QUIET, 0.1));
    expect(fired.some(Boolean)).toBe(false);
  });
  it('fires once after enough speech followed by sustained silence', () => {
    const detect = createEndOfSpeechDetector({ endSilenceSeconds: 2, minSpeechSeconds: 0.8 });
    for (let i = 0; i < 10; i++) expect(detect(SPEECH, 0.1)).toBe(false);
    const quiet = Array.from({ length: 19 }, () => detect(QUIET, 0.1));
    expect(quiet.some(Boolean)).toBe(false);
    expect(detect(QUIET, 0.1)).toBe(true);
    expect(detect(QUIET, 0.1)).toBe(false);
  });
  it('resets the silence clock when the speaker resumes mid-pause', () => {
    const detect = createEndOfSpeechDetector({ endSilenceSeconds: 2, minSpeechSeconds: 0.8 });
    for (let i = 0; i < 10; i++) detect(SPEECH, 0.1);
    for (let i = 0; i < 15; i++) detect(QUIET, 0.1);
    detect(SPEECH, 0.1);
    const quiet = Array.from({ length: 19 }, () => detect(QUIET, 0.1));
    expect(quiet.some(Boolean)).toBe(false);
  });
  it('ignores a cough shorter than the minimum speech length', () => {
    const detect = createEndOfSpeechDetector({ endSilenceSeconds: 2, minSpeechSeconds: 0.8 });
    detect(SPEECH, 0.2);
    const quiet = Array.from({ length: 40 }, () => detect(QUIET, 0.1));
    expect(quiet.some(Boolean)).toBe(false);
  });
});

describe('local audio encoding', () => {
  it('writes a mono PCM WAV with a valid 16 kHz header', () => {
    const wav = encodeWav([new Float32Array([0, 0.5, -0.5, 1])], 16000);
    const header = new DataView(wav);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(header.getUint32(24, true)).toBe(16000);
    expect(header.getUint16(22, true)).toBe(1);
    expect(header.getUint32(40, true)).toBe(8);
    expect(header.getInt16(46, true)).toBe(16383);
  });
  it('closes the mouth for silence and bounded consonants', () => {
    expect(visemeOpenness(0)).toBe(0);
    expect(visemeOpenness(21)).toBe(0.08);
    expect(visemeOpenness(1)).toBeGreaterThan(0.5);
  });
  it('releases microphone permission if audio initialization fails', async () => {
    const stop = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) },
    });
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('Audio device unavailable');
        }
      },
    );
    await expect(recordMicrophone(vi.fn())).rejects.toThrow('Audio device unavailable');
    expect(stop).toHaveBeenCalledOnce();
  });
});
