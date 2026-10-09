
/* ============================================================
   SANSKRIT–VEDIC MASTER INTEGRATION
   Mode: READ-ONLY ANALYSIS
   Voice selection and existing TTS pipeline remain untouched.
   JSON path: ./language/sanskrit-vedic-master.json
   ============================================================ */

(function installSanskritVedicMaster() {
  'use strict';

  const MASTER_URL = './language/sanskrit-vedic-master.json';

  let masterData = null;
  let loadPromise = null;
  let loadStatus = 'not-loaded';
  let loadError = '';
  let characterMetadataCache = null;
  let termIndexCache = null;

  function validateMaster(data) {
    return Boolean(
      data &&
      typeof data === 'object' &&
      data.id === 'sanskrit-vedic-master' &&
      data.characterInventory &&
      typeof data.characterInventory === 'object' &&
      Array.isArray(data.vedicAccentMarks) &&
      data.unicodeRanges &&
      typeof data.unicodeRanges === 'object' &&
      data.conjunctPatterns &&
      Array.isArray(data.conjunctPatterns.patterns) &&
      Array.isArray(data.lexiconEntries) &&
      data.integrationContract &&
      data.integrationContract.consumer === 'app.js'
    );
  }

  async function loadSanskritVedicMaster() {
    if (masterData) {
      return masterData;
    }

    if (loadPromise) {
      return loadPromise;
    }

    loadStatus = 'loading';
    loadError = '';

    loadPromise = (async function () {
      try {
        if (typeof fetch !== 'function') {
          throw new Error('इस browser में fetch उपलब्ध नहीं है।');
        }

        const response = await fetch(MASTER_URL, {
          cache: 'no-cache'
        });

        if (!response || !response.ok) {
          throw new Error(
            'JSON लोड नहीं हुई। HTTP स्थिति: ' +
            (response ? response.status : 'response unavailable')
          );
        }

        const parsedData = await response.json();

        if (!validateMaster(parsedData)) {
          throw new Error(
            'JSON की संरचना अपेक्षित Sanskrit/Vedic schema से मेल नहीं खाती।'
          );
        }

        masterData = parsedData;
        characterMetadataCache = null;
        termIndexCache = null;
        loadStatus = 'ready';

        return masterData;
      } catch (error) {
        masterData = null;
        loadStatus = 'error';
        loadError = String(
          error && error.message
            ? error.message
            : error || 'अज्ञात त्रुटि'
        );

        /*
         * जानबूझकर speechSynthesis.cancel(), state.voice,
         * voiceSelect, pitch, rate या playback को नहीं छूते।
         */
        if (typeof console !== 'undefined' &&
            typeof console.warn === 'function') {
          console.warn(
            '[Sanskrit-Vedic Master] ज्ञान-फाइल लोड नहीं हुई। ' +
            'मौजूदा TTS प्रणाली इससे स्वतंत्र है।',
            loadError
          );
        }

        return null;
      } finally {
        loadPromise = null;
      }
    })();

    return loadPromise;
  }

  function getStatus() {
    return {
      status: loadStatus,
      loaded: Boolean(masterData),
      error: loadError,
      id: masterData ? masterData.id : null,
      schemaVersion: masterData
        ? masterData.schemaVersion || null
        : null,
      datasetVersion: masterData
        ? masterData.datasetVersion || null
        : null,
      lexiconEntryCount: masterData &&
        Array.isArray(masterData.lexiconEntries)
          ? masterData.lexiconEntries.length
          : 0
    };
  }

  function formatCodePoint(character) {
    return Array.from(String(character || ''))
      .map(function (part) {
        return 'U+' +
          part.codePointAt(0)
            .toString(16)
            .toUpperCase()
            .padStart(4, '0');
      })
      .join(' ');
  }

  function isRelevantDevanagariCodePoint(codePoint) {
    return (
      (codePoint >= 0x0900 && codePoint <= 0x097F) ||
      (codePoint >= 0x1CD0 && codePoint <= 0x1CFF) ||
      (codePoint >= 0xA8E0 && codePoint <= 0xA8FF)
    );
  }

  function getCharacterMetadata() {
    if (characterMetadataCache) {
      return characterMetadataCache;
    }

    if (!masterData) {
      return new Map();
    }

    const metadata = new Map();

    function addCharacter(character, category, name) {
      if (typeof character !== 'string' || !character) {
        return;
      }

      const existing = metadata.get(character) || {
        character: character,
        categories: [],
        names: []
      };

      if (
        category &&
        !existing.categories.includes(category)
      ) {
        existing.categories.push(category);
      }

      if (name && !existing.names.includes(name)) {
        existing.names.push(name);
      }

      metadata.set(character, existing);
    }

    function addArray(items, category) {
      if (!Array.isArray(items)) {
        return;
      }

      items.forEach(function (character) {
        addCharacter(character, category, '');
      });
    }

    const inventory = masterData.characterInventory || {};

    addArray(inventory.independentVowels, 'स्वतंत्र स्वर');
    addArray(inventory.consonants, 'व्यंजन');
    addArray(inventory.dependentVowelSigns, 'मात्रा');
    addArray(
      inventory.extendedDevanagariLetters,
      'विस्तारित देवनागरी अक्षर'
    );
    addArray(inventory.digits, 'देवनागरी अंक');
    addArray(inventory.punctuation, 'विराम-चिह्न');

    Object.entries(
      inventory.consonantsByArticulationGroup || {}
    ).forEach(function (entry) {
      addArray(entry[1], 'उच्चारण-स्थान समूह: ' + entry[0]);
    });

    (inventory.generalMarks || []).forEach(function (item) {
      if (item && typeof item === 'object') {
        addCharacter(
          item.char,
          item.role || 'सामान्य चिह्न',
          item.name || ''
        );
      }
    });

    (masterData.vedicAccentMarks || []).forEach(function (item) {
      if (item && typeof item === 'object') {
        addCharacter(
          item.char,
          'वैदिक स्वर-चिह्न',
          item.name || ''
        );
      }
    });

    Object.entries(masterData.unicodeRanges || {})
      .forEach(function (entry) {
        const rangeName = entry[0];
        const range = entry[1];

        if (!range || !Array.isArray(range.assignedCharacters)) {
          return;
        }

        range.assignedCharacters.forEach(function (item) {
          if (item && typeof item === 'object') {
            addCharacter(
              item.char,
              'Unicode सूची: ' + rangeName,
              item.unicodeName || item.name || ''
            );
          }
        });
      });

    characterMetadataCache = metadata;
    return metadata;
  }

  function recognizeDevanagariCharacters(text) {
    const source = String(text ?? '');
    const metadata = getCharacterMetadata();
    const counts = new Map();

    for (const character of source) {
      if (/\s/u.test(character)) {
        continue;
      }

      counts.set(
        character,
        (counts.get(character) || 0) + 1
      );
    }

    const recognized = [];
    const unlisted = [];

    for (const entry of counts.entries()) {
      const character = entry[0];
      const count = entry[1];
      const codePoint = character.codePointAt(0);
      const info = metadata.get(character);

      if (info) {
        recognized.push({
          character: character,
          codePoint: formatCodePoint(character),
          count: count,
          categories: info.categories.slice(),
          names: info.names.slice()
        });
      } else if (isRelevantDevanagariCodePoint(codePoint)) {
        unlisted.push({
          character: character,
          codePoint: formatCodePoint(character),
          count: count
        });
      }
    }

    function sortByCodePoint(a, b) {
      return a.character.codePointAt(0) -
        b.character.codePointAt(0);
    }

    recognized.sort(sortByCodePoint);
    unlisted.sort(sortByCodePoint);

    return {
      sourceText: source,
      loaded: Boolean(masterData),
      originalTextPreserved: true,
      distinctNonWhitespaceCharacters: counts.size,
      recognizedCharacters: recognized,
      unlistedDevanagariCharacters: unlisted,
      note: 'यह पहचान उपलब्ध डेटासेट पर आधारित है; सूची से बाहर वर्ण को स्वतः अमान्य नहीं माना जाना चाहिए।'
    };
  }

  function detectVedicMarks(text) {
    const source = String(text ?? '');

    if (!masterData) {
      return {
        sourceText: source,
        loaded: false,
        marks: [],
        note: 'Master JSON अभी उपलब्ध नहीं है।'
      };
    }

    const markMap = new Map();

    function addMark(character, name, codePoint, handling) {
      if (typeof character !== 'string' || !character) {
        return;
      }

      const previous = markMap.get(character);

      markMap.set(character, {
        character: character,
        codePoint: codePoint || formatCodePoint(character),
        name: name || previous?.name || 'वैदिक Unicode चिह्न',
        handling: handling || previous?.handling || 'preserve'
      });
    }

    (masterData.vedicAccentMarks || []).forEach(function (item) {
      if (item && typeof item === 'object') {
        addMark(
          item.char,
          item.name,
          item.codePoint,
          item.handling
        );
      }
    });

    const extensionCharacters =
      masterData.unicodeRanges?.vedicExtensions?.assignedCharacters || [];

    extensionCharacters.forEach(function (item) {
      if (!item || typeof item !== 'object') {
        return;
      }

      const category = String(item.generalCategory || '');

      if (/^(M|P)/.test(category)) {
        addMark(
          item.char,
          item.unicodeName || item.name,
          item.codePoint,
          'preserve'
        );
      }
    });

    const occurrences = [];

    for (const entry of markMap.entries()) {
      const character = entry[0];
      const metadata = entry[1];
      let from = 0;

      while (from < source.length) {
        const index = source.indexOf(character, from);

        if (index < 0) {
          break;
        }

        occurrences.push({
          ...metadata,
          index: index
        });

        from = index + character.length;
      }
    }

    occurrences.sort(function (a, b) {
      return a.index - b.index ||
        a.character.localeCompare(b.character);
    });

    return {
      sourceText: source,
      loaded: true,
      marks: occurrences,
      distinctMarks: new Set(
        occurrences.map(function (item) {
          return item.character;
        })
      ).size,
      note: 'चिह्न की पहचान उसके वैदिक उच्चारण या शाखा-विशिष्ट ध्वनि को प्रमाणित नहीं करती।'
    };
  }

  function getTermIndex() {
    if (termIndexCache) {
      return termIndexCache;
    }

    if (!masterData) {
      return [];
    }

    const bySurface = new Map();

    (masterData.lexiconEntries || []).forEach(function (entry) {
      const surface = String(entry?.surface || '');

      if (!surface || Array.from(surface).length < 2) {
        return;
      }

      if (!bySurface.has(surface)) {
        bySurface.set(surface, []);
      }

      bySurface.get(surface).push(entry);
    });

    termIndexCache = Array.from(bySurface.entries())
      .map(function (entry) {
        return {
          surface: entry[0],
          entries: entry[1]
        };
      })
      .sort(function (a, b) {
        return Array.from(b.surface).length -
          Array.from(a.surface).length ||
          a.surface.localeCompare(b.surface, 'hi');
      });

    return termIndexCache;
  }

  function lookupSanskritTerms(text) {
    const source = String(text ?? '');

    if (!masterData) {
      return {
        sourceText: source,
        loaded: false,
        matches: [],
        note: 'Master JSON अभी उपलब्ध नहीं है।'
      };
    }

    const found = [];

    getTermIndex().forEach(function (term) {
      const firstIndex = source.indexOf(term.surface);

      if (firstIndex < 0) {
        return;
      }

      const positions = [];
      let from = 0;

      while (from < source.length && positions.length < 10) {
        const index = source.indexOf(term.surface, from);

        if (index < 0) {
          break;
        }

        positions.push(index);
        from = index + Math.max(term.surface.length, 1);
      }

      found.push({
        surface: term.surface,
        codePointLength: Array.from(term.surface).length,
        occurrences: positions,
        occurrenceCount: positions.length,
        entries: term.entries.map(function (entry) {
          return {
            domain: entry.domain ?? null,
            lemma: entry.lemma ?? null,
            morphology: entry.morphology ?? null,
            sourceWork: entry.sourceWork ?? null,
            sourceLocation: entry.sourceLocation ?? null,
            pronunciationHint: entry.pronunciationHint ?? null,
            pronunciationVerified:
              entry.pronunciationVerified === true,
            notes: Array.isArray(entry.notes)
              ? entry.notes.slice(0, 2)
              : []
          };
        })
      });
    });

    found.sort(function (a, b) {
      return b.codePointLength - a.codePointLength ||
        a.occurrences[0] - b.occurrences[0];
    });

    return {
      sourceText: source,
      loaded: true,
      searchedUniqueSurfaces: getTermIndex().length,
      totalUniqueMatches: found.length,
      matches: found.slice(0, 100),
      truncated: found.length > 100,
      note: 'ये मूल-पाठ में substring पर आधारित संभावित मिलान हैं; इन्हें प्रमाणित शब्द-सीमा, रूप-विचार या व्युत्पत्ति न मानें।'
    };
  }

  function segmentConjunctCandidates(text) {
    const source = String(text ?? '');

    if (!masterData) {
      return {
        sourceText: source,
        loaded: false,
        candidates: [],
        note: 'Master JSON अभी उपलब्ध नहीं है।'
      };
    }

    const patterns = Array.from(
      new Set(masterData.conjunctPatterns?.patterns || [])
    )
      .filter(function (pattern) {
        return typeof pattern === 'string' && pattern.length > 1;
      })
      .sort(function (a, b) {
        return Array.from(b).length - Array.from(a).length;
      });

    const candidates = [];

    patterns.forEach(function (pattern) {
      let from = 0;

      while (from < source.length) {
        const index = source.indexOf(pattern, from);

        if (index < 0) {
          break;
        }

        candidates.push({
          pattern: pattern,
          index: index,
          endIndex: index + pattern.length,
          codePoint: formatCodePoint(pattern)
        });

        from = index + Math.max(pattern.length, 1);
      }
    });

    candidates.sort(function (a, b) {
      return a.index - b.index ||
        b.pattern.length - a.pattern.length;
    });

    return {
      sourceText: source,
      loaded: true,
      totalCandidates: candidates.length,
      candidates: candidates.slice(0, 250),
      truncated: candidates.length > 250,
      note: 'ये डेटासेट के संयुक्ताक्षर-पैटर्न के स्थान हैं; इन्हें पूर्ण ध्वन्यात्मक segmentation न मानें।'
    };
  }

  function prepareTtsTextWithoutMutation(text) {
    const source = String(text ?? '');

    return {
      originalText: source,
      preparedText: source,
      changed: false,
      policy: masterData?.pronunciationPreparation?.defaultMode ||
        'exact-source-text',
      displayTextImmutable:
        masterData?.textProcessingPolicy?.displayTextImmutable !== false,
      note: 'यह केवल read-only परिणाम है। इसे मौजूदा TTS pipeline में लागू नहीं किया जाता।'
    };
  }

  function analyzeSanskritVedicText(text) {
    const source = String(text ?? '');

    return {
      sourceText: source,
      status: getStatus(),
      preservation: prepareTtsTextWithoutMutation(source),
      characterRecognition: recognizeDevanagariCharacters(source),
      vedicMarks: detectVedicMarks(source),
      lexicalLookup: lookupSanskritTerms(source),
      conjunctCandidates: segmentConjunctCandidates(source)
    };
  }

  const publicTools = Object.freeze({
    loadSanskritVedicMaster: loadSanskritVedicMaster,
    getStatus: getStatus,
    recognizeDevanagariCharacters: recognizeDevanagariCharacters,
    detectVedicMarks: detectVedicMarks,
    lookupSanskritTerms: lookupSanskritTerms,
    segmentConjunctCandidates: segmentConjunctCandidates,
    prepareTtsTextWithoutMutation: prepareTtsTextWithoutMutation,
    analyzeSanskritVedicText: analyzeSanskritVedicText
  });

  if (typeof window !== 'undefined') {
    window.sanskritVedicTools = publicTools;
  }

  /*
   * Knowledge file loads independently.
   * Failure does not cancel, pause, or modify existing TTS.
   */
  void loadSanskritVedicMaster();

})();
