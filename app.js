'use strict';

/*
 * Lalita-Sahasranama-Ratnavali
 * TTS + Suvichar 9:16 Display
 *
 * Locked Target Voice Profile
 */
const targetVoiceProfile = Object.freeze({
  timbre: 9.5,
  pitch: 8.5,
  prosody: 9.5,
  pronunciationArticulation: 9.0,
  speakingRateTempo: 8.5,
  pitchVariationResonance: 9.5
});

const $ = id => document.getElementById(id);

const state = {
  initialized: false,
  voices: [],
  voice: null,

  queue: [],
  currentIndex: -1,

  playing: false,
  paused: false,
  speechToken: 0,

  objectUrl: '',
  videoReady: false,
  photoUrl: '',

  textColorIndex: 0
};

const COLORS = [
  '#e91e63',
  '#9c27b0',
  '#3f51b5',
  '#009688',
  '#00897b',
  '#f57c00',
  '#d84315',
  '#c62828',
  '#6d4c41',
  '#1565c0'
];

const speech = () =>
  'speechSynthesis' in window
    ? window.speechSynthesis
    : null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ---------------------------------------
   TTS PROFILE
--------------------------------------- */

function getProfileRate() {
  /*
   * User-facing rate remains adjustable.
   * Locked target profile establishes the devotional baseline.
   */
  const slider = Number(
    $('ttsRate')?.value || 0.9
  );

  const profileBaseline =
    0.9 +
    (
      (targetVoiceProfile.speakingRateTempo - 5) /
      5
    ) * 0.03;

  return clamp(
    profileBaseline +
      (slider - 0.9),
    0.6,
    1.2
  );
}

function getProfilePitch(index) {
  const base =
    1 +
    (
      (targetVoiceProfile.pitch - 5) /
      5
    ) * 0.06;

  const variation =
    0.006 +
    (
      targetVoiceProfile.pitchVariationResonance /
      10
    ) * 0.012;

  const cycle = [
    0,
    1,
    -0.55,
    0.65,
    -0.30
  ];

  return clamp(
    base +
      cycle[index % cycle.length] *
        variation,
    0.5,
    2
  );
}

function prepareSpeechText(text) {
  return String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/* ---------------------------------------
   VOICE SELECTION
--------------------------------------- */

function isSanskritVoice(voice) {
  if (!voice) return false;

  const lang =
    String(voice.lang || '').toLowerCase();

  const descriptor =
    `${voice.name || ''} ${voice.voiceURI || ''}`;

  return (
    lang === 'sa' ||
    lang.startsWith('sa-') ||
    /sanskrit|संस्कृत|vedic|वेद/i.test(
      descriptor
    )
  );
}

function isFemaleVoice(voice) {
  if (!voice) return false;

  const descriptor =
    `${voice.name || ''} ${voice.voiceURI || ''}`;

  return /female|woman|girl|lady|स्त्री|महिला|nari|नारी/i.test(
    descriptor
  );
}

function refreshVoices() {
  const synth = speech();

  if (!synth) return;

  state.voices = synth.getVoices();

  /*
   * Prefer explicitly identified Sanskrit female voice.
   */
  state.voice =
    state.voices.find(
      voice =>
        isSanskritVoice(voice) &&
        isFemaleVoice(voice)
    ) || null;

  /*
   * If the browser has a Sanskrit voice but does not expose
   * gender metadata, use the Sanskrit voice rather than
   * silently switching to a non-Sanskrit voice.
   */
  if (!state.voice) {
    state.voice =
      state.voices.find(
        voice =>
          isSanskritVoice(voice)
      ) || null;
  }

  updateVoiceStatus();
}

function updateVoiceStatus() {
  const el =
    $('ttsVoiceStatus');

  if (!el) return;

  if (state.voice) {
    el.textContent =
      `Voice: ${state.voice.name} (${state.voice.lang || 'sa-IN'})`;
    return;
  }

  el.textContent =
    'संस्कृत TTS voice उपलब्ध नहीं है।';
}

/* ---------------------------------------
   UTTERANCE
--------------------------------------- */

function createUtterance(
  text,
  index,
  token
) {
  const utterance =
    new SpeechSynthesisUtterance(
      prepareSpeechText(text)
    );

  utterance.lang = 'sa-IN';

  utterance.rate =
    getProfileRate();

  utterance.pitch =
    getProfilePitch(index);

  utterance.volume = 1;

  if (state.voice) {
    utterance.voice =
      state.voice;
  }

  utterance.onstart = () => {
    if (
      token !==
      state.speechToken
    ) {
      return;
    }

    state.playing = true;
    state.paused = false;

    updatePlaybackButtons();
    setStatus(
      'सुविचार का वाचन चल रहा है…'
    );
  };

  utterance.onend = () => {
    if (
      token !==
      state.speechToken
    ) {
      return;
    }

    /*
     * VERY IMPORTANT:
     * The next text is displayed only after
     * the current text has been completely spoken.
     */
    playNextSuvichar();
  };

  utterance.onerror = event => {
    if (
      token !==
      state.speechToken
    ) {
      return;
    }

    state.playing = false;
    state.paused = true;

    updatePlaybackButtons();

    setStatus(
      `TTS त्रुटि: ${event?.error || 'अज्ञात त्रुटि'}`
    );
  };

  return utterance;
}

/* ---------------------------------------
   DISPLAY
--------------------------------------- */

function displaySuvichar(item) {
  const display =
    $('suvicharDisplay');

  if (!display) return;

  const text =
    String(item.text || '').trim();

  display.textContent = text;

  const color =
    COLORS[
      state.textColorIndex %
      COLORS.length
    ];

  state.textColorIndex += 1;

  display.style.color = color;

  display.classList.remove(
    'suvichar-enter'
  );

  /*
   * Reflow forces the animation to restart
   * for each new text.
   */
  void display.offsetWidth;

  display.classList.add(
    'suvichar-enter'
  );
}

function displayPhoto() {
  const image =
    $('displayPhoto');

  const placeholder =
    $('photoPlaceholder');

  if (!image) return;

  if (state.photoUrl) {
    image.src = state.photoUrl;
    image.hidden = false;

    if (placeholder) {
      placeholder.hidden = true;
    }

    return;
  }

  image.removeAttribute('src');
  image.hidden = true;

  if (placeholder) {
    placeholder.hidden = false;
  }
}

/* ---------------------------------------
   QUEUE
--------------------------------------- */

function addSuvichar() {
  const input =
    $('suvicharInput');

  if (!input) return;

  const text =
    String(input.value || '').trim();

  if (!text) {
    setStatus(
      'कृपया पहले सुविचार लिखें।'
    );
    input.focus();
    return;
  }

  state.queue.push({
    id:
      `suvichar-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    text
  });

  input.value = '';

  renderQueue();

  setStatus(
    'सुविचार queue में जोड़ दिया गया है।'
  );

  input.focus();

  if (
    state.currentIndex === -1 &&
    !state.playing
  ) {
    showQueueFirst();
  }
}

function removeSuvichar(index) {
  if (
    index < 0 ||
    index >= state.queue.length
  ) {
    return;
  }

  /*
   * Do not allow queue mutation while
   * a text is being spoken.
   */
  if (state.playing) {
    setStatus(
      'वाचन पूर्ण होने तक queue में बदलाव न करें।'
    );
    return;
  }

  state.queue.splice(index, 1);

  if (
    state.currentIndex >=
    state.queue.length
  ) {
    state.currentIndex =
      state.queue.length - 1;
  }

  renderQueue();

  if (
    state.currentIndex >= 0 &&
    state.queue[state.currentIndex]
  ) {
    displaySuvichar(
      state.queue[
        state.currentIndex
      ]
    );
  }
}

function renderQueue() {
  const list =
    $('suvicharQueue');

  const count =
    $('queueCount');

  if (count) {
    count.textContent =
      String(state.queue.length);
  }

  if (!list) return;

  list.replaceChildren();

  state.queue.forEach(
    (item, index) => {
      const row =
        document.createElement('div');

      row.className =
        'queue-item';

      if (
        index ===
        state.currentIndex
      ) {
        row.classList.add(
          'current'
        );
      }

      const number =
        document.createElement('span');

      number.className =
        'queue-number';

      number.textContent =
        String(index + 1);

      const text =
        document.createElement('span');

      text.className =
        'queue-text';

      text.textContent =
        item.text;

      const remove =
        document.createElement('button');

      remove.type =
        'button';

      remove.className =
        'queue-remove';

      remove.textContent =
        '×';

      remove.title =
        'सुविचार हटाएँ';

      remove.addEventListener(
        'click',
        () => removeSuvichar(index)
      );

      row.append(
        number,
        text,
        remove
      );

      list.append(row);
    }
  );
}

function showQueueFirst() {
  if (!state.queue.length) {
    return;
  }

  state.currentIndex = 0;

  displaySuvichar(
    state.queue[0]
  );

  renderQueue();
}

/* ---------------------------------------
   PLAYBACK
--------------------------------------- */

function playCurrentSuvichar() {
  const synth = speech();

  if (!synth) {
    setStatus(
      'इस Browser में Speech Synthesis उपलब्ध नहीं है।'
    );
    return false;
  }

  if (!state.queue.length) {
    setStatus(
      'पहले कम-से-कम एक सुविचार जोड़ें।'
    );
    return false;
  }

  if (!state.voice) {
    refreshVoices();
  }

  if (!state.voice) {
    setStatus(
      'संस्कृत TTS voice उपलब्ध नहीं है।'
    );
    return false;
  }

  if (
    state.currentIndex < 0 ||
    state.currentIndex >=
      state.queue.length
  ) {
    state.currentIndex = 0;
  }

  /*
   * Display is set BEFORE speech starts.
   * The next display is changed only from onend().
   */
  displaySuvichar(
    state.queue[
      state.currentIndex
    ]
  );

  const token =
    ++state.speechToken;

  const utterance =
    createUtterance(
      state.queue[
        state.currentIndex
      ].text,
      state.currentIndex,
      token
    );

  state.playing = true;
  state.paused = false;

  updatePlaybackButtons();

  try {
    synth.speak(
      utterance
    );

    return true;
  } catch (error) {
    state.playing = false;
    state.paused = true;

    updatePlaybackButtons();

    setStatus(
      `TTS प्रारंभ नहीं हो सका: ${error.message}`
    );

    return false;
  }
}

function playNextSuvichar() {
  /*
   * Current text is already completely spoken.
   * Only NOW is the next text allowed to appear.
   */
  if (
    state.currentIndex <
    state.queue.length - 1
  ) {
    state.currentIndex += 1;

    renderQueue();

    playCurrentSuvichar();

    return;
  }

  /*
   * Queue finished.
   */
  state.playing = false;
  state.paused = false;

  updatePlaybackButtons();

  setStatus(
    'सभी सुविचारों का वाचन पूर्ण हुआ।'
  );
}

function playAll() {
  const synth = speech();

  if (!synth) {
    setStatus(
      'इस Browser में TTS उपलब्ध नहीं है।'
    );
    return;
  }

  if (!state.queue.length) {
    setStatus(
      'पहले सुविचार जोड़ें।'
    );
    return;
  }

  /*
   * Resume native speech if it was paused.
   */
  if (
    state.paused &&
    synth.paused
  ) {
    try {
      synth.resume();

      state.playing = true;
      state.paused = false;

      updatePlaybackButtons();

      setStatus(
        'वाचन पुनः जारी है।'
      );

      return;
    } catch (error) {
      setStatus(
        'वाचन resume नहीं हो सका।'
      );
    }
  }

  if (state.playing) {
    return;
  }

  if (
    state.currentIndex < 0 ||
    state.currentIndex >=
      state.queue.length
  ) {
    state.currentIndex = 0;
  }

  playCurrentSuvichar();
}

function pauseAll() {
  const synth = speech();

  if (
    !state.playing ||
    !synth
  ) {
    return;
  }

  try {
    synth.pause();

    state.paused = true;

    updatePlaybackButtons();

    setStatus(
      'वाचन paused है।'
    );
  } catch (error) {
    setStatus(
      'TTS pause नहीं हो सका।'
    );
  }
}

function stopAll() {
  const synth = speech();

  state.speechToken += 1;

  try {
    synth?.cancel();
  } catch (error) {
    // Browser TTS unavailable.
  }

  state.playing = false;
  state.paused = false;
  state.currentIndex = -1;

  updatePlaybackButtons();

  if (state.queue.length) {
    displaySuvichar(
      state.queue[0]
    );
  } else {
    clearDisplay();
  }

  renderQueue();

  setStatus(
    'वाचन बंद कर दिया गया।'
  );
}

function clearDisplay() {
  const display =
    $('suvicharDisplay');

  if (display) {
    display.textContent =
      'आपका सुविचार यहाँ प्रदर्शित होगा';
  }
}

/* ---------------------------------------
   VIDEO
--------------------------------------- */

function uploadVideo(event) {
  const file =
    event.target.files?.[0];

  if (!file) return;

  if (
    !file.type.startsWith('video/')
  ) {
    setStatus(
      'कृपया केवल video file चुनें।'
    );

    event.target.value = '';

    return;
  }

  if (state.objectUrl) {
    URL.revokeObjectURL(
      state.objectUrl
    );
  }

  state.objectUrl =
    URL.createObjectURL(file);

  const video =
    $('videoPlayer');

  const placeholder =
    $('videoPlaceholder');

  if (!video) return;

  video.src =
    state.objectUrl;

  video.loop = true;

  video.muted = true;

  video.playsInline = true;

  state.videoReady = false;

  video.onloadedmetadata = () => {
    const width =
      video.videoWidth;

    const height =
      video.videoHeight;

    if (
      width &&
      height &&
      width * 16 ===
        height * 9
    ) {
      state.videoReady = true;

      if (placeholder) {
        placeholder.hidden = true;
      }

      setStatus(
        `9:16 वीडियो तैयार है: ${file.name}`
      );

      return;
    }

    state.videoReady = false;

    setStatus(
      `वीडियो का अनुपात ${width}:${height} है। 9:16 वीडियो आवश्यक है।`
    );
  };

  video.load();
}

/*
 * During TTS the video continuously loops.
 * This function is intentionally independent of TTS completion.
 */
async function startVideoLoop() {
  const video =
    $('videoPlayer');

  if (
    !video ||
    !state.videoReady
  ) {
    return;
  }

  video.loop = true;

  try {
    await video.play();
  } catch (error) {
    setStatus(
      'वीडियो playback प्रारंभ नहीं हो सका।'
    );
  }
}

function stopVideo() {
  const video =
    $('videoPlayer');

  if (!video) return;

  video.pause();
  video.currentTime = 0;
}

/* ---------------------------------------
   PHOTO
--------------------------------------- */

function uploadPhoto(event) {
  const file =
    event.target.files?.[0];

  if (!file) return;

  if (
    !file.type.startsWith('image/')
  ) {
    setStatus(
      'कृपया केवल image file चुनें।'
    );

    event.target.value = '';

    return;
  }

  if (state.photoUrl) {
    URL.revokeObjectURL(
      state.photoUrl
    );
  }

  state.photoUrl =
    URL.createObjectURL(file);

  displayPhoto();

  setStatus(
    `फोटो तैयार है: ${file.name}`
  );
}

function removePhoto() {
  if (state.photoUrl) {
    URL.revokeObjectURL(
      state.photoUrl
    );
  }

  state.photoUrl = '';

  const input =
    $('photoUpload');

  if (input) {
    input.value = '';
  }

  displayPhoto();

  setStatus(
    'फोटो हटा दी गई।'
  );
}

/* ---------------------------------------
   UI
--------------------------------------- */

function setStatus(text) {
  const el =
    $('systemStatus');

  if (el) {
    el.textContent =
      String(text);
  }
}

function updatePlaybackButtons() {
  const play =
    $('playButton');

  const pause =
    $('pauseButton');

  const stop =
    $('stopButton');

  if (play) {
    play.disabled =
      state.playing;
  }

  if (pause) {
    pause.disabled =
      !state.playing;
  }

  if (stop) {
    stop.disabled =
      !state.playing &&
      !state.paused;
  }
}

function updateRateLabel() {
  const input =
    $('ttsRate');

  const value =
    $('ttsRateValue');

  if (!input || !value) return;

  value.textContent =
    Number(input.value).toFixed(2);
}

/* ---------------------------------------
   EVENT BINDING
--------------------------------------- */

function bindEvents() {
  $('addSuvichar')
    ?.addEventListener(
      'click',
      addSuvichar
    );

  $('playButton')
    ?.addEventListener(
      'click',
      playAll
    );

  $('pauseButton')
    ?.addEventListener(
      'click',
      pauseAll
    );

  $('stopButton')
    ?.addEventListener(
      'click',
      stopAll
    );

  $('videoUpload')
    ?.addEventListener(
      'change',
      uploadVideo
    );

  $('photoUpload')
    ?.addEventListener(
      'change',
      uploadPhoto
    );

  $('removePhotoButton')
    ?.addEventListener(
      'click',
      removePhoto
    );

  $('ttsRate')
    ?.addEventListener(
      'input',
      updateRateLabel
    );

  $('suvicharInput')
    ?.addEventListener(
      'keydown',
      event => {
        /*
         * Ctrl+Enter adds the text.
         * Enter alone remains available for normal typing.
         */
        if (
          event.ctrlKey &&
          event.key === 'Enter'
        ) {
          event.preventDefault();
          addSuvichar();
        }
      }
    );

  const synth =
    speech();

  synth?.addEventListener(
    'voiceschanged',
    refreshVoices
  );
}

/* ---------------------------------------
   INIT
--------------------------------------- */

function init() {
  if (state.initialized) {
    return;
  }

  state.initialized = true;

  refreshVoices();
  bindEvents();

  updateRateLabel();
  updatePlaybackButtons();
  displayPhoto();
  renderQueue();

  if (!speech()) {
    setStatus(
      'इस Browser में Speech Synthesis उपलब्ध नहीं है।'
    );
  } else if (!state.voice) {
    setStatus(
      'TTS तैयार है; संस्कृत voice उपलब्ध होने की प्रतीक्षा है।'
    );
  } else {
    setStatus(
      'TTS और सुविचार panel तैयार है।'
    );
  }

  /*
   * Video is prepared for continuous looping,
   * but does not start until Play is pressed.
   */
  const video =
    $('videoPlayer');

  if (video) {
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
  }
}

window.addEventListener(
  'beforeunload',
  () => {
    try {
      speech()?.cancel();
    } catch (error) {
      // Ignore cleanup errors.
    }

    if (state.objectUrl) {
      URL.revokeObjectURL(
        state.objectUrl
      );
    }

    if (state.photoUrl) {
      URL.revokeObjectURL(
        state.photoUrl
      );
    }
  }
);

init();
