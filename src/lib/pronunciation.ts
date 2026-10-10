
import lexicon from '../../data/vedic-lexicon.json';

export interface PronunciationEntry {
  term: string;
  spoken: string;
  category: string;
  guide: string;
}

export interface VedicCharacter {
  character: string;
  display?: string;
  codepoint: string;
  name: string;
  handling: string;
  note: string;
}

interface NormalizationRule {
  from: string;
  to: string;
  mode: 'token' | 'literal';
  note?: string;
}

interface LexiconFile {
  schemaVersion: number;
  name: string;
  language: string;
  importantLimit: string;
  normalizations: NormalizationRule[];
  vedicCharacters: VedicCharacter[];
  pronunciationEntries: PronunciationEntry[];
  accentPolicy: {
    preserveMarksInDisplay: boolean;
    preserveMarksInTtsInput: boolean;
    note: string;
  };
}

const data = lexicon as LexiconFile;

/**
 * किसी शब्द को RegExp में सुरक्षित रूप से उपयोग करने के लिए
 * विशेष characters को escape करता है।
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lexicon में दिए गए normalization rules को लागू करता है।
 *
 * महत्वपूर्ण:
 * - मूल display text को यह function नहीं बदलता।
 * - NFC normalization Unicode representation को standardize करता है।
 * - token rules शब्द के भीतर अनचाहे partial matches से बचते हैं।
 * - literal rules केवल उन्हीं characters को बदलते हैं जिन्हें
 *   JSON में स्पष्ट रूप से literal replacement बताया गया है।
 * - कठिन शब्दों की लंबी entries पहले लागू की जाती हैं।
 * - वैदिक स्वर-चिह्नों के सही pitch contour की गारंटी यह function
 *   नहीं देता; वास्तविक ध्वनि स्थानीय TTS मॉडल उत्पन्न करता है।
 */
export function normalizeForSpeech(input: string): string {
  let result = input.normalize('NFC');

  const rules: NormalizationRule[] = [
    ...data.normalizations,
    ...data.pronunciationEntries
      .filter((entry) => entry.term !== entry.spoken)
      .map((entry) => ({
        from: entry.term,
        to: entry.spoken,
        mode: 'token' as const,
      })),
  ];

  // बड़े पद पहले बदलें ताकि छोटे पद किसी लंबे पद से टकराएँ नहीं।
  const orderedRules = rules
    .filter((rule) => rule.from.length > 0)
    .sort((a, b) => b.from.length - a.from.length);

  for (const rule of orderedRules) {
    const escaped = escapeRegExp(rule.from);

    if (rule.mode === 'token') {
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{M}])${escaped}(?![\\p{L}\\p{M}])`,
        'gu',
      );

      result = result.replace(pattern, rule.to);
    } else {
      result = result.replace(
        new RegExp(escaped, 'gu'),
        () => rule.to,
      );
    }
  }

  return result;
}

/**
 * Lexicon से कठिन उच्चारण वाले शब्द प्राप्त करता है।
 * ये entries UI में प्रदर्शित होती हैं और speech normalization
 * के नियम बनाने में भी उपयोग होती हैं।
 */
export function getPronunciationEntries(): PronunciationEntry[] {
  return data.pronunciationEntries;
}

/**
 * वैदिक वर्णों तथा Unicode चिह्नों की सूची देता है।
 */
export function getVedicCharacters(): VedicCharacter[] {
  return data.vedicCharacters;
}

/**
 * UI को JSON फ़ाइल की वास्तविक metadata प्रदान करता है।
 */
export function getLexiconMetadata() {
  return {
    name: data.name,
    importantLimit: data.importantLimit,
    accentPolicy: data.accentPolicy,
    normalizationCount: data.normalizations.length,
    pronunciationCount: data.pronunciationEntries.length,
    vedicCharacterCount: data.vedicCharacters.length,
  };
}

/**
 * वर्तमान imported lexicon को JSON फ़ाइल के रूप में निर्यात करता है।
 */
export function exportLexiconJson(): string {
  return JSON.stringify(data, null, 2);
}
