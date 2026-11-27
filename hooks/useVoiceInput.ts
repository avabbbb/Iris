// Browser-native Web Speech API hook for Hark / TapNow Voice-to-Agent dictation.
// Zero paid API keys or cloud relay required; gracefully reports `supported = false`
// in browsers without SpeechRecognition.

import { useCallback, useEffect, useRef, useState } from 'react';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0?: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  error?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export interface UseVoiceInputOptions {
  language?: 'en' | 'zho';
  onFinalTranscript: (text: string) => void;
}

export interface UseVoiceInputState {
  supported: boolean;
  listening: boolean;
  interimTranscript: string;
  error: string | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

export function isVoiceInputSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export function useVoiceInput({ language = 'zho', onFinalTranscript }: UseVoiceInputOptions): UseVoiceInputState {
  const supported = getSpeechRecognitionCtor() !== null;
  const [listening, setListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;

  const stop = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.stop(); } catch { /* ignore */ }
    }
    setListening(false);
    setInterimTranscript('');
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setError(language === 'en' ? 'Voice input is not supported in this browser.' : '当前浏览器不支持语音识别（请使用 Chrome / Edge）。');
      return;
    }
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    setError(null);
    setInterimTranscript('');
    const rec = new Ctor();
    rec.lang = language === 'en' ? 'en-US' : 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onstart = () => setListening(true);
    rec.onend = () => {
      setListening(false);
      setInterimTranscript('');
      recognitionRef.current = null;
    };
    rec.onerror = event => {
      const code = event?.error || 'unknown';
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setError(language === 'en' ? 'Microphone permission denied.' : '麦克风权限被拒绝，请在浏览器地址栏允许访问麦克风。');
      } else if (code !== 'aborted' && code !== 'no-speech') {
        setError(language === 'en' ? `Voice input error: ${code}` : `语音识别异常：${code}`);
      }
      setListening(false);
      setInterimTranscript('');
    };
    rec.onresult = event => {
      let interim = '';
      let finalChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const transcript = res?.[0]?.transcript || '';
        if (res?.isFinal) finalChunk += transcript;
        else interim += transcript;
      }
      setInterimTranscript(interim.trim());
      if (finalChunk.trim()) {
        onFinalRef.current(finalChunk.trim());
      }
    };
    recognitionRef.current = rec;
    try {
      rec.start();
    } catch {
      setListening(false);
      setError(language === 'en' ? 'Could not start voice recognition.' : '无法启动语音输入。');
    }
  }, [language]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  useEffect(() => () => {
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
  }, []);

  return { supported, listening, interimTranscript, error, start, stop, toggle };
}
