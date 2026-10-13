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

let speechQueue: SpeechEntry[] = [];
let currentSpeechIndex = 0;
let currentSettings: TtsSettings = {};
let currentCallbacks: object = {};
let currentVoice: SpeechSynthesisVoice | null = null;

let runId = 0;
let isActive = false;
let isPaused = false;

const MAX_UTTERANCE_CHARS = 180;

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
 * वाचन-पाठ की तैयारी।
 *
 * 1. श्लोक के संख्यात्मक क्रमांक आवाज़ से हटाएँ।
 * 2. क्रमांक हटाते समय श्लोक-अंत का विराम सुरक्षित रखें।
 * 3. "लम्बितां" के लिए लक्षित उच्चारण-सुधार करें।
 * 4. वैदिक स्वर-चिह्नों और अन्य देवनागरी चिह्नों को
 *    सामान्य रूप से न हटाएँ।
 *
 * यह केवल TTS के लिए तैयार किया गया पाठ है।
 * मूल स्क्रीन-पाठ अपरिवर्तित रहता है।
 */
function prepareSpeechText(source: string): string {
  return source
    .replace(
      /॥\s*[०-९0-9]+\s*॥/gu,
      '।',
    )
    .replace(
      /।\s*[०-९0-9]+\s*।/gu,
      '।',
    )
    .replace(
      /^\s*[(（]?\s*[०-९0-9]+\s*[)）.]?\s*$/u,
      '',
    )
    /*
     * "लम्बितां" का अंतिम "ां" कई हिंदी TTS आवाज़ों में
     * पर्याप्त स्पष्ट नहीं सुनाई दे सकता है।
     * "लम्बिताम्" उसका लक्षित वाचन-रूप है।
     */
    .replace(/लम्बितां/gu, 'लम्बिताम्')
    .replace(/[ \t]+/gu, ' ')
    .replace(/^\s*(?:॥|।)+\s*$/u, '')
    .trim();
}

/**
 * उपलब्ध आवाज़ों में पहले उपयुक्त भाषा चुनें और फिर
 * महिला होने के संभावित संकेतों वाली आवाज़ को प्राथमिकता दें।
 *
 * SpeechSynthesisVoice में मानकीकृत gender property नहीं है।
 * नाम-आधारित चयन अनुमान है, सुनिश्चित पहचान नहीं।
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
   * Sanskrit voice नहीं मिलने पर हिंदी आवाज़ को fallback
   * के रूप में इस्तेमाल करने की कोशिश करें।
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
    /female|woman|zira|heera|kalpana|swara|priya|neerja|lekha|aarti|aditi|samantha|veena|kavya|anjali|sara/i;

  const naturalVoiceHints =
    /neural|natural|wavenet/i;

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
    }

    if (naturalVoiceHints.test(voiceName)) {
      score += 15;
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

/**
 * मूल पाठ की पंक्तियों को वाचन-अंशों में बदलें।
 *
 * - अन्त में hyphen वाली पंक्ति अगली पंक्ति से जोड़ी जाती है।
 * - ऐसे जुड़े हुए अंश एक ही utterance में पढ़े जाते हैं।
 * - सामान्य पंक्तियों को वाक्य/श्लोक-विराम पर समूहित किया जाता है।
 * - प्रत्येक शब्द के स्रोत-पंक्ति इंडेक्स को सुरक्षित रखा जाता है,
 *   ताकि उपलब्ध होने पर onboundary से कैप्शन बदला जा सके।
 */
function buildSpeechQueue(
  lines: readonly string[],
): SpeechEntry[] {
  const prepared: PreparedLine[] = [];

  lines.forEach((line, sourceIndex) => {
    if (typeof line !== 'string') {
      return;
    }

    const text = prepareSpeechText(line);

    if (!text) {
      return;
    }

    prepared.push({
      text,
      sourceIndex,
    });
  });

  /*
   * पहले हाइफ़न से जुड़ी पंक्तियों को एक वाचन-अंश में
   * मिलाएँ। हाइफ़न पर कृत्रिम विराम न रहे।
   */
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

      /*
       * हटाए गए हाइफ़न का स्थान कैप्शन मैपिंग में न गिनें।
       */
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
      linkedEntries.push({
        text: text.trim(),
        segments,
      });
    }
  }

  /*
   * छोटे-छोटे chunks के कारण बार-बार नया TTS utterance
   * शुरू न करना पड़े। वाक्य या श्लोक के विराम पर समूह बंद करें।
   */
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

    const endsAtPunctuation =
      /[।॥.!?;:…]\s*$/u.test(entry.text);

    const reachedLengthLimit =
      currentText.length >= MAX_UTTERANCE_CHARS;

    if (endsAtPunctuation || reachedLengthLimit) {
      flushCurrent();
    }
  }

  flushCurrent();

  return result;
}

/**
 * TTS के boundary event के character offset के आधार पर
 * वर्तमान कैप्शन की स्रोत-पंक्ति ढूँढ़ें।
 *
 * कुछ ब्राउज़र/आवाज़ें boundary events नहीं भेजतीं;
 * इसलिए कैप्शन अपडेट होने की पूर्ण गारंटी नहीं है।
 */
function findSourceIndex(
  entry: SpeechEntry,
  charIndex: number,
): number {
  if (entry.segments.length === 0) {
    return 0;
  }

  let previous = entry.segments[0];

  for (const segment of entry.segments) {
    if (
      charIndex >= segment.start &&
      charIndex < segment.end
    ) {
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

  const utterance = new SpeechSynthesisUtterance(entry.text);

  const requestedLanguage = getRequestedLanguage();
  utterance.lang = requestedLanguage;

  /*
   * आवाज़ें पहले अनुपलब्ध रही हों तो पुनः जाँचें।
   * आवाज़ें उपलब्ध न होने पर ब्राउज़र की डिफ़ॉल्ट आवाज़ चलेगी।
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
   * ऐप की मौजूदा गति, पिच और वॉल्यूम सेटिंग का सम्मान करें।
   * ब्राउज़र API से वास्तविक साँस की ध्वनि या मनचाहा timbre
   * पैदा नहीं किया जा सकता।
   */
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

  /*
   * जहाँ ब्राउज़र word-boundary events भेजता है, वहाँ
   * बोलते समय कैप्शन की स्रोत-पंक्ति भी बदल सकती है।
   */
  utterance.onboundary = (event: SpeechSynthesisEvent) => {
    if (token !== runId || !isActive) {
      return;
    }

    if (
      typeof event.charIndex === 'number' &&
      Number.isFinite(event.charIndex)
    ) {
      const sourceIndex = findSourceIndex(
        entry,
        event.charIndex,
      );

      reportCurrentSourceLine(sourceIndex);
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
   * प्रत्येक नए वाचन को अलग token दें, ताकि पुराने वाचन
   * के callbacks नए वाचन को प्रभावित न कर सकें।
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

  speechQueue = buildSpeechQueue(lines);

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
   * पहले token बदलें ताकि cancel से आने वाले पुराने
   * events वर्तमान वाचन को प्रभावित न करें।
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
