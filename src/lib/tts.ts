export interface TtsSettings {
  rate?: number;
  speed?: number;
  pitch?: number;
  volume?: number;
  lang?: string;
  language?: string;
}

type Callback = (...args: unknown[]) => void;

interface SpeechEntry {
  text: string;
  sourceIndex: number;
}

let speechQueue: SpeechEntry[] = [];
let currentSpeechIndex = 0;
let currentSettings: TtsSettings = {};
let currentCallbacks: object = {};
let currentVoice: SpeechSynthesisVoice | null = null;

let runId = 0;
let isActive = false;
let isPaused = false;

/**
 * Browser Speech Synthesis उपलब्ध है या नहीं, जाँचें।
 */
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

/**
 * केवल श्लोक के स्पष्ट संख्यात्मक क्रमांक हटाएँ।
 *
 * उदाहरण:
 *   ॥१॥, ॥ १२ ॥, ।३।  -> वाचन से हटेंगे।
 *
 * मूल पाठ, संयुक्ताक्षर तथा वैदिक स्वर-चिह्नों को जानबूझकर
 * नहीं हटाया या बदला जाता है।
 *
 * sourceIndex सुरक्षित रखने से स्क्रीन पर मूल पंक्ति और
 * वाचन की पंक्ति का संबंध बना रहता है।
 */
function prepareSpeechText(source: string): string {
  return source
    .replace(
      /(?:॥\s*[०-९0-9]+\s*॥|।\s*[०-९0-9]+\s*।)/gu,
      ' ',
    )
    .replace(
      /^\s*[(（]?\s*[०-९0-9]+\s*[)）.]?\s*$/u,
      '',
    )
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

/**
 * ब्राउज़र के उपलब्ध हिंदी/Sanskrit-संबंधी विकल्पों में
 * महिला आवाज़ के संभावित संकेतों को प्राथमिकता दें।
 *
 * SpeechSynthesisVoice में मानकीकृत gender property नहीं है।
 * इसलिए आवाज़ के नाम से किया गया चयन अनुमान-आधारित है,
 * महिला आवाज़ की गारंटी नहीं।
 */
function choosePreferredVoice(
  voices: SpeechSynthesisVoice[],
  requestedLanguage: string,
): SpeechSynthesisVoice | null {
  if (voices.length === 0) {
    return null;
  }

  const normalizedLanguage = requestedLanguage
    .trim()
    .toLowerCase();

  const requestedPrefix =
    normalizedLanguage.split('-')[0] || 'hi';

  let candidates = voices.filter(
    (voice) =>
      voice.lang.toLowerCase().split('-')[0] ===
      requestedPrefix,
  );

  /*
   * यदि Sanskrit voice उपलब्ध नहीं है, तो संस्कृत पाठ के
   * लिए हिंदी आवाज़ एक व्यावहारिक fallback हो सकती है।
   */
  if (candidates.length === 0 && requestedPrefix === 'sa') {
    candidates = voices.filter(
      (voice) =>
        voice.lang.toLowerCase().split('-')[0] === 'hi',
    );
  }

  if (candidates.length === 0) {
    return null;
  }

  const femaleVoiceHints =
    /female|woman|zira|heera|kalpana|swara|priya|neerja|lekha|aarti|aditi|samantha|veena|kavya|anjali/i;

  const likelyFemaleVoiceHints =
    /(?:wavenet|neural|standard)[\s_-]*a(?:\b|$)/i;

  const scoreVoice = (
    voice: SpeechSynthesisVoice,
  ): number => {
    const language = voice.lang.toLowerCase();
    const voiceName = `${voice.name} ${voice.voiceURI}`;

    let score = 0;

    if (language === normalizedLanguage) {
      score += 25;
    }

    if (femaleVoiceHints.test(voiceName)) {
      score += 100;
    } else if (likelyFemaleVoiceHints.test(voiceName)) {
      score += 60;
    }

    if (voice.localService) {
      score += 3;
    }

    if (voice.default) {
      score += 1;
    }

    return score;
  };

  return candidates.reduce((best, candidate) =>
    scoreVoice(candidate) > scoreVoice(best)
      ? candidate
      : best,
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

function failRecitation(
  token: number,
  message: string,
): void {
  if (token !== runId) {
    return;
  }

  isActive = false;
  isPaused = false;

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

  if (
    !synthesis ||
    typeof SpeechSynthesisUtterance === 'undefined'
  ) {
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

  const utterance = new SpeechSynthesisUtterance(
    entry.text,
  );

  const requestedLanguage = getRequestedLanguage();

  utterance.lang = requestedLanguage;

  /*
   * यदि ब्राउज़र ने आवाज़ें देर से उपलब्ध कराई हों, तो
   * अगले वाचन चरण पर फिर विकल्प जाँचें।
   */
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

  /*
   * UI में दिखाई गई rate, pitch और volume सेटिंग लागू करें।
   * Browser TTS की सीमा से बाहर प्राकृतिक संगीतात्मकता
   * या वैदिक स्वराघात यहाँ से गारंटी नहीं किए जा सकते।
   */
  utterance.rate = readNumber(
    currentSettings,
    ['rate', 'speed', 'speakingRate'],
    0.9,
    0.1,
    10,
  );

  utterance.pitch = readNumber(
    currentSettings,
    ['pitch', 'voicePitch'],
    1.0,
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

  utterance.onstart = () => {
    if (token !== runId || !isActive) {
      return;
    }

    updateLine(entry.sourceIndex);
    setStatus('वाचन जारी है');
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

    failRecitation(
      token,
      `वाचन में त्रुटि आई: ${event.error}`,
    );
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

export function startRecitation(
  lines: readonly string[],
  settings: object = {},
  callbacks: object = {},
): void {
  const synthesis = getSpeechSynthesis();

  /*
   * नए वाचन को पुराने वाचन से अलग पहचानें, ताकि पुराने
   * utterance के देर से आए events नए वाचन को न बदलें।
   */
  runId += 1;
  const token = runId;

  if (synthesis) {
    synthesis.cancel();
  }

  currentSettings = settings as TtsSettings;
  currentCallbacks = callbacks;
  currentSpeechIndex = 0;
  currentVoice = null;

  const requestedLanguage = getRequestedLanguage();

  currentVoice = synthesis
    ? choosePreferredVoice(
        synthesis.getVoices(),
        requestedLanguage,
      )
    : null;

  /*
   * मूल पंक्ति का index सुरक्षित रहता है, लेकिन उसके बोलने
   * वाले पाठ से श्लोक-क्रमांक हटाया जाता है।
   */
  speechQueue = lines
    .map((line, sourceIndex): SpeechEntry | null => {
      if (typeof line !== 'string') {
        return null;
      }

      const text = prepareSpeechText(line);

      if (!text) {
        return null;
      }

      return {
        text,
        sourceIndex,
      };
    })
    .filter(
      (entry): entry is SpeechEntry => entry !== null,
    );

  isPaused = false;
  isActive = true;

  if (speechQueue.length === 0) {
    isActive = false;

    const message =
      'वाचन के लिए कोई पढ़ने योग्य पाठ नहीं बचा। पाठ और श्लोक-क्रमांक जाँचें।';

    setStatus(message);
    reportError(message);
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
  /*
   * पहले token बदलें, फिर cancel करें ताकि पुराने callbacks
   * वर्तमान वाचन की स्थिति को बदल न सकें।
   */
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

  setStatus('वाचन रोक दिया गया है');

  invokeCallback(
    currentCallbacks,
    ['onStop', 'onStopped'],
  );
}
