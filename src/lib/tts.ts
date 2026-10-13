
export interface TtsSettings {
  rate?: number;
  speed?: number;
  pitch?: number;
  volume?: number;
  lang?: string;
  language?: string;
}

type Callback = (...args: unknown[]) => void;

let speechLines: string[] = [];
let currentLineIndex = 0;
let currentSettings: object = {};
let currentCallbacks: object = {};

let runId = 0;
let isActive = false;
let isPaused = false;

function getSpeechSynthesis(): SpeechSynthesis | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if (!('speechSynthesis' in window)) {
    return null;
  }

  return window.speechSynthesis;
}

function readSetting(
  settings: object,
  names: string[],
): unknown {
  const values = settings as Record<string, unknown>;

  for (const name of names) {
    if (values[name] !== undefined && values[name] !== null) {
      return values[name];
    }
  }

  return undefined;
}

function readNumber(
  settings: object,
  names: string[],
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = readSetting(settings, names);
  const parsed = Number(value);

  if (value === undefined || !Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

function invokeCallback(
  callbacks: object,
  names: string[],
  ...args: unknown[]
): void {
  const values = callbacks as Record<string, unknown>;

  for (const name of names) {
    const callback = values[name];

    if (typeof callback === 'function') {
      (callback as Callback)(...args);
      return;
    }
  }
}

function setStatus(status: string): void {
  invokeCallback(
    currentCallbacks,
    ['onStatus', 'onStatusChange', 'onStatusUpdate', 'setStatus'],
    status,
  );
}

function updateLine(index: number): void {
  invokeCallback(
    currentCallbacks,
    [
      'onLineChange',
      'onCurrentLineChange',
      'onLine',
      'setCurrentLineIndex',
    ],
    index,
  );
}

function reportError(message: string): void {
  invokeCallback(
    currentCallbacks,
    ['onError', 'onTtsError'],
    message,
  );
}

function finishRecitation(token: number): void {
  if (token !== runId || !isActive) {
    return;
  }

  isActive = false;
  isPaused = false;

  setStatus('वाचन पूर्ण हुआ');

  invokeCallback(
    currentCallbacks,
    ['onEnd', 'onComplete', 'onFinished', 'onRecitationComplete'],
  );
}

function speakCurrentLine(token: number): void {
  if (token !== runId || !isActive || isPaused) {
    return;
  }

  if (currentLineIndex >= speechLines.length) {
    finishRecitation(token);
    return;
  }

  const synthesis = getSpeechSynthesis();

  if (!synthesis || typeof SpeechSynthesisUtterance === 'undefined') {
    isActive = false;
    isPaused = false;

    const message =
      'इस ब्राउज़र में Speech Synthesis API उपलब्ध नहीं है।';

    setStatus(message);
    reportError(message);
    return;
  }

  const text = speechLines[currentLineIndex];

  const utterance = new SpeechSynthesisUtterance(text);

  const requestedLanguage = readSetting(
    currentSettings,
    ['lang', 'language', 'voiceLanguage'],
  );

  utterance.lang =
    typeof requestedLanguage === 'string' && requestedLanguage.trim()
      ? requestedLanguage.trim()
      : 'hi-IN';

  utterance.rate = readNumber(
    currentSettings,
    ['rate', 'speed', 'speakingRate'],
    1,
    0.1,
    10,
  );

  utterance.pitch = readNumber(
    currentSettings,
    ['pitch', 'voicePitch'],
    1,
    0,
    2,
  );

  utterance.volume = readNumber(
    currentSettings,
    ['volume'],
    1,
    0,
    1,
  );

  const voices = synthesis.getVoices();
  const desiredLanguage = utterance.lang.toLowerCase();
  const languagePrefix = desiredLanguage.split('-')[0];

  const voice =
    voices.find(
      (item) => item.lang.toLowerCase() === desiredLanguage,
    ) ??
    voices.find(
      (item) =>
        item.lang.toLowerCase().split('-')[0] === languagePrefix,
    );

  if (voice) {
    utterance.voice = voice;
  }

  utterance.onstart = () => {
    if (token !== runId || !isActive) {
      return;
    }

    updateLine(currentLineIndex);
    setStatus('वाचन जारी है');
  };

  utterance.onend = () => {
    if (token !== runId || !isActive) {
      return;
    }

    currentLineIndex += 1;

    if (currentLineIndex < speechLines.length) {
      speakCurrentLine(token);
    } else {
      finishRecitation(token);
    }
  };

  utterance.onerror = (event) => {
    if (token !== runId || !isActive) {
      return;
    }

    isActive = false;
    isPaused = false;

    const message =
      `वाचन में त्रुटि आई: ${event.error}`;

    setStatus(message);
    reportError(message);
  };

  try {
    synthesis.speak(utterance);
  } catch (error) {
    if (token !== runId) {
      return;
    }

    isActive = false;
    isPaused = false;

    const message =
      error instanceof Error
        ? error.message
        : 'ब्राउज़र वाचन शुरू नहीं कर सका।';

    setStatus(message);
    reportError(message);
  }
}

export function startRecitation(
  lines: readonly string[],
  settings: object = {},
  callbacks: object = {},
): void {
  const synthesis = getSpeechSynthesis();

  runId += 1;
  const token = runId;

  if (synthesis) {
    synthesis.cancel();
  }

  speechLines = lines.filter(
    (line) => typeof line === 'string' && line.trim().length > 0,
  );

  currentLineIndex = 0;
  currentSettings = settings;
  currentCallbacks = callbacks;

  isPaused = false;
  isActive = true;

  if (speechLines.length === 0) {
    isActive = false;
    setStatus('वाचन के लिए कोई पाठ उपलब्ध नहीं है');
    return;
  }

  if (!synthesis) {
    isActive = false;

    const message =
      'इस ब्राउज़र में Speech Synthesis API उपलब्ध नहीं है।';

    setStatus(message);
    reportError(message);
    return;
  }

  setStatus('वाचन शुरू हो रहा है');
  speakCurrentLine(token);
}

export function pauseRecitation(): void {
  const synthesis = getSpeechSynthesis();

  if (!synthesis || !isActive || isPaused) {
    return;
  }

  synthesis.pause();
  isPaused = true;
  setStatus('वाचन रोका गया है');
}

export function resumeRecitation(): void {
  const synthesis = getSpeechSynthesis();

  if (!synthesis || !isActive || !isPaused) {
    return;
  }

  isPaused = false;
  synthesis.resume();
  setStatus('वाचन जारी है');
}

export function stopRecitation(): void {
  runId += 1;

  const synthesis = getSpeechSynthesis();

  if (synthesis) {
    synthesis.cancel();
  }

  isActive = false;
  isPaused = false;
  currentLineIndex = 0;
  speechLines = [];

  setStatus('वाचन रोक दिया गया है');

  invokeCallback(
    currentCallbacks,
    ['onStop', 'onStopped'],
  );
}
