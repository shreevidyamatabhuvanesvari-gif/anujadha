'use strict';

/*
 * Sanskrit–Vedic read-only knowledge layer for the Suvichar app.
 * This module is intentionally isolated from SpeechSynthesis and the playback
 * queue. It validates the complete dataset before making any analysis API
 * available and reports load state through the optional dedicated status node.
 */
(function installSanskritVedicKnowledgeLayer(global) {
  const MASTER_URL = './language/sanskrit-vedic-master.json';
  const DEVANAGARI_AND_VEDIC = /[\u0900-\u097F\u1CD0-\u1CFF\uA8E0-\uA8FF]/u;

  const REQUIRED_GROUPS = [
    'vedic_samhita_mantra_terms',
    'brahmana_shrauta_yajna_terms',
    'upanishad_philosophy_terms',
    'purana_cosmology_deity_terms',
    'devi_tantra_agama_terms',
    'grammar_and_textual_criticism',
    'common_compound_and_inflected_forms'
  ];

  const REQUIRED_FUNCTIONS = [
    'loadSanskritVedicMaster()',
    'recognizeDevanagariCharacters(text)',
    'detectVedicMarks(text)',
    'lookupSanskritTerms(text)',
    'segmentConjunctCandidates(text)',
    'prepareTtsTextWithoutMutation(text)'
  ];

  const runtime = {
    master: null,
    loadPromise: null,
    loadError: null,
    status: 'not-loaded',
    characterIndex: null,
    lexiconBySurface: null,
    conjunctPatterns: null
  };

  function fail(path, expected, actual) {
    throw new TypeError(`JSON schema त्रुटि: ${path} — ${expected} अपेक्षित; मिला ${actual}।`);
  }

  function describe(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  function requireObject(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(path, 'object', describe(value));
    }
    return value;
  }

  function requireString(value, path, allowEmpty = false) {
    if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
      fail(path, allowEmpty ? 'string' : 'non-empty string', describe(value));
    }
    return value;
  }

  function requireBoolean(value, path) {
    if (typeof value !== 'boolean') fail(path, 'boolean', describe(value));
    return value;
  }

  function requireNullableString(value, path) {
    if (value !== null && typeof value !== 'string') {
      fail(path, 'string or null', describe(value));
    }
  }

  function requireArray(value, path, minimum = 0) {
    if (!Array.isArray(value)) fail(path, 'array', describe(value));
    if (value.length < minimum) {
      throw new TypeError(`JSON schema त्रुटि: ${path} में कम-से-कम ${minimum} item आवश्यक हैं; मिले ${value.length}।`);
    }
    return value;
  }

  function requireStringArray(value, path, minimum = 0) {
    const array = requireArray(value, path, minimum);
    array.forEach((item, index) => requireString(item, `${path}[${index}]`));
    return array;
  }

  function requireStringRecord(value, path) {
    const record = requireObject(value, path);
    Object.entries(record).forEach(([key, entry]) => {
      requireString(entry, `${path}.${key}`);
    });
    return record;
  }

  function requireCharRecordArray(value, path, fields) {
    const array = requireArray(value, path, 1);
    array.forEach((item, index) => {
      const itemPath = `${path}[${index}]`;
      requireObject(item, itemPath);
      fields.forEach(([field, type]) => {
        if (type === 'string') requireString(item[field], `${itemPath}.${field}`);
        else if (type === 'number') {
          if (typeof item[field] !== 'number' || !Number.isFinite(item[field])) {
            fail(`${itemPath}.${field}`, 'finite number', describe(item[field]));
          }
        }
      });
    });
    return array;
  }

  function validateCharacterInventory(value) {
    const path = 'characterInventory';
    const inventory = requireObject(value, path);
    const listKeys = [
      'independentVowels',
      'consonants',
      'dependentVowelSigns',
      'extendedDevanagariLetters',
      'digits',
      'punctuation'
    ];
    listKeys.forEach(key => requireStringArray(inventory[key], `${path}.${key}`, 1));

    const groups = requireObject(inventory.consonantsByArticulationGroup, `${path}.consonantsByArticulationGroup`);
    if (Object.keys(groups).length === 0) {
      throw new TypeError(`JSON schema त्रुटि: ${path}.consonantsByArticulationGroup खाली नहीं होना चाहिए।`);
    }
    Object.entries(groups).forEach(([group, chars]) => {
      requireStringArray(chars, `${path}.consonantsByArticulationGroup.${group}`, 1);
    });

    requireCharRecordArray(inventory.generalMarks, `${path}.generalMarks`, [
      ['char', 'string'], ['name', 'string'], ['role', 'string']
    ]);
    requireString(inventory.note, `${path}.note`);
    return inventory;
  }

  function validateUnicodeRanges(value) {
    const ranges = requireObject(value, 'unicodeRanges');
    for (const name of ['vedicExtensions', 'devanagariExtended']) {
      const path = `unicodeRanges.${name}`;
      const range = requireObject(ranges[name], path);
      requireString(range.start, `${path}.start`);
      requireString(range.end, `${path}.end`);
      requireString(range.policy, `${path}.policy`);
      requireCharRecordArray(range.assignedCharacters, `${path}.assignedCharacters`, [
        ['char', 'string'], ['codePoint', 'string'], ['unicodeName', 'string'],
        ['generalCategory', 'string'], ['class', 'string']
      ]);
      range.assignedCharacters.forEach((character, index) => {
        if (typeof character.combiningClass !== 'number' || !Number.isFinite(character.combiningClass)) {
          fail(`${path}.assignedCharacters[${index}].combiningClass`, 'finite number', describe(character.combiningClass));
        }
      });
    }
    return ranges;
  }

  function validateAccentMarks(value) {
    const marks = requireArray(value, 'vedicAccentMarks', 1);
    const seen = new Set();
    marks.forEach((mark, index) => {
      const path = `vedicAccentMarks[${index}]`;
      requireObject(mark, path);
      requireString(mark.char, `${path}.char`);
      requireString(mark.codePoint, `${path}.codePoint`);
      requireString(mark.name, `${path}.name`);
      requireString(mark.handling, `${path}.handling`);
      if (Array.from(mark.char).length !== 1) {
        throw new TypeError(`JSON schema त्रुटि: ${path}.char एक Unicode code point होना चाहिए।`);
      }
      if (mark.codePoint !== codePointOf(mark.char)) {
        throw new TypeError(`JSON schema त्रुटि: ${path}.codePoint, char के Unicode code point से मेल नहीं खाता।`);
      }
      if (seen.has(mark.char)) throw new TypeError(`JSON schema त्रुटि: duplicate Vedic accent char ${JSON.stringify(mark.char)}।`);
      seen.add(mark.char);
    });
    return marks;
  }

  function validateConjunctPatterns(value) {
    const path = 'conjunctPatterns';
    const patterns = requireObject(value, path);
    requireStringArray(patterns.patterns, `${path}.patterns`, 1);
    requireStringRecord(patterns.importantExamples, `${path}.importantExamples`);
    requireString(patterns.note, `${path}.note`);
    const duplicates = new Set();
    patterns.patterns.forEach((pattern, index) => {
      if (Array.from(pattern).length < 2) {
        throw new TypeError(`JSON schema त्रुटि: ${path}.patterns[${index}] में कम-से-कम दो Unicode code points होने चाहिए।`);
      }
      if (duplicates.has(pattern)) throw new TypeError(`JSON schema त्रुटि: duplicate conjunct pattern ${JSON.stringify(pattern)}।`);
      duplicates.add(pattern);
    });
    return patterns;
  }

  function validateLexicalGroups(value) {
    const groups = requireObject(value, 'lexicalGroups');
    REQUIRED_GROUPS.forEach(group => {
      if (!Object.prototype.hasOwnProperty.call(groups, group)) {
        throw new TypeError(`JSON schema त्रुटि: lexicalGroups.${group} अनुपस्थित है।`);
      }
      requireStringArray(groups[group], `lexicalGroups.${group}`, 1);
    });
    Object.entries(groups).forEach(([group, words]) => {
      requireStringArray(words, `lexicalGroups.${group}`);
    });
    return groups;
  }

  function validateLexiconEntries(value, groups) {
    const entries = requireArray(value, 'lexiconEntries', 1);
    const seen = new Set();
    const groupSurfaces = new Map(Object.keys(groups).map(group => [group, new Set(groups[group])]));

    entries.forEach((entry, index) => {
      const path = `lexiconEntries[${index}]`;
      requireObject(entry, path);
      requireString(entry.surface, `${path}.surface`);
      requireString(entry.domain, `${path}.domain`);
      if (!groupSurfaces.has(entry.domain)) {
        throw new TypeError(`JSON schema त्रुटि: ${path}.domain (${entry.domain}) का lexicalGroups में समूह नहीं है।`);
      }
      if (!groupSurfaces.get(entry.domain).has(entry.surface)) {
        throw new TypeError(`JSON schema त्रुटि: ${path}.surface lexicalGroups.${entry.domain} में अनुपस्थित है।`);
      }
      for (const key of ['sourceWork', 'sourceLocation', 'lemma', 'morphology', 'pronunciationHint']) {
        requireNullableString(entry[key], `${path}.${key}`);
      }
      requireStringArray(entry.vedicAccents, `${path}.vedicAccents`);
      requireBoolean(entry.pronunciationVerified, `${path}.pronunciationVerified`);
      requireStringArray(entry.notes, `${path}.notes`, 1);

      const key = `${entry.domain}\u0000${entry.surface}`;
      if (seen.has(key)) throw new TypeError(`JSON schema त्रुटि: duplicate lexical entry ${entry.domain}/${entry.surface}।`);
      seen.add(key);
    });

    // The two structures are intended to be aligned in this starter dataset.
    const surfacesByDomain = new Map();
    entries.forEach(entry => {
      if (!surfacesByDomain.has(entry.domain)) surfacesByDomain.set(entry.domain, new Set());
      surfacesByDomain.get(entry.domain).add(entry.surface);
    });
    for (const [group, words] of Object.entries(groups)) {
      const surfaces = surfacesByDomain.get(group) || new Set();
      const missing = words.find(word => !surfaces.has(word));
      if (missing) throw new TypeError(`JSON schema त्रुटि: lexicalGroups.${group} की प्रविष्टि ${JSON.stringify(missing)} lexiconEntries में नहीं है।`);
    }
    return entries;
  }

  function validateMaster(data) {
    const master = requireObject(data, 'root');
    const topStrings = ['schemaVersion', 'datasetVersion', 'id', 'title', 'purpose', 'status', 'coverageNotice'];
    topStrings.forEach(key => requireString(master[key], key));
    requireStringArray(master.language, 'language', 1);

    const engine = requireObject(master.enginePolicy, 'enginePolicy');
    requireString(engine.provider, 'enginePolicy.provider');
    requireBoolean(engine.externalTTS, 'enginePolicy.externalTTS');
    requireBoolean(engine.cloudTTS, 'enginePolicy.cloudTTS');
    requireBoolean(engine.apiKeyRequired, 'enginePolicy.apiKeyRequired');
    requireString(engine.voiceSelectionPolicy, 'enginePolicy.voiceSelectionPolicy');
    requireString(engine.ttsTextPolicy, 'enginePolicy.ttsTextPolicy');
    if (engine.provider !== 'browser-speech-synthesis' || engine.externalTTS || engine.cloudTTS || engine.apiKeyRequired) {
      throw new TypeError('JSON policy त्रुटि: इस integration के लिए browser SpeechSynthesis ही अपेक्षित है; external/cloud TTS और API key निषिद्ध हैं।');
    }

    validateCharacterInventory(master.characterInventory);
    validateUnicodeRanges(master.unicodeRanges);
    validateAccentMarks(master.vedicAccentMarks);
    validateConjunctPatterns(master.conjunctPatterns);
    const groups = validateLexicalGroups(master.lexicalGroups);
    validateLexiconEntries(master.lexiconEntries, groups);

    const policy = requireObject(master.textProcessingPolicy, 'textProcessingPolicy');
    for (const key of [
      'displayTextImmutable', 'originalTextMustBeRetained', 'silentCorrectionAllowed',
      'silentAccentRemovalAllowed', 'silentAnusvaraCandrabinduSubstitutionAllowed',
      'silentVisargaSubstitutionAllowed'
    ]) requireBoolean(policy[key], `textProcessingPolicy.${key}`);
    for (const key of ['unknownCharacters', 'unicodeNormalization', 'sourceVariants', 'lexiconLookup']) {
      requireString(policy[key], `textProcessingPolicy.${key}`);
    }
    if (!policy.displayTextImmutable || !policy.originalTextMustBeRetained || policy.silentCorrectionAllowed ||
        policy.silentAccentRemovalAllowed || policy.silentAnusvaraCandrabinduSubstitutionAllowed ||
        policy.silentVisargaSubstitutionAllowed) {
      throw new TypeError('JSON policy त्रुटि: मूल पाठ और वैदिक चिह्नों की संरक्षण नीति सुरक्षित नहीं है।');
    }

    const pronunciation = requireObject(master.pronunciationPreparation, 'pronunciationPreparation');
    requireString(pronunciation.defaultMode, 'pronunciationPreparation.defaultMode');
    requireBoolean(pronunciation.allowAutomaticRewrite, 'pronunciationPreparation.allowAutomaticRewrite');
    requireBoolean(pronunciation.preserveAccents, 'pronunciationPreparation.preserveAccents');
    requireBoolean(pronunciation.preservePunctuation, 'pronunciationPreparation.preservePunctuation');
    requireBoolean(pronunciation.preserveWordOrder, 'pronunciationPreparation.preserveWordOrder');
    requireString(pronunciation.ruleActivation, 'pronunciationPreparation.ruleActivation');
    requireString(pronunciation.warning, 'pronunciationPreparation.warning');
    if (pronunciation.allowAutomaticRewrite || !pronunciation.preserveAccents ||
        !pronunciation.preservePunctuation || !pronunciation.preserveWordOrder) {
      throw new TypeError('JSON policy त्रुटि: automatic rewrite निषिद्ध है तथा accents, punctuation और word order संरक्षित रहने चाहिए।');
    }

    const contract = requireObject(master.integrationContract, 'integrationContract');
    requireString(contract.filePath, 'integrationContract.filePath');
    requireString(contract.consumer, 'integrationContract.consumer');
    if (contract.filePath !== MASTER_URL.replace(/^\.\//, '') || contract.consumer !== 'app.js') {
      throw new TypeError(`JSON schema त्रुटि: integrationContract.filePath और consumer क्रमशः ${JSON.stringify(MASTER_URL.replace(/^\.\//, ''))} और "app.js" होने चाहिए।`);
    }
    requireStringArray(contract.recommendedFunctions, 'integrationContract.recommendedFunctions', REQUIRED_FUNCTIONS.length);
    REQUIRED_FUNCTIONS.forEach((fn, index) => {
      if (contract.recommendedFunctions[index] !== fn) {
        throw new TypeError(`JSON schema त्रुटि: integrationContract.recommendedFunctions[${index}] में ${JSON.stringify(fn)} अपेक्षित है।`);
      }
    });
    requireString(contract.failureMode, 'integrationContract.failureMode');

    const tests = requireObject(master.testCases, 'testCases');
    requireStringArray(tests.characterRecognition, 'testCases.characterRecognition', 1);
    requireStringArray(tests.lexicalLookup, 'testCases.lexicalLookup', 1);
    requireStringArray(tests.preservationAssertions, 'testCases.preservationAssertions', 1);
    requireString(tests.expectedStatus, 'testCases.expectedStatus');

    const provenance = requireObject(master.provenance, 'provenance');
    requireString(provenance.characterNameSource, 'provenance.characterNameSource');
    requireString(provenance.lexicalSource, 'provenance.lexicalSource');
    requireString(provenance.builtAt, 'provenance.builtAt');

    return master;
  }

  function codePointOf(character) {
    return 'U+' + character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  }

  function flattenCharacters(value, target) {
    if (typeof value === 'string') {
      target.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => flattenCharacters(item, target));
      return;
    }
    if (value && typeof value === 'object') {
      if (typeof value.char === 'string') target.add(value.char);
      Object.values(value).forEach(item => {
        if (item && typeof item === 'object') flattenCharacters(item, target);
      });
    }
  }

  function buildCharacterIndex(master) {
    const index = new Map();
    const inventory = master.characterInventory;
    const addGroup = (value, category) => {
      const characters = new Set();
      flattenCharacters(value, characters);
      characters.forEach(character => {
        if (!index.has(character)) index.set(character, category);
      });
    };

    addGroup(inventory.independentVowels, 'independent-vowel');
    addGroup(inventory.consonantsByArticulationGroup, 'consonant');
    addGroup(inventory.consonants, 'consonant');
    addGroup(inventory.dependentVowelSigns, 'dependent-vowel-sign');
    addGroup(inventory.extendedDevanagariLetters, 'extended-letter');
    addGroup(inventory.generalMarks, 'general-mark');
    addGroup(inventory.digits, 'digit');
    addGroup(inventory.punctuation, 'punctuation');
    master.vedicAccentMarks.forEach(mark => index.set(mark.char, 'vedic-accent'));
    return index;
  }

  function announceStatus(message, isError) {
    const element = global.document && global.document.getElementById('sanskritVedicStatus');
    if (element) {
      element.textContent = message;
      element.dataset.state = isError ? 'error' : runtime.status;
    }
    if (isError && global.console && typeof global.console.warn === 'function') {
      global.console.warn(message);
    }
  }

  async function loadSanskritVedicMaster(url = MASTER_URL) {
    if (runtime.master) return runtime.master;
    if (runtime.loadPromise) return runtime.loadPromise;

    runtime.status = 'loading';
    runtime.loadError = null;
    announceStatus('संस्कृत-वेदिक ज्ञान-फाइल लोड हो रही है…', false);

    runtime.loadPromise = (async () => {
      try {
        if (typeof global.fetch !== 'function') {
          throw new Error('इस browser में fetch API उपलब्ध नहीं है।');
        }
        const response = await global.fetch(url, { cache: 'no-cache' });
        if (!response || !response.ok) {
          throw new Error(`JSON लोड नहीं हुई: HTTP ${response ? response.status : 'unknown'} (${url})`);
        }

        const parsed = validateMaster(await response.json());
        const characterIndex = buildCharacterIndex(parsed);
        const lexiconBySurface = new Map();
        parsed.lexiconEntries.forEach(entry => {
          const key = entry.surface.normalize('NFC');
          if (!lexiconBySurface.has(key)) lexiconBySurface.set(key, []);
          lexiconBySurface.get(key).push(entry);
        });
        const conjunctPatterns = [...new Set(parsed.conjunctPatterns.patterns)]
          .sort((a, b) => b.length - a.length || a.localeCompare(b, 'hi'));

        // Commit the dataset to runtime only after all validation/indexing passes.
        runtime.master = parsed;
        runtime.characterIndex = characterIndex;
        runtime.lexiconBySurface = lexiconBySurface;
        runtime.conjunctPatterns = conjunctPatterns;
        runtime.status = 'loaded';
        runtime.loadError = null;
        announceStatus(`संस्कृत-वेदिक ज्ञान-फाइल लोड हो गई। (${parsed.lexiconEntries.length} प्रविष्टियाँ)`, false);
        return parsed;
      } catch (error) {
        runtime.loadError = error instanceof Error ? error : new Error(String(error));
        runtime.status = 'error';
        runtime.master = null;
        runtime.characterIndex = null;
        runtime.lexiconBySurface = null;
        runtime.conjunctPatterns = null;
        runtime.loadPromise = null;
        announceStatus(`संस्कृत-वेदिक ज्ञान-फाइल उपलब्ध नहीं है; मौजूदा TTS यथावत रहेगा। ${runtime.loadError.message}`, true);
        throw runtime.loadError;
      }
    })();

    return runtime.loadPromise;
  }

  function requireMaster() {
    if (!runtime.master) throw new Error('Sanskrit-Vedic master JSON अभी लोड नहीं हुई है।');
    return runtime.master;
  }

  function recognizeDevanagariCharacters(text) {
    const master = requireMaster();
    const input = String(text ?? '');
    const found = [];
    let offset = 0;
    for (const character of input) {
      if (DEVANAGARI_AND_VEDIC.test(character)) {
        found.push({
          character,
          codePoint: codePointOf(character),
          category: runtime.characterIndex.get(character) || 'unclassified-devanagari-or-vedic',
          offset
        });
      }
      offset += character.length;
    }
    return found;
  }

  function detectVedicMarks(text) {
    const master = requireMaster();
    const input = String(text ?? '');
    const markMap = new Map(master.vedicAccentMarks.map(mark => [mark.char, mark]));
    const found = [];
    let offset = 0;
    for (const character of input) {
      const metadata = markMap.get(character);
      if (metadata) found.push({ ...metadata, offset });
      offset += character.length;
    }
    return found;
  }

  function lookupSanskritTerms(text) {
    const master = requireMaster();
    const input = String(text ?? '');
    // Normalize only the lookup representation, never the caller's original string.
    const lookupText = input.normalize('NFC');
    const matches = [];
    const seen = new Set();
    for (const entry of master.lexiconEntries) {
      const term = entry.surface.normalize('NFC');
      let from = 0;
      while (from <= lookupText.length - term.length) {
        const offset = lookupText.indexOf(term, from);
        if (offset < 0) break;
        const key = `${offset}\u0000${term}\u0000${entry.domain}`;
        if (!seen.has(key)) {
          seen.add(key);
          matches.push({ ...entry, offset, matchedText: lookupText.slice(offset, offset + term.length) });
        }
        from = offset + Math.max(1, term.length);
      }
    }
    return matches.sort((a, b) => a.offset - b.offset || b.surface.length - a.surface.length);
  }

  function segmentConjunctCandidates(text) {
    const master = requireMaster();
    const input = String(text ?? '');
    const found = [];
    const seen = new Set();
    runtime.conjunctPatterns.forEach(pattern => {
      let from = 0;
      while (from <= input.length - pattern.length) {
        const offset = input.indexOf(pattern, from);
        if (offset < 0) break;
        const key = `${offset}\u0000${pattern}`;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({ candidate: pattern, offset, length: pattern.length });
        }
        from = offset + 1;
      }
    });
    return found.sort((a, b) => a.offset - b.offset || b.length - a.length);
  }

  function prepareTtsTextWithoutMutation(text) {
    // This is a separate representation. app.js continues to call speechText().
    return String(text ?? '');
  }

  function getStatus() {
    return {
      status: runtime.status,
      loaded: Boolean(runtime.master),
      error: runtime.loadError ? runtime.loadError.message : null,
      datasetVersion: runtime.master?.datasetVersion || null,
      entryCount: runtime.master?.lexiconEntries?.length || 0
    };
  }

  // Curated text library: source edition/recension should be checked before ritual use.
  // This is a selected starter corpus, not the complete contents of any Veda or Purana.
  const SCRIPTURE_LIBRARY = Object.freeze([
    {
      id: 'varna-vowels', category: 'वर्ण एवं उच्चारण अभ्यास', title: 'स्वर-वर्ण — पूर्ण पारंपरिक सूची',
      reference: 'संस्कृत स्वतंत्र स्वर; परंपरागत वर्ण-सूची', sourceLabel: 'Unicode Devanagari chart',
      sourceUrl: 'https://www.unicode.org/Public/UCD/latest/charts/nameslist/0900/',
      text: 'अ आ इ ई उ ऊ ऋ ॠ ऌ ॡ ए ऐ ओ औ',
      note: 'ऋ, ॠ, ऌ, ॡ पारंपरिक वर्ण-सूची में रखे गए हैं; आधुनिक पाठों में इनके प्रयोग की आवृत्ति अलग-अलग है।'
    },
    {
      id: 'varna-consonants', category: 'वर्ण एवं उच्चारण अभ्यास', title: 'व्यंजन-वर्ण — उच्चारण-स्थान के अनुसार',
      reference: 'कण्ठ्य, तालव्य, मूर्धन्य, दन्त्य, ओष्ठ्य, अन्तःस्थ और ऊष्म वर्ण',
      sourceLabel: 'Unicode Devanagari chart', sourceUrl: 'https://www.unicode.org/Public/UCD/latest/charts/nameslist/0900/',
      text: 'क ख ग घ ङ । च छ ज झ ञ । ट ठ ड ढ ण । त थ द ध न । प फ ब भ म । य र ल व । श ष स ह',
      note: 'यह वर्ण-पहचान अभ्यास है; प्रत्येक अक्षर का सही ध्वन्यात्मक उच्चारण सुनने के लिए संस्कृत-विशिष्ट शिक्षक/रिकॉर्डिंग से मिलान करें।'
    },
    {
      id: 'varna-matras', category: 'वर्ण एवं उच्चारण अभ्यास', title: 'मात्राएँ, हलन्त और मूल चिह्न',
      reference: 'देवनागरी स्वरचिह्न एवं सामान्य चिह्न', sourceLabel: 'Unicode Devanagari chart',
      sourceUrl: 'https://www.unicode.org/Public/UCD/latest/charts/nameslist/0900/',
      text: 'ा ि ी ु ू ृ ॄ ॢ ॣ े ै ो ौ । क का कि की कु कू कृ कॄ कॢ कॣ के कै को कौ । अं अः अँ क् ॐ । ॥',
      note: 'चिह्नों का दृश्य संरक्षण सुनिश्चित किया जाता है; browser TTS इनका उच्चारण अलग तरह से कर सकता है।'
    },
    {
      id: 'varna-extended', category: 'वर्ण एवं उच्चारण अभ्यास', title: 'विस्तारित देवनागरी और वैदिक चिह्नों का नमूना',
      reference: 'Unicode Devanagari तथा Vedic Extensions', sourceLabel: 'Unicode Devanagari chart',
      sourceUrl: 'https://www.unicode.org/Public/UCD/latest/charts/nameslist/0900/',
      text: 'ऄ ऍ ऎ ऑ ऒ ॲ ऩ ऱ ळ ऴ क़ ख़ ग़ ज़ ड़ ढ़ फ़ य़ । अ॑ अ॒ अ᳚ अ᳛ अ᳴',
      note: 'यह प्रत्यक्ष अक्षर-अभ्यास है। वैदिक स्वरचिह्नों का वास्तविक स्वर-क्रम शाखा/पाठ-परंपरा के अनुसार सीखा जाना चाहिए।'
    },
    {
      id: 'conjunct-drill', category: 'संयुक्ताक्षर एवं कठिन पद', title: 'प्रमुख संयुक्ताक्षर — क्ष से र्त्स्न तक',
      reference: 'Master JSON के curated conjunctPatterns',
      text: 'क्ष क्ष्ण क्ष्म क्ष्व क्ष्य त्र त्र्य त्र्व ज्ञ श्र श्र्य श्र्व स्त्र स्त्य स्त्व ष्ठ ष्ठ्य ष्ण ष्प ष्म ह्न ह्म ह्य ह्व क्त क्त्व क्त्र क्न ङ्क ङ्ख ङ्ग ङ्घ ङ्म ञ्च ञ्ज ञ्छ ञ्झ ण्ड ण्ठ ण्ड्य ण्म न्त न्त्र न्द्र न्ध न्ध्य र्त्स्न र्त्व र्द्ध र्द्भ द्भ्र द्ध द्ध्व द्ग्ध द्य द्व्य श्च श्न श्ल ष्क क्क क्ख ग्ध ग्न ग्म ग्व च्च च्छ ट्ट ठ्ठ ड्ड ढ्ढ त्त त्थ द्द न्न प्त प्थ ब्द ब्ध म्प म्फ र्थ र्ध र्ष ष्ट',
      note: 'संयुक्ताक्षर सूची पाठ-पहचान का अभ्यास है; इसे सभी वैध संयुक्ताक्षरों की पूर्ण सूची न माना जाए।'
    },
    {
      id: 'hard-drill-constructed', category: 'संयुक्ताक्षर एवं कठिन पद', title: 'उच्चारण-अभ्यास पंक्ति — निर्मित अभ्यास, शास्त्रीय उद्धरण नहीं',
      reference: 'केवल ध्वनि-अभ्यास के लिए निर्मित; किसी ग्रंथ से उद्धरण नहीं',
      text: 'क्षत्रज्ञः प्रज्ञावान् ऋत्विज् ब्रह्मण्यः स्त्र्याख्यः श्लाघ्यः शृङ्गग्रन्थिः स्फुटं स्थूलं दृष्ट्वा दधिक्राव्णः त्वष्टा ज्येष्ठश्रेष्ठः',
      note: 'यह निर्मित अभ्यास-पंक्ति है, मंत्र या श्लोक नहीं। इसे वैदिक पाठ के रूप में न प्रयोग करें।'
    },
    {
      id: 'rv-1-1-1', category: 'ऋग्वेद-संहिता', title: 'ऋग्वेद १.१.१ — अग्नि सूक्त (स्वर-चिह्न सहित)',
      reference: 'ऋग्वेद 1.1.1; ऋषि मधुच्छन्दा वैश्वामित्र; देवता अग्नि',
      sourceLabel: 'Vedic Samhita — Rigveda 1.1', sourceUrl: 'https://www.vedicsamhita.in/vedas/rigveda/1/1',
      text: 'अ॒ग्निमी॑ळे पु॒रोहि॑तं य॒ज्ञस्य॑ दे॒वमृ॒त्विज॑म् । होता॑रं रत्न॒धात॑मम् ॥',
      note: 'स्वरयुक्त पाठ स्रोत में दिए रूप के अनुसार रखा गया है। browser TTS वैदिक स्वराघात को शास्त्रीय ढंग से प्रस्तुत करेगा, इसकी गारंटी नहीं है।'
    },
    {
      id: 'rv-1-1-2', category: 'ऋग्वेद-संहिता', title: 'ऋग्वेद १.१.२ — अग्नि सूक्त',
      reference: 'ऋग्वेद 1.1.2', sourceLabel: 'Vedic Samhita — Rigveda 1.1',
      sourceUrl: 'https://www.vedicsamhita.in/vedas/rigveda/1/1',
      text: 'अ॒ग्निः पूर्वे॑भि॒र्ऋषि॑भि॒रीड्यो॒ नूत॑नैरु॒त । स दे॒वाँ एह व॑क्षति ॥',
      note: 'स्रोत-आधारित स्वरचिह्नों को हटाया नहीं जाता।'
    },
    {
      id: 'rv-4-39-6', category: 'ऋग्वेद-संहिता', title: 'ऋग्वेद ४.३९.६ — दधिक्राव्णः (कठिन पद-संयोजन)',
      reference: 'ऋग्वेद 4.39.6; स्वरयुक्त संहितापाठ',
      sourceLabel: 'ऋग्वेद 4.39 — Wikisource', sourceUrl: 'https://sa.wikisource.org/wiki/ऋग्वेदः_सूक्तं_४.३९',
      text: 'द॒धि॒क्राव्णो॑ अकारिषं जि॒ष्णोरश्व॑स्य वा॒जिनः॑ । सु॒र॒भि नो॒ मुखा॑ कर॒त्प्र ण॒ आयूं॑षि तारिषत् ॥',
      note: 'यह कठिन संयुक्त पदों वाला वास्तविक वैदिक मंत्र है। सही पाठ और स्वर के लिए स्रोत का संहितापाठ/पदपाठ साथ मिलाएँ।'
    },
    {
      id: 'rv-7-59-12', category: 'ऋग्वेद-संहिता', title: 'ऋग्वेद ७.५९.१२ — त्र्यम्बक मंत्र (स्वर-चिह्न सहित)',
      reference: 'ऋग्वेद 7.59.12; रुद्र देवता',
      sourceLabel: 'Vedic Samhita — Rigveda 7.59', sourceUrl: 'https://www.vedicsamhita.in/vedas/rigveda/7/59',
      text: 'त्र्य॑म्बकं यजामहे सु॒गन्धिं॑ पुष्टि॒वर्ध॑नम् । उ॒र्वा॒रु॒कमि॑व॒ बन्ध॑नान्मृ॒त्योर्मु॑क्षीय॒ मामृता॑त् ॥',
      note: 'यहाँ वैदिक स्वरचिह्न सुरक्षित हैं; साधारण TTS इन्हें सही स्वराघात की तरह पढ़े, यह सुनिश्चित नहीं।'
    },
    {
      id: 'rv-10-90-1', category: 'ऋग्वेद-संहिता', title: 'ऋग्वेद १०.९०.१ — पुरुष सूक्त (स्वर-चिह्न सहित)',
      reference: 'ऋग्वेद 10.90.1; पुरुष सूक्त', sourceLabel: 'Wikisource — ऋग्वेद 10.90',
      sourceUrl: 'https://sa.wikisource.org/wiki/ऋग्वेदः_सूक्तं_१०.९०',
      text: 'स॒हस्र॑शीर्षा॒ पुरु॑षः सहस्रा॒क्षः स॒हस्र॑पात् । स भूमिं॑ वि॒श्वतो॑ वृ॒त्वात्य॑तिष्ठद्दशाङ्गु॒लम् ॥',
      note: 'इस मंत्र का स्वरयुक्त पाठ चुने हुए स्रोत की शाखा/संस्करण के अनुसार सुरक्षित रखा गया है।'
    },
    {
      id: 'rv-3-62-10', category: 'ऋग्वेद-संहिता', title: 'ऋग्वेद ३.६२.१० — सावित्री/गायत्री मंत्र',
      reference: 'ऋग्वेद 3.62.10; सावितृ देवता; गायत्री छन्द',
      sourceLabel: 'Vedic Samhita — Rigveda 3.62', sourceUrl: 'https://www.vedicsamhita.in/vedas/rigveda/3/62',
      text: 'तत्सवितुर्वरेण्यं भर्गो देवस्य धीमहि । धियो यो नः प्रचोदयात् ॥',
      note: 'यह सामान्य देवनागरी पाठ है; संहितापाठ में स्वरचिह्न और पाठ-पद्धति अलग हो सकती है।'
    },
    {
      id: 'rv-1-89-8', category: 'ऋग्वेद-संहिता', title: 'ऋग्वेद १.८९.८ — भद्रं कर्णेभिः',
      reference: 'ऋग्वेद 1.89.8; अनेक परंपराओं में शान्तिपाठ',
      sourceLabel: 'ऋग्वेद सूक्त पाठ-संग्रह', sourceUrl: 'https://www.vedicsamhita.in/vedas/rigveda/1/89',
      text: 'भद्रं कर्णेभिः शृणुयाम देवाः । भद्रं पश्येमाक्षभिर्यजत्राः । स्थिरैरङ्गैस्तुष्टुवांसस्तनूभिः । व्यशेम देवहितं यदायुः ॥',
      note: 'कुछ परंपराओं में पद-विभाजन/उच्चारण में अंतर मिलता है; अपने पाठ-सम्प्रदाय के संस्करण से जाँचें।'
    },
    {
      id: 'samaveda-1-1-1', category: 'सामवेद-संहिता', title: 'सामवेद कौथुम शाखा — अग्न आ याहि वीतये',
      reference: 'सामवेद संहिता, कौथुम शाखा, पूर्वार्चिक, आग्नेय काण्ड; सामवेद पाठ-क्रम 1.1.1 (ऋग्वेद 6.16.10 से सम्बद्ध)',
      sourceLabel: 'Wikisource — सामवेद कौथुमीया',
      sourceUrl: 'https://sa.wikisource.org/wiki/सामवेदः/कौथुमीया/संहिता/ग्रामगेयः/प्रपाठकः_०१/पर्कः(अग्नआयाहि)',
      text: 'अग्न आ याहि वीतये गृणानो हव्यदातये । नि होता सत्सि बर्हिषि ॥',
      note: 'सामवेद में गायन-परंपरा और स्वरक्रम महत्त्वपूर्ण हैं; साधारण TTS इस सामगान की नकल नहीं कर सकता।'
    },
    {
      id: 'samaveda-1-1-1-accent', category: 'सामवेद-संहिता', title: 'सामवेद — अग्न आ याहि वीतये (स्वर-चिह्न सहित)',
      reference: 'सामवेद कौथुम शाखा, चयनित स्वर-लिपि; संस्करण विशेष',
      sourceLabel: 'Vedic Scriptures — Samaveda mantra 1',
      sourceUrl: 'https://www.vedicscriptures.in/samveda/1',
      text: 'अ꣢ग्न꣣ आ꣡ या꣢हि वी꣣त꣡ये꣢ गृणा꣣नो꣢ ह꣣व्य꣡दा꣢तये । नि꣡ होता꣢꣯ सत्सि ब꣣र्हि꣡षि꣢ ॥१॥',
      note: 'स्वर/गान-संकेत को दृश्य पाठ में सुरक्षित रखा गया है। Browser TTS से वैदिक सामगान का सही गायन अपेक्षित न करें।'
    },
    {
      id: 'ts-namakam-1', category: 'यजुर्वेद एवं रुद्रपाठ', title: 'श्रीरुद्रम् — नमकम्, आरम्भिक मंत्र',
      reference: 'तैत्तिरीय संहिता 4.5.1; कृष्ण यजुर्वेद की रुद्र-परंपरा',
      sourceLabel: 'श्रीरुद्रम्/यजुर्वेदीय पाठ की तुलना आवश्यक', sourceUrl: 'https://vedicheritage.gov.in/hi/',
      text: 'नमस्ते रुद्र मन्यव उतो त इषवे नमः । नमस्ते अस्तु धन्वने बाहुभ्यामुत ते नमः ॥',
      note: 'यह सामान्य पाठ है; स्वरयुक्त रुद्राध्याय के लिए अपनी तैत्तिरीय शाखा के अधिकृत पाठ/गुरु से मिलान अनिवार्य है।'
    },
    {
      id: 'atharvaveda-1-6-1', category: 'अथर्ववेद-संहिता', title: 'अथर्ववेद शौनक संहिता १.६.१ — शं नो देवीः (स्वर सहित)',
      reference: 'अथर्ववेद शौनक संहिता, काण्ड 1, सूक्त 6, मन्त्र 1',
      sourceLabel: 'भारत सरकार — वैदिक हेरिटेज पोर्टल',
      sourceUrl: 'https://vedicheritage.gov.in/samhitas/atharvaveda-samhitas/shaunaka-samhita/kanda-01-sukta-006/',
      text: 'शं नो॑ दे॒वीर॒भिष्ट॑य॒ आपो॑ भवन्तु पी॒तये॑ । शं योर॒भि स्र॑वन्तु नः ॥',
      note: 'स्रोत पर स्वरयुक्त संहितापाठ और पदपाठ दोनों उपलब्ध हैं। इस data file में मूल पाठ सुरक्षित है; TTS का स्वराघात अलग हो सकता है।'
    },
    {
      id: 'atharvaveda-1-6-2', category: 'अथर्ववेद-संहिता', title: 'अथर्ववेद शौनक संहिता १.६.२ — अप्सु मे सोमः',
      reference: 'अथर्ववेद शौनक संहिता, काण्ड 1, सूक्त 6, मन्त्र 2',
      sourceLabel: 'भारत सरकार — वैदिक हेरिटेज पोर्टल',
      sourceUrl: 'https://vedicheritage.gov.in/samhitas/atharvaveda-samhitas/shaunaka-samhita/kanda-01-sukta-006/',
      text: 'अप्सु मे सोमो अब्रवीदन्तर्विश्वानि भेषजा । अग्निं च विश्वशंभुवम् ॥',
      note: 'यह अथर्ववेद का मंत्र-पाठ है; पाठ की शाखा/संस्करण के अनुसार spelling variants मिल सकते हैं।'
    },
    {
      id: 'taittiriya-shanti-accent', category: 'वैदिक शान्तिपाठ', title: 'तैत्तिरीयोपनिषद् — शिक्षावल्ली शान्तिपाठ (स्वरचिह्न सहित)',
      reference: 'तैत्तिरीयोपनिषद्, शिक्षावल्ली, प्रथम अनुवाक',
      sourceLabel: 'भारत सरकार — वैदिक हेरिटेज पोर्टल', sourceUrl: 'https://vedicheritage.gov.in/hi/upanishads/taittiriya-upanishads/',
      text: 'ॐ शं नो॑ मि॒त्रः शं वरु॑णः । शं नो॑ भवत्वर्य॒मा । शं न॒ इन्द्रो॒ बृह॒स्पतिः॑ । शं नो॒ विष्णु॑रुरु॒क्रमः॑ । नमो॒ ब्रह्म॑णे । नम॑स्ते वायो । त्वमे॒व प्र॒त्यक्षं॒ ब्रह्मा॑सि । त्वामे॒व प्र॒त्यक्षं॒ ब्रह्म॑ वदिष्यामि । ऋ॒तं व॑दिष्यामि । स॒त्यं व॑दिष्यामि । तन्माम॑वतु । तद्व॒क्तार॑मवतु । अवतु॒ माम् । अवतु वक्तारम् । ॐ शान्तिः॒ शान्तिः॒ शान्तिः॑ ॥',
      note: 'दीर्घ पाठ का यह चयनित अंश है; पूर्ण शान्तिपाठ के लिए मूल स्रोत देखें। स्वर-चिह्नों को browser TTS सही तरह गाएगा, इसकी गारंटी नहीं।'
    },
    {
      id: 'taittiriya-shanti', category: 'वैदिक शान्तिपाठ', title: 'तैत्तिरीयोपनिषद् — शिक्षावल्ली शान्तिपाठ (सामान्य पाठ)',
      reference: 'तैत्तिरीयोपनिषद्, शिक्षावल्ली, प्रथम अनुवाक',
      sourceLabel: 'Sanskrit Documents — Taittiriya Upanishad', sourceUrl: 'https://sanskritdocuments.org/doc_upanishhat/tait.html',
      text: 'ॐ शं नो मित्रः शं वरुणः । शं नो भवत्वर्यमा । शं न इन्द्रो बृहस्पतिः । शं नो विष्णुरुरुक्रमः । नमो ब्रह्मणे । नमस्ते वायो । त्वमेव प्रत्यक्षं ब्रह्मासि । त्वामेव प्रत्यक्षं ब्रह्म वदिष्यामि । ऋतं वदिष्यामि । सत्यं वदिष्यामि । तन्मामवतु । तद्वक्तारमवतु । अवतु माम् । अवतु वक्तारम् । ॐ शान्तिः शान्तिः शान्तिः ॥',
      note: 'स्वरचिह्नरहित सामान्य पाठ। इसे ऊपर के स्वरयुक्त पाठ के साथ तुलना के लिए उपयोग करें।'
    },
    {
      id: 'shatapatha-brahmana-1-1-1', category: 'ब्राह्मण-ग्रन्थ', title: 'शतपथब्राह्मणम् १.१.१.१ — गद्यपाठ',
      reference: 'शतपथब्राह्मण, काण्ड 1, अध्याय 1, ब्राह्मण 1, कण्डिका/अनुच्छेद 1.1.1.1',
      sourceLabel: 'Wikisource — शतपथब्राह्मणम्', sourceUrl: 'https://sa.wikisource.org/wiki/शतपथब्राह्मणम्/काण्डम्_१/अध्यायः_१/ब्राह्मण_१',
      text: 'व्रतमुपैष्यन् । अन्तरेणाहवनीयं च गार्हपत्यं च प्राङ्तिष्ठन्नप उपस्पृशति । तद्यदप उपस्पृशत्य् अमेध्यो वै पुरुषो यदनृतं वदति तेन पूतिरन्तरतो मेध्या वा आपो मेध्यो भूत्वा व्रतमुपायानीति पवित्रं वा आपः पवित्रपूतो व्रतमुपायानीति तस्माद्वा अप उपस्पृशति ॥',
      note: 'ब्राह्मण-ग्रन्थ का गद्य है, छन्दोबद्ध श्लोक नहीं। पाठ में संधि और पद-विभाजन संस्करण के अनुसार दिख सकते हैं।'
    },
    {
      id: 'aitareya-brahmana-1', category: 'ब्राह्मण-ग्रन्थ', title: 'ऐतरेयब्राह्मणम् — प्रथम पञ्चिका का चयनित गद्यांश',
      reference: 'ऐतरेयब्राह्मण, प्रथम पञ्चिका; अग्नि-विष्णु और यज्ञ-विषयक अंश',
      sourceLabel: 'Wikisource — ऐतरेयब्राह्मणम्', sourceUrl: 'https://sa.wikisource.org/wiki/ऐतरेय_ब्राह्मणम्/पञ्चिका_१_(प्रथम_पञ्चिका)',
      text: 'अग्निर्वै देवानामवमो विष्णुः परमस्तदन्तरेण सर्वा अन्या देवता । आग्नावैष्णवं पुरोडाशं निर्वपन्ति दीक्षणीयमेकादशकपालम् । अग्निर्वै सर्वा देवता विष्णुः सर्वा देवता एते वै यज्ञस्यान्त्ये तन्वौ यदग्निश्च विष्णुश्च ॥',
      note: 'स्रोत में संधि/पदच्छेद के अन्य रूप भी मिल सकते हैं; यह चयनित अंश है।'
    },
    {
      id: 'gopatha-brahmana-1-1-5', category: 'ब्राह्मण-ग्रन्थ', title: 'गोपथब्राह्मणम् १.१.५ — अथर्वण परंपरा का गद्यांश',
      reference: 'गोपथब्राह्मण, पूर्वभाग, प्रपाठक 1, खण्ड 5 का चयनित अंश',
      sourceLabel: 'Wikisource — गोपथब्राह्मणम्', sourceUrl: 'https://sa.wikisource.org/wiki/गोपथ_ब्राह्मणम्/भागः_१_(पूर्वभागः)/प्रपाठकः_१',
      text: 'तमथर्वाणमृषिमभ्यश्राम्यदभ्यतपत्समतपत् । तस्माच्छ्रान्तात्तप्तात्संतप्तादथर्वण ऋषीन् निरमिमीतैकर्चान् द्व्यृचांस् तृचांश्चतुरृचान् पञ्चर्चान् षडर्चान् सप्तर्चानष्टर्चान् नवर्चान् दशर्चान् इति ॥',
      note: 'यह गद्य अंश है; वर्तनी/संधि के संपादकीय रूप स्रोत-पृष्ठ पर देखें।'
    },
    {
      id: 'brhadaranyaka-1-1-1', category: 'उपनिषद्', title: 'बृहदारण्यकोपनिषद् १.१.१ — अश्वमेध-ब्राह्मण का आरम्भ',
      reference: 'बृहदारण्यकोपनिषद् 1.1.1; शतपथब्राह्मण परंपरा से सम्बद्ध गद्य',
      sourceLabel: 'Sanskrit Documents — Brihadaranyaka', sourceUrl: 'https://sanskritdocuments.org/doc_upanishhat/brinew-proofed.html',
      text: 'उषा वा अश्वस्य मेध्यस्य शिरः । सूर्यश्चक्षुः । वातः प्राणः । व्यात्तमग्निर्वैश्वानरः । संवत्सर आत्माश्वस्य मेध्यस्य । द्यौः पृष्ठम् । अन्तरिक्षमुदरम् । पृथिवी पाजस्यम् ॥',
      note: 'यह गद्य है; विराम/पदच्छेद स्रोत के अनुसार बनाए रखें।'
    },
    {
      id: 'upanishad-purnamadah', category: 'उपनिषद्', title: 'पूर्णमदः पूर्णमिदम् — शान्तिपाठ',
      reference: 'ईशावास्योपनिषद्/शुक्लयजुर्वेदीय परंपरा में प्रचलित शान्तिपाठ',
      sourceLabel: 'Sanskrit Documents — Brihadaranyaka', sourceUrl: 'https://sanskritdocuments.org/doc_upanishhat/brinew-proofed.html',
      text: 'ॐ पूर्णमदः पूर्णमिदं पूर्णात्पूर्णमुदच्यते । पूर्णस्य पूर्णमादाय पूर्णमेवावशिष्यते ॥ ॐ शान्तिः शान्तिः शान्तिः ॥',
      note: 'शान्तिपाठ का पाठ-रूप पाण्डुलिपि/परंपरा के अनुसार जाँचें।'
    },
    {
      id: 'upanishad-asato-ma', category: 'उपनिषद्', title: 'बृहदारण्यकोपनिषद् १.३.२८ — असतो मा सद्गमय',
      reference: 'बृहदारण्यकोपनिषद् 1.3.28',
      sourceLabel: 'Sanskrit Documents — Brihadaranyaka', sourceUrl: 'https://sanskritdocuments.org/doc_upanishhat/brinew-proofed.html',
      text: 'असतो मा सद्गमय । तमसो मा ज्योतिर्गमय । मृत्योर्मामृतं गमय ॥',
      note: 'यह संक्षिप्त मंत्रांश है।'
    },
    {
      id: 'upanishad-katha-1-3-14', category: 'उपनिषद्', title: 'कठोपनिषद् १.३.१४ — उत्तिष्ठत जाग्रत',
      reference: 'कठोपनिषद् 1.3.14', sourceLabel: 'Sanskrit Documents — Upanishad collection',
      sourceUrl: 'https://sanskritdocuments.org/',
      text: 'उत्तिष्ठत जाग्रत प्राप्य वरान्निबोधत । क्षुरस्य धारा निशिता दुरत्यया दुर्गं पथस्तत्कवयो वदन्ति ॥',
      note: 'क्ष, त्र, ज्ञ जैसे संयुक्ताक्षरों और दीर्घ समासों का सामान्य उच्चारण-अभ्यास; वैदिक स्वरचिह्नों वाला पाठ नहीं।'
    },
    {
      id: 'upanishad-mundaka-satyam', category: 'उपनिषद्', title: 'मुण्डकोपनिषद् ३.१.६ — सत्यमेव जयते',
      reference: 'मुण्डकोपनिषद् 3.1.6', sourceLabel: 'Sanskrit Documents — Upanishad collection',
      sourceUrl: 'https://sanskritdocuments.org/',
      text: 'सत्यमेव जयते नानृतं सत्येन पन्था विततो देवयानः । येनाक्रमन्त्यृषयो ह्याप्तकामा यत्र तत्सत्यस्य परमं निधानम् ॥',
      note: 'सत्य-ध्वनि, व्यंजन-संधि और दीर्घ पदों के अभ्यास के लिए।'
    },
    {
      id: 'upanishad-ishavasya-1', category: 'उपनिषद्', title: 'ईशावास्योपनिषद् १ — ईशावास्यमिदं सर्वम्',
      reference: 'ईशावास्योपनिषद्, मन्त्र 1', sourceLabel: 'Sanskrit Documents — Upanishad collection',
      sourceUrl: 'https://sanskritdocuments.org/',
      text: 'ईशावास्यमिदं सर्वं यत्किञ्च जगत्यां जगत् । तेन त्यक्तेन भुञ्जीथा मा गृधः कस्यस्विद्धनम् ॥',
      note: 'यह सामान्य पाठ है; शाखा-विशिष्ट स्वराघात शामिल नहीं।'
    },
    {
      id: 'bhagavad-gita-2-47', category: 'महाकाव्य एवं गीता', title: 'भगवद्गीता २.४७ — कर्मण्येवाधिकारस्ते',
      reference: 'महाभारत, भीष्मपर्व; श्रीमद्भगवद्गीता 2.47',
      sourceLabel: 'Gita Supersite, IIT Kanpur', sourceUrl: 'https://www.gitasupersite.iitk.ac.in/',
      text: 'कर्मण्येवाधिकारस्ते मा फलेषु कदाचन । मा कर्मफलहेतुर्भूर्मा ते सङ्गोऽस्त्वकर्मणि ॥',
      note: 'लौकिक संस्कृत/गीता का श्लोक; वैदिक मंत्र नहीं।'
    },
    {
      id: 'bhagavad-gita-11-32', category: 'महाकाव्य एवं गीता', title: 'भगवद्गीता ११.३२ — कालोऽस्मि',
      reference: 'भगवद्गीता 11.32', sourceLabel: 'Gita Supersite, IIT Kanpur',
      sourceUrl: 'https://www.gitasupersite.iitk.ac.in/srimad?etgb=1&field_chapter_value=11&field_nsutra_value=32&language=dv&scsh=1&setgb=1',
      text: 'कालोऽस्मि लोकक्षयकृत्प्रवृद्धो लोकान्समाहर्तुमिह प्रवृत्तः । ऋतेऽपि त्वां न भविष्यन्ति सर्वे येऽवस्थिताः प्रत्यनीकेषु योधाः ॥',
      note: 'लम्बे संयुक्त पदों के लिए अच्छा अभ्यास; मूल पाठ में श्लोक-पाद-विभाजन अलग पंक्तियों में भी दिया जाता है।'
    },
    {
      id: 'bhagavad-gita-18-78', category: 'महाकाव्य एवं गीता', title: 'भगवद्गीता १८.७८ — यत्र योगेश्वरः कृष्णः',
      reference: 'भगवद्गीता 18.78', sourceLabel: 'Gita Supersite, IIT Kanpur', sourceUrl: 'https://www.gitasupersite.iitk.ac.in/',
      text: 'यत्र योगेश्वरः कृष्णो यत्र पार्थो धनुर्धरः । तत्र श्रीर्विजयो भूतिर्ध्रुवा नीतिर्मतिर्मम ॥',
      note: 'लौकिक संस्कृत छन्द-पाठ।'
    },
    {
      id: 'ramayana-1-1-1', category: 'महाकाव्य एवं गीता', title: 'वाल्मीकि रामायण १.१.१ — तपःस्वाध्यायनिरतम्',
      reference: 'वाल्मीकि रामायण, बालकाण्ड 1.1.1',
      sourceLabel: 'Sanskrit Sahitya — Ramayana 1.1.1', sourceUrl: 'https://www.sanskritsahitya.org/ramayanam/1.1.1',
      text: 'तपःस्वाध्यायनिरतं तपस्वी वाग्विदां वरम् । नारदं परिपप्रच्छ वाल्मीकिर्मुनिपुङ्गवम् ॥',
      note: 'एक ही पंक्ति में अनेक संयुक्ताक्षर हैं: तपःस्वाध्याय, वाग्विदां, मुनिपुङ्गवम्।'
    },
    {
      id: 'bhagavata-1-1-1', category: 'पुराण एवं स्तोत्र', title: 'श्रीमद्भागवतपुराण १.१.१ — जन्माद्यस्य यतः',
      reference: 'श्रीमद्भागवत महापुराण 1.1.1',
      sourceLabel: 'Sanskrit Sahitya — Bhagavatam 1.1', sourceUrl: 'https://www.sanskritsahitya.org/srimadbhagavatam/1.1',
      text: 'जन्माद्यस्य यतोऽन्वयादितरतश्चार्थेष्वभिज्ञः स्वराट् । तेने ब्रह्म हृदा य आदिकवये मुह्यन्ति यत्सूरयः । तेजोवारिमृदां यथा विनिमयो यत्र त्रिसर्गोऽमृषा । धाम्ना स्वेन सदा निरस्तकुहकं सत्यं परं धीमहि ॥',
      note: 'समास-सघन कठिन पाठ। स्रोतों में शब्द-विभाजन/लेखन के छोटे अंतर मिल सकते हैं; इस पाठ को उपलब्ध संस्करण से मिलाएँ।'
    },
    {
      id: 'bhagavata-1-1-2', category: 'पुराण एवं स्तोत्र', title: 'श्रीमद्भागवतपुराण १.१.२ — धर्मः प्रोज्झितकैतवः',
      reference: 'श्रीमद्भागवत महापुराण 1.1.2',
      sourceLabel: 'Sanskrit Sahitya — Bhagavatam 1.1', sourceUrl: 'https://www.sanskritsahitya.org/srimadbhagavatam/1.1',
      text: 'धर्मः प्रोज्झितकैतवोऽत्र परमो निर्मत्सराणां सतां वेद्यं वास्तवमत्र वस्तु शिवदं तापत्रयोन्मूलनम् । श्रीमद्भागवते महामुनिकृते किं वा परैरीश्वरः सद्यो हृद्यवरुध्यतेऽत्र कृतिभिः शुश्रूषुभिस्तत्क्षणात् ॥',
      note: 'दीर्घ समासों और संयुक्ताक्षरों का अभ्यास; स्रोत संस्करण के विरामचिह्नों से मिलान करें।'
    },
    {
      id: 'bhagavata-1-1-3', category: 'पुराण एवं स्तोत्र', title: 'श्रीमद्भागवतपुराण १.१.३ — निगमकल्पतरोर्गलितम्',
      reference: 'श्रीमद्भागवत महापुराण 1.1.3', sourceLabel: 'Sanskrit Sahitya — Bhagavatam 1.1',
      sourceUrl: 'https://www.sanskritsahitya.org/srimadbhagavatam/1.1',
      text: 'निगमकल्पतरोर्गलितं फलं शुकमुखादमृतद्रवसंयुतम् । पिबत भागवतं रसमालयं मुहुरहो रसिका भुवि भावुकाः ॥',
      note: 'यौगिक पदों और दीर्घ मात्रा का अभ्यास।'
    },
    {
      id: 'devi-mahatmya-ya-devi', category: 'पुराण एवं स्तोत्र', title: 'देवीमाहात्म्य-परंपरा — या देवी सर्वभूतेषु',
      reference: 'मार्कण्डेयपुराण, देवीमाहात्म्य में आवर्तित स्तुति-पंक्ति; पाठ-स्थान संस्करणानुसार जाँचें',
      sourceLabel: 'सन्दर्भ-पाठ और पाठ-परंपरा', sourceUrl: 'https://rajayog.in/hi/mantras/mantra/ya-devi-sarva-bhuteshu/',
      text: 'या देवी सर्वभूतेषु शक्तिरूपेण संस्थिता । नमस्तस्यै नमस्तस्यै नमस्तस्यै नमो नमः ॥',
      note: 'यह सामान्य स्तुति-पाठ है, वैदिक संहिता-पाठ नहीं।'
    },
    {
      id: 'shiva-panchakshara', category: 'पुराण एवं स्तोत्र', title: 'शिवपञ्चाक्षरस्तोत्रम् — नागेन्द्रहाराय',
      reference: 'परंपरागत शिव-स्तोत्र; स्तोत्र-संग्रहों में प्रचलित पाठ',
      sourceLabel: 'Sanskrit Documents', sourceUrl: 'https://sanskritdocuments.org/',
      text: 'नागेन्द्रहाराय त्रिलोचनाय भस्माङ्गरागाय महेश्वराय । नित्याय शुद्धाय दिगम्बराय तस्मै नकाराय नमः शिवाय ॥',
      note: 'दन्त्य/मूर्धन्य श, ष, स और संयुक्त पदों का अभ्यास।'
    },
    {
      id: 'mangala-vagartha', category: 'महाकाव्य एवं गीता', title: 'रघुवंशम् १.१ — वागर्थाविव सम्पृक्तौ',
      reference: 'कालिदास, रघुवंश महाकाव्य 1.1 (यह पुराण नहीं, शास्त्रीय महाकाव्य है)',
      sourceLabel: 'Sanskrit Sahitya', sourceUrl: 'https://www.sanskritsahitya.org/',
      text: 'वागर्थाविव सम्पृक्तौ वागर्थप्रतिपत्तये । जगतः पितरौ वन्दे पार्वतीपरमेश्वरौ ॥',
      note: 'संधि और संयुक्ताक्षर अभ्यास; इसे शास्त्रीय महाकाव्य के रूप में वर्गीकृत किया गया है।'
    }
  ]);

  let generatedLibraryEntries = [];
  let libraryPanelElements = null;

  function splitIntoSafeChunks(values, maxChars = 540, joiner = ' ') {
    const chunks = [];
    let current = [];
    let length = 0;
    for (const value of values) {
      const token = String(value ?? '').trim();
      if (!token) continue;
      const addedLength = token.length + (current.length ? joiner.length : 0);
      if (current.length && length + addedLength > maxChars) {
        chunks.push(current.join(joiner));
        current = [];
        length = 0;
      }
      current.push(token);
      length += token.length + (current.length > 1 ? joiner.length : 0);
    }
    if (current.length) chunks.push(current.join(joiner));
    return chunks;
  }

  function buildGeneratedLibrary(master) {
    const entries = [];
    const addChunks = (prefix, category, title, values, note, maxChars = 540) => {
      splitIntoSafeChunks(values, maxChars).forEach((text, index, all) => {
        entries.push({
          id: `${prefix}-${index + 1}`,
          category,
          title: all.length > 1 ? `${title} — खण्ड ${index + 1}/${all.length}` : title,
          reference: `Master dataset ${master.datasetVersion || 'version unknown'}`,
          sourceLabel: 'इस ऐप की स्थानीय Sanskrit–Vedic master JSON',
          sourceUrl: '', text, note
        });
      });
    };

    const inventory = master.characterInventory;
    addChunks(
      'master-vowels', 'वर्ण एवं उच्चारण अभ्यास', 'Master JSON के स्वतंत्र स्वर',
      inventory.independentVowels,
      'यह master JSON में दर्ज वर्ण-सूची है; विस्तारित/दुर्लभ वर्ण आधुनिक उच्चारण में समान रूप से प्रयुक्त नहीं होते।'
    );

    const consonantRows = Object.entries(inventory.consonantsByArticulationGroup || {})
      .map(([group, chars]) => `${group}: ${chars.join(' ')}`);
    addChunks(
      'master-consonant-groups', 'वर्ण एवं उच्चारण अभ्यास', 'Master JSON के उच्चारण-स्थानानुसार व्यंजन-वर्ग',
      consonantRows,
      'वर्ग-लेबल तकनीकी grouping हैं; TTS नाम बोल सकता है, phoneme-level अभ्यास की गारंटी नहीं है।'
    );

    addChunks(
      'master-consonants', 'वर्ण एवं उच्चारण अभ्यास', 'Master JSON के सभी व्यंजन',
      inventory.consonants,
      'यह वर्तमान master JSON की व्यंजन-सूची है; इसे सभी ऐतिहासिक/वैदिक लिपि-रूपों की सार्वभौमिक सूची न मानें।'
    );

    addChunks(
      'master-matras', 'वर्ण एवं उच्चारण अभ्यास', 'Master JSON के स्वरचिह्न',
      inventory.dependentVowelSigns,
      'दृश्य स्वरचिह्न सूची; इनके वास्तविक phonetic realization को सुनकर जाँचना आवश्यक है।'
    );

    addChunks(
      'master-digits', 'वर्ण एवं उच्चारण अभ्यास', 'Master JSON के देवनागरी अंक',
      inventory.digits,
      'अंक-पहचान अभ्यास; इन्हें संस्कृत शब्दों के उच्चारण का प्रशिक्षण न समझें।'
    );

    addChunks(
      'master-punctuation', 'वर्ण एवं उच्चारण अभ्यास', 'Master JSON के विरामचिह्न',
      inventory.punctuation,
      'विरामचिह्नों का दृश्य अभ्यास; उच्चारण में विराम की अवधि पाठ-परंपरा और वाचन-शैली से तय होती है।'
    );

    addChunks(
      'master-extended', 'वर्ण एवं उच्चारण अभ्यास', 'Master JSON के विस्तारित देवनागरी वर्ण',
      inventory.extendedDevanagariLetters,
      'ये विस्तारित/क्षेत्रीय देवनागरी वर्ण हैं; सभी को मूल संस्कृत phoneme न समझें।'
    );

    addChunks(
      'master-marks', 'वर्ण एवं उच्चारण अभ्यास', 'Master JSON के सामान्य चिह्न',
      (inventory.generalMarks || []).map(mark => `${mark.char} (${mark.name})`),
      'अनुस्वार, विसर्ग, चन्द्रबिन्दु, अवग्रह, हलन्त और विरामचिह्नों को मूल पाठ में ज्यों का त्यों सुरक्षित रखें。',
'
