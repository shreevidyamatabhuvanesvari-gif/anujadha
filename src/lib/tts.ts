export interface TtsSettings {
  rate?: number;
  speed?: number;
  pitch?: number;
  volume?: number;
  lang?: string;
  language?: string;
}

type Callback = (...args: unknown[]) => void;

interface SpeechSegment {
  sourceIndex: number;
  start: number;
  end: number;
}

interface SpeechEntry {
  text: string;
  segments: SpeechSegment[];
}

interface PreparedLine {
  text: string;
  sourceIndex: number;
}

interface PronunciationEntry {
  surface: string;
  domain?: string;
  iast?: string;
  pronunciationHint?: string;
  hintHi?: string;
  ttsCandidate?: string | null;
  candidateStatus?: string;
  pronunciationVerified?: boolean;
  autoApply?: boolean;
}

interface PronunciationDictionary {
  id?: unknown;
  schemaVersion?: unknown;
  lexiconEntries?: unknown;
}

let speechQueue: SpeechEntry[] = [];
let currentSpeechIndex = 0;
let currentSettings: TtsSettings = {};
let currentCallbacks: object = {};
let currentVoice: SpeechSynthesisVoice | null = null;

let runId = 0;
let isActive = false;
let isPaused = false;
let isQueueReady = false;

let cachedPronunciationEntries: PronunciationEntry[] | null = null;
let pronunciationDictionaryPromise: Promise<PronunciationEntry[]> | null = null;

const MAX_UTTERANCE_CHARS = 180;

/*
 * JSON फ़ाइल repository के root में language/ फ़ोल्डर में है।
 * Vite इस dynamic import को स्थानीय bundled module में बदलेगा।
 * Runtime पर लोड विफल होने पर मूल पाठ से वाचन जारी रहेगा।
 */
async function importPronunciationDictionaryModule(): Promise<unknown> {
  // @ts-ignore Vite JSON module resolve करता है; runtime failure catch किया जाएगा।
  const loadedModule: unknown = await import(
    '../../language/sanskrit-vedic-pronunciation.json'
  );

  if (isRecord(loadedModule) && 'default' in loadedModule) {
    return loadedModule.default;
  }

  return loadedModule;
}

function getSpeechSynthesis(): SpeechSynthesis | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if (!('speechSynthesis' in window)) {
    return null;
  }

  return window.speechSynthesis;
}

function readSetting(settings: object, names: string[]): unknown {
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
  invokeCallback(currentCallbacks, ['onError', 'onTtsError'], message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isPronunciationEntry(value: unknown): value is PronunciationEntry {
  return (
    isRecord(value) &&
    typeof value.surface === 'string' &&
    value.surface.length > 0
  );
}

/**
 * स्थानीय उच्चारण-शब्दकोश को एक बार लोड और validate करें।
 *
 * ध्यान दें:
 * - pronunciationHint स्वयं आवाज़ को प्रशिक्षित नहीं करता।
 * - IAST स्वयं उच्चारण की शुद्धता प्रमाणित नहीं करता।
 * - केवल सत्यापित और स्पष्ट रूप से अनुमोदित ttsCandidate लागू होगा।
 */
async function loadPronunciationDictionary(): Promise<PronunciationEntry[]> {
  if (cachedPronunciationEntries !== null) {
    return cachedPronunciationEntries;
  }

  if (pronunciationDictionaryPromise) {
    return pronunciationDictionaryPromise;
  }

  pronunciationDictionaryPromise = importPronunciationDictionaryModule()
    .then((raw: unknown): PronunciationEntry[] => {
      if (!isRecord(raw)) {
        throw new Error('JSON root must be an object');
      }

      const dictionary = raw as PronunciationDictionary;

      if (
        dictionary.id !== 'sanskrit-vedic-pronunciation' ||
        !Array.isArray(dictionary.lexiconEntries)
      ) {
        throw new Error(
          'Unexpected dictionary id or missing lexiconEntries',
        );
      }

      const entries =
        dictionary.lexiconEntries.filter(isPronunciationEntry);

      if (entries.length === 0) {
        throw new Error('No valid lexicon entries found');
      }

      cachedPronunciationEntries = entries;
      return entries;
    })
    .catch((error: unknown): PronunciationEntry[] => {
      pronunciationDictionaryPromise = null;

      console.warn(
        '[श्रुति] उच्चारण शब्दकोश लोड नहीं हुआ; मूल पाठ से वाचन जारी रहेगा।',
        error,
      );

      return [];
    });

  return pronunciationDictionaryPromise;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * केवल उन उच्चारण-सुझावों को लागू करें जिनकी दोनों अनुमतियाँ
 * स्पष्ट रूप से true हैं।
 *
 * Original display text अलग रहता है। यह फ़ंक्शन केवल TTS के
 * लिए तैयार किए जा रहे पाठ पर काम करता है।
 */
function applyApprovedPronunciationCandidates(
  source: string,
  dictionaryEntries: readonly PronunciationEntry[],
): string {
  const approved = dictionaryEntries
    .filter(
      (entry) =>
        entry.autoApply === true &&
        entry.pronunciationVerified === true &&
        typeof entry.ttsCandidate === 'string' &&
        entry.ttsCandidate.length > 0 &&
        entry.ttsCandidate !== entry.surface,
    )
    .sort((a, b) => b.surface.length - a.surface.length);

  let result = source;

  for (const entry of approved) {
    const surface = entry.surface;
    const candidate = entry.ttsCandidate;

    if (!candidate) {
      continue;
    }

    /*
     * Unicode-aware boundaries शब्द के किसी बड़े शब्द के भीतर
     * अनचाहे replacement से बचाती हैं।
     */
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{M}\\p{N}])(${escapeRegExp(surface)})(?=$|[^\\p{L}\\p{M}\\p{N}])`,
      'gu',
    );

    result = result.replace(
      pattern,
      (_match: string, prefix: string) => `${prefix}${candidate}`,
    );
  }

  return result;
}

/**
 * TTS पाठ तैयार करें:
 * - स्पष्ट श्लोक-क्रमांक आवाज़ में न पढ़ें।
 * - क्रमांक हटाने के बाद विराम बनाए रखें।
 * - अनुस्वार, चन्द्रबिन्दु, विसर्ग और वैदिक स्वर-चिह्नों को
 *   किसी सामान्य replacement से न हटाएँ।
 * - केवल dictionary से अनुमोदित candidate लागू करें।
 */
function prepareSpeechText(
  source: string,
  dictionaryEntries: readonly PronunciationEntry[],
): string {
  const withoutVerseNumber = source
    .replace(/॥\s*[०-९0-9]+\s*॥/gu, '।')
    .replace(/।\s*[०-९0-9]+\s*।/gu, '।')
    .replace(/^\s*[(（]?\s*[०-९0-9]+\s*[)）.]?\s*$/u, '')
    .replace(/[ \t]+/gu, ' ')
    .replace(/^\s*(?:॥|।)+\s*$/u, '')
    .trim();

  if (!withoutVerseNumber) {
    return '';
  }

  return applyApprovedPronunciationCandidates(
    withoutVerseNumber,
    dictionaryEntries,
  );
}

/**
 * उपलब्ध हिंदी/Sanskrit आवाज़ों में महिला-स्वर के संभावित
 * नाम-संकेतों वाली आवाज़ को प्राथमिकता दें।
 *
 * SpeechSynthesisVoice में मानकीकृत gender property नहीं है,
 * इसलिए नाम-आधारित चयन अनुमान है, सुनिश्चित पहचान नहीं।
 */
function choosePreferredVoice(
  voices: SpeechSynthesisVoice[],
  requestedLanguage: string,
): SpeechSynthesisVoice | null {
  if (voices.length === 0) {
    return null;
  }

  const normalizedLanguage = requestedLanguage.trim().toLowerCase();
  const requestedPrefix = normalizedLanguage.split('-')[0] || 'hi';

  let candidates = voices.filter(
    (voice) =>
      voice.lang.toLowerCase().split('-')[0] === requestedPrefix,
  );

  if (candidates.length === 0 && requestedPrefix === 'sa') {
    candidates = voices.filter(
      (voice) => voice.lang.toLowerCase().split('-')[0] === 'hi',
    );
  }

  if (candidates.length === 0) {
    return null;
  }

  const femaleVoiceHints =
    /female|woman|zira|heera|kalpana|swara|priya|neerja|lekha|aarti|aditi|samantha|veena|kavya|anjali|sara/i;

  const naturalVoiceHints = /neural|natural|wavenet/i;

  const scoreVoice = (voice: SpeechSynthesisVoice): number => {
    const language = voice.lang.toLowerCase();
    const voiceName = `${voice.name} ${voice.voiceURI}`;
    let score = 0;

    if (language === normalizedLanguage) score += 25;
    if (femaleVoiceHints.test(voiceName)) score += 100;
    if (naturalVoiceHints.test(voiceName)) score += 15;
    if (voice.localService) score += 3;
    if (voice.default) score += 1;

    return score;
  };

  return candidates.reduce((best, candidate) =>
    scoreVoice(candidate) > scoreVoice(best) ? candidate : best,
  );
}

function getRequestedLanguage(): string {
  const requestedLanguage = readSetting(
    currentSettings,
    ['lang', 'language', 'voiceLanguage'],
  );

  if (
    typeof requestedLanguage === 'string' &&
    requestedLanguage.trim()
  ) {
    return requestedLanguage.trim();
  }

  return 'hi-IN';
}

/**
 * दृश्य पाठ की पंक्तियों को वाचन-अंशों में समूहित करें।
 * मूल पंक्ति का index सुरक्षित रहता है।
 * पंक्ति-अंत hyphen पर अगली पंक्ति को उसी utterance में
 * जोड़ा जाता है, ताकि केवल formatting के कारण विराम न आए।
 */
function buildSpeechQueue(
  lines: readonly string[],
  dictionaryEntries: readonly PronunciationEntry[],
): SpeechEntry[] {
  const prepared: PreparedLine[] = [];

  lines.forEach((line, sourceIndex) => {
    if (typeof line !== 'string') {
      return;
    }

    const text = prepareSpeechText(line, dictionaryEntries);

    if (!text) {
      return;
    }

    prepared.push({ text, sourceIndex });
  });

  const linkedEntries: SpeechEntry[] = [];

  for (let i = 0; i < prepared.length; i += 1) {
    const first = prepared[i];

    if (!first) {
      continue;
    }

    let text = first.text;

    const segments: SpeechSegment[] = [
      {
        sourceIndex: first.sourceIndex,
        start: 0,
        end: text.length,
      },
    ];

    while (/-\s*$/u.test(text) && i + 1 < prepared.length) {
      text = text.replace(/-\s*$/u, '').trimEnd();

      const previousSegment = segments[segments.length - 1];

      if (previousSegment) {
        previousSegment.end = Math.min(
          previousSegment.end,
          text.length,
        );
      }

      const next = prepared[i + 1];

      if (!next) {
        break;
      }

      i += 1;

      const separator = text.length > 0 ? ' ' : '';
      const start = text.length + separator.length;

      text += separator + next.text;

      segments.push({
        sourceIndex: next.sourceIndex,
        start,
        end: start + next.text.length,
      });
    }

    if (text.trim()) {
      linkedEntries.push({ text: text.trim(), segments });
    }
  }

  const result: SpeechEntry[] = [];
  let currentText = '';
  let currentSegments: SpeechSegment[] = [];

  const flushCurrent = (): void => {
    const text = currentText.trim();

    if (text) {
      result.push({
        text,
        segments: currentSegments,
      });
    }

    currentText = '';
    currentSegments = [];
  };

  for (const entry of linkedEntries) {
    const separator = currentText ? ' ' : '';
    const offset = currentText.length + separator.length;

    currentText += separator + entry.text;

    currentSegments.push(
      ...entry.segments.map((segment) => ({
        sourceIndex: segment.sourceIndex,
        start: segment.start + offset,
        end: segment.end + offset,
      })),
    );

    const endsAtPunctuation = /[।॥.!?;:…]\s*$/u.test(entry.text);
    const reachedLengthLimit =
      currentText.length >= MAX_UTTERANCE_CHARS;

    if (endsAtPunctuation || reachedLengthLimit) {
      flushCurrent();
    }
  }

  flushCurrent();

  return result;
}

function findSourceIndex(
  entry: SpeechEntry,
  charIndex: number,
): number {
  if (entry.segments.length === 0) {
    return 0;
  }

  let previous = entry.segments[0];

  for (const segment of entry.segments) {
    if (charIndex >= segment.start && charIndex < segment.end) {
      return segment.sourceIndex;
    }

    if (segment.start > charIndex) {
      return previous.sourceIndex;
    }

    previous = segment;
  }

  return previous.sourceIndex;
}

function finishRecitation(token: number): void {
  if (token !== runId || !isActive) {
    return;
  }

  isActive = false;
  isPaused = false;
  isQueueReady = false;

  setStatus('वाचन पूर्ण हुआ');

  invokeCallback(
    currentCallbacks,
    ['onEnd', 'onComplete', 'onFinished', 'onRecitationComplete'],
  );
}

function failRecitation(token: number, message: string): void {
  if (token !== runId) {
    return;
  }

  isActive = false;
  isPaused = false;
  isQueueReady = false;

  setStatus(message);
  reportError(message);
}

function speakCurrentLine(token: number): void {
  if (token !== runId || !isActive || isPaused) {
    return;
  }

  if (currentSpeechIndex >= speechQueue.length) {
    finishRecitation(token);
    return;
  }

  const synthesis = getSpeechSynthesis();

  if (!synthesis || typeof SpeechSynthesisUtterance === 'undefined') {
    failRecitation(
      token,
      'इस ब्राउज़र में Speech Synthesis API उपलब्ध नहीं है।',
    );
    return;
  }

  const entry = speechQueue[currentSpeechIndex];

  if (!entry) {
    finishRecitation(token);
    return;
  }

  const utterance = new SpeechSynthesisUtterance(entry.text);
  const requestedLanguage = getRequestedLanguage();

  utterance.lang = requestedLanguage;

  if (!currentVoice) {
    currentVoice = choosePreferredVoice(
      synthesis.getVoices(),
      requestedLanguage,
    );
  }

  if (currentVoice) {
    utterance.voice = currentVoice;

    if (currentVoice.lang) {
      utterance.lang = currentVoice.lang;
    }
  }

  utterance.rate = readNumber(
    currentSettings,
    ['rate', 'speed', 'speakingRate'],
    0.86,
    0.1,
    10,
  );

  utterance.pitch = readNumber(
    currentSettings,
    ['pitch', 'voicePitch'],
    1.04,
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

  let lastReportedIndex = -1;

  const reportCurrentSourceLine = (index: number): void => {
    if (index === lastReportedIndex) {
      return;
    }

    lastReportedIndex = index;
    updateLine(index);
  };

  utterance.onstart = () => {
    if (token !== runId || !isActive) {
      return;
    }

    const firstSegment = entry.segments[0];

    if (firstSegment) {
      reportCurrentSourceLine(firstSegment.sourceIndex);
    }

    setStatus('वाचन जारी है');
  };

  utterance.onboundary = (event: SpeechSynthesisEvent) => {
    if (token !== runId || !isActive) {
      return;
    }

    if (
      typeof event.charIndex === 'number' &&
      Number.isFinite(event.charIndex)
    ) {
      reportCurrentSourceLine(
        findSourceIndex(entry, event.charIndex),
      );
    }
  };

  utterance.onend = () => {
    if (token !== runId || !isActive) {
      return;
    }

    currentSpeechIndex += 1;
    speakCurrentLine(token);
  };

  utterance.onerror = (event) => {
    if (token !== runId || !isActive) {
      return;
    }

    failRecitation(token, `वाचन में त्रुटि आई: ${event.error}`);
  };

  try {
    synthesis.speak(utterance);
  } catch (error) {
    const message =
      error instanceof Error
        ? `वाचन शुरू नहीं हो सका: ${error.message}`
        : 'ब्राउज़र वाचन शुरू नहीं कर सका।';

    failRecitation(token, message);
  }
}

async function startAfterDictionaryLoad(
  lines: readonly string[],
  token: number,
): Promise<void> {
  const dictionaryEntries = await loadPronunciationDictionary();

  if (token !== runId || !isActive) {
    return;
  }

  speechQueue = buildSpeechQueue(lines, dictionaryEntries);
  currentSpeechIndex = 0;
  isQueueReady = true;

  if (speechQueue.length === 0) {
    isActive = false;
    isQueueReady = false;

    const message =
      'वाचन के लिए कोई पढ़ने योग्य पाठ नहीं बचा। पाठ और श्लोक-क्रमांक जाँचें।';

    setStatus(message);
    reportError(message);
    return;
  }

  const synthesis = getSpeechSynthesis();

  if (!synthesis) {
    failRecitation(
      token,
      'इस ब्राउज़र में Speech Synthesis API उपलब्ध नहीं है।',
    );
    return;
  }

  const requestedLanguage = getRequestedLanguage();

  currentVoice = choosePreferredVoice(
    synthesis.getVoices(),
    requestedLanguage,
  );

  if (dictionaryEntries.length > 0) {
    setStatus(
      `उच्चारण शब्दकोश तैयार है (${dictionaryEntries.length} प्रविष्टियाँ); वाचन शुरू हो रहा है।`,
    );
  } else {
    setStatus(
      'उच्चारण शब्दकोश उपलब्ध नहीं; मूल पाठ से वाचन जारी है।',
    );
  }

  speakCurrentLine(token);
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

  speechQueue = [];
  currentSpeechIndex = 0;
  isQueueReady = false;
  currentSettings = settings as TtsSettings;
  currentCallbacks = callbacks;
  currentVoice = null;
  isPaused = false;
  isActive = true;

  if (!synthesis) {
    isActive = false;

    const message =
      'इस ब्राउज़र में Speech Synthesis API उपलब्ध नहीं है।';

    setStatus(message);
    reportError(message);
    return;
  }

  setStatus('उच्चारण शब्दकोश तैयार किया जा रहा है…');
  void startAfterDictionaryLoad(lines, token);
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

  // यदि Pause शब्दकोश लोड होते समय हुआ था, तो queue शुरू करें।
  if (isQueueReady && !synthesis.speaking && !synthesis.pending) {
    speakCurrentLine(runId);
  }
}

export function stopRecitation(): void {
  runId += 1;

  const synthesis = getSpeechSynthesis();

  if (synthesis) {
    synthesis.cancel();
  }

  isActive = false;
  isPaused = false;
  currentSpeechIndex = 0;
  speechQueue = [];
  currentVoice = null;
  isQueueReady = false;

  setStatus('वाचन रोक दिया गया है');

  invokeCallback(currentCallbacks, ['onStop', 'onStopped']);
}
