'use strict';

const targetVoiceProfile = Object.freeze({
  timbre: 9.5,
  pitch: 8.5,
  prosody: 9.5,
  pronunciationArticulation: 9.0,
  speakingRateTempo: 8.5,
  pitchVariationResonance: 9.5
});

const state = {
  initialized: false,
  quotes: [],
  index: 0,
  playback: 'idle',
  voice: null,
  voices: [],
  speechToken: 0,
  videoObjectUrl: '',
  photoObjectUrl: '',
  videoReady: false,
  photoReady: false,
  ttsSupported: false,
  voiceLoadTimer: null,
  voiceLoadAttempts: 0,
  photoToken: 0,
  videoToken: 0
};

const PLAYBACK = Object.freeze({
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
  COMPLETED: 'completed'
});

const $ = id => document.getElementById(id);

const quoteInput = $('quoteInput');
const addQuoteButton = $('addQuoteButton');
const clearQuotesButton = $('clearQuotesButton');
const quoteQueue = $('quoteQueue');
const queueCount = $('queueCount');
const photoUpload = $('photoUpload');
const photoStatus = $('photoStatus');
const photoFrame = $('photoFrame');
const stagePhoto = $('stagePhoto');
const removePhotoButton = $('removePhotoButton');
const videoUpload = $('videoUpload');
const videoUploadStatus = $('videoUploadStatus');
const removeVideoButton = $('removeVideoButton');
const videoPlayer = $('videoPlayer');
const videoPlaceholder = $('videoPlaceholder');
const videoStatus = $('videoStatus');
const voiceSelect = $('voiceSelect');
const ttsVoiceStatus = $('ttsVoiceStatus');
const ttsRate = $('ttsRate');
const ttsRateValue = $('ttsRateValue');
const playButton = $('playButton');
const pauseButton = $('pauseButton');
const resumeButton = $('resumeButton');
const stopButton = $('stopButton');
const ttsStatus = $('ttsStatus');
const ttsProgress = $('ttsProgress');
const ttsProgressValue = $('ttsProgressValue');
const quoteCompletion = $('quoteCompletion');
const quoteStage = $('quoteStage');
const stageNow = $('stageNow');
const stageIndex = $('stageIndex');
const completionGate = $('completionGate');
const systemStatus = $('systemStatus');

function synth() {
  return 'speechSynthesis' in window ? window.speechSynthesis : null;
}

function clampRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.9;
  return Math.min(1.2, Math.max(0.6, number));
}

function profileRate() {
  return clampRate(0.90 + ((targetVoiceProfile.speakingRateTempo - 5) / 5) * 0.03);
}

function profilePitch(index) {
  let pitch = 1 + ((targetVoiceProfile.pitch - 5) / 5) * 0.06;
  const prosody = 0.006 + (targetVoiceProfile.prosody / 10) * 0.010;
  const resonance = 0.006 + (targetVoiceProfile.pitchVariationResonance / 10) * 0.012;
  const cycle = [0, 1, -0.55, 0.65, -0.30];
  pitch += cycle[index % cycle.length] * (prosody + resonance);
  return Math.min(2, Math.max(0.5, pitch));
}

function selectedRate() {
  const control = clampRate(ttsRate?.value || 0.9);
  return clampRate(profileRate() + (control - 0.9));
}

function normalizeQuote(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim().replace(/[ \t]+/g, ' '))
    .join('\n')
    .trim();
}

function speechText(text) {
  return normalizeQuote(text).replace(/\n+/g, '। ');
}

function msg(text) {
  if (systemStatus) systemStatus.textContent = text;
}

function updateRateLabel() {
  if (ttsRateValue) ttsRateValue.textContent = Number(ttsRate?.value || 0.9).toFixed(2);
}

function isSanskritVoice(voice) {
  const lang = String(voice?.lang || '').toLowerCase();
  const descriptor = `${voice?.name || ''} ${voice?.voiceURI || ''}`;
  return lang === 'sa' || lang.startsWith('sa-') || /sanskrit|संस्कृत|vedic|वेद/i.test(descriptor);
}

function isIndianVoice(voice) {
  const lang = String(voice?.lang || '').toLowerCase();
  return /^(hi|mr|bn|gu|pa|ta|te|kn|ml|or|ne)(-|$)/i.test(lang);
}

function scheduleVoiceRetry() {
  if (state.voiceLoadTimer || state.voices.length || !state.ttsSupported) return;
  if (state.voiceLoadAttempts >= 20) {
    if (ttsVoiceStatus) {
      ttsVoiceStatus.textContent = 'Browser voice अभी उपलब्ध नहीं हुई। Voice सूची रीफ़्रेश करें या Android/Text-to-Speech settings में voice engine जाँचें।';
    }
    updateControls();
    return;
  }

  state.voiceLoadTimer = window.setTimeout(() => {
    state.voiceLoadTimer = null;
    state.voiceLoadAttempts += 1;
    refreshVoices();
  }, 400);
}

function refreshVoices() {
  const api = synth();
  state.ttsSupported = Boolean(api && typeof window.SpeechSynthesisUtterance === 'function');

  if (!api || !state.ttsSupported) {
    state.voices = [];
    state.voice = null;
    if (voiceSelect) {
      voiceSelect.replaceChildren();
      voiceSelect.append(new Option('Speech Synthesis उपलब्ध नहीं है', ''));
      voiceSelect.disabled = true;
    }
    if (ttsVoiceStatus) ttsVoiceStatus.textContent = 'इस browser में Speech Synthesis उपलब्ध नहीं है।';
    if (state.voiceLoadTimer) window.clearTimeout(state.voiceLoadTimer);
    state.voiceLoadTimer = null;
    updateControls();
    return;
  }

  const previousUri = state.voice?.voiceURI || '';
  let discovered = [];
  try {
    discovered = api.getVoices().filter(Boolean);
  } catch (error) {
    discovered = [];
  }

  const ordered = [
    ...discovered.filter(isSanskritVoice),
    ...discovered.filter(v => !isSanskritVoice(v) && isIndianVoice(v)),
    ...discovered.filter(v => !isSanskritVoice(v) && !isIndianVoice(v))
  ];
  state.voices = ordered;

  if (ordered.length) {
    if (state.voiceLoadTimer) window.clearTimeout(state.voiceLoadTimer);
    state.voiceLoadTimer = null;
    state.voiceLoadAttempts = 0;
    state.voice = ordered.find(v => previousUri && v.voiceURI === previousUri) || state.voice && ordered.find(v => v.voiceURI === state.voice.voiceURI) || ordered[0];
  } else {
    // Keep an already selected voice during a transient empty list instead of discarding it.
    if (!state.voice) state.voice = null;
  }

  if (voiceSelect) {
    voiceSelect.replaceChildren();
    if (!ordered.length) {
      voiceSelect.append(new Option('Browser voices लोड हो रही हैं…', ''));
      voiceSelect.disabled = true;
    } else {
      ordered.forEach((voice, index) => {
        const label = `${voice.name || 'Unnamed voice'} — ${voice.lang || 'भाषा अज्ञात'}${voice.default ? ' — default' : ''}`;
        voiceSelect.append(new Option(label, String(index)));
      });
      const selectedIndex = ordered.findIndex(v => state.voice && v.voiceURI === state.voice.voiceURI);
      voiceSelect.value = selectedIndex >= 0 ? String(selectedIndex) : '';
      voiceSelect.disabled = false;
    }
  }

  if (ttsVoiceStatus) {
    if (state.voice) {
      const kind = isSanskritVoice(state.voice) ? 'संस्कृत metadata match' : 'Browser/Indian voice';
      ttsVoiceStatus.textContent = `${kind}: ${state.voice.name || 'Unnamed voice'} (${state.voice.lang || 'भाषा अज्ञात'})`;
    } else {
      ttsVoiceStatus.textContent = ordered.length
        ? 'Voice उपलब्ध है; सूची से चयन करें।'
        : 'Browser voice सूची की प्रतीक्षा है…';
    }
  }

  if (!ordered.length) scheduleVoiceRetry();
  updateControls();
}

function selectVoice() {
  const index = Number(voiceSelect?.value);
  state.voice = Number.isInteger(index) && index >= 0 ? state.voices[index] || null : null;
  if (ttsVoiceStatus) {
    ttsVoiceStatus.textContent = state.voice
      ? `${state.voice.name} (${state.voice.lang}) चयनित है।`
      : 'कोई voice चयनित नहीं है।';
  }
  updateControls();
}

function renderQueue() {
  if (!quoteQueue) return;
  quoteQueue.replaceChildren();

  if (!state.quotes.length) {
    const empty = document.createElement('li');
    empty.className = 'queue-empty';
    empty.textContent = 'अभी कोई सुविचार कतार में नहीं है।';
    quoteQueue.append(empty);
  } else {
    state.quotes.forEach((quote, index) => {
      const item = document.createElement('li');
      item.className = `queue-item${index === state.index && (state.playback === PLAYBACK.PLAYING || state.playback === PLAYBACK.PAUSED) ? ' active' : ''}`;
      item.dataset.index = String(index);

      const number = document.createElement('span');
      number.className = 'queue-number';
      number.textContent = String(index + 1);

      const text = document.createElement('div');
      text.className = 'queue-text';
      text.textContent = quote;

      item.append(number, text);
      quoteQueue.append(item);
    });
  }

  if (queueCount) queueCount.textContent = String(state.quotes.length);
}

function addQuote() {
  const quote = normalizeQuote(quoteInput?.value);
  if (!quote) {
    msg('खाली सुविचार queue में नहीं जोड़ा गया।');
    quoteInput?.focus();
    return;
  }

  state.quotes.push(quote);
  if (quoteInput) quoteInput.value = '';
  if (state.playback === PLAYBACK.COMPLETED) {
    state.playback = PLAYBACK.IDLE;
    state.index = 0;
    updateProgress();
    clearDisplay();
  }
  renderQueue();
  updateControls();
  msg(`सुविचार ${state.quotes.length} queue में जोड़ा गया।`);
}

function clearQuotes() {
  stopPlayback(true);
  state.quotes = [];
  state.index = 0;
  state.playback = PLAYBACK.IDLE;
  renderQueue();
  updateProgress();
  clearDisplay();
  updateControls();
  msg('सभी सुविचार साफ़ कर दिए गए।');
}

function createMulticolorQuote(text) {
  const wrapper = document.createElement('div');
  wrapper.className = 'quote-text';
  const parts = normalizeQuote(text).split(/(\s+)/);
  let colorIndex = 0;

  parts.forEach(part => {
    if (/^\s+$/.test(part)) {
      wrapper.append(document.createTextNode(part));
      return;
    }
    const span = document.createElement('span');
    span.className = `quote-word c${(colorIndex % 6) + 1}`;
    span.textContent = part;
    wrapper.append(span);
    colorIndex += 1;
  });

  return wrapper;
}

function showQuote(index) {
  if (!quoteStage || !state.quotes[index]) return;
  quoteStage.replaceChildren(createMulticolorQuote(state.quotes[index]));
  if (stageNow) stageNow.textContent = state.quotes[index];
  if (stageIndex) stageIndex.textContent = `${index + 1} / ${state.quotes.length}`;
  updateQueueHighlight();
}

function clearDisplay() {
  if (quoteStage) {
    quoteStage.replaceChildren();
    const placeholder = document.createElement('div');
    placeholder.className = 'quote-stage-placeholder';
    placeholder.textContent = 'वाचन शुरू होने पर सुविचार यहाँ प्रदर्शित होगा।';
    quoteStage.append(placeholder);
  }
  if (stageNow) stageNow.textContent = 'कोई सुविचार प्रदर्शित नहीं हो रहा है।';
  if (stageIndex) stageIndex.textContent = `0 / ${state.quotes.length}`;
  if (completionGate) completionGate.textContent = 'वाचन के लिए तैयार';
}

function updateQueueHighlight() {
  if (!quoteQueue) return;
  quoteQueue.querySelectorAll('.queue-item').forEach(item => {
    const active = Number(item.dataset.index) === state.index && (state.playback === PLAYBACK.PLAYING || state.playback === PLAYBACK.PAUSED);
    item.classList.toggle('active', active);
  });
}

function updateProgress() {
  const total = state.quotes.length;
  const completed = Math.min(Math.max(state.index, 0), total);
  const value = total ? Math.round((completed * 100) / total) : 0;
  if (ttsProgress) ttsProgress.value = value;
  if (ttsProgressValue) ttsProgressValue.textContent = `${value}%`;
  if (quoteCompletion) quoteCompletion.textContent = `कतार: ${completed} / ${total}`;
}

function updateControls() {
  const active = state.playback === PLAYBACK.PLAYING;
  const paused = state.playback === PLAYBACK.PAUSED;
  const hasVoice = Boolean(state.voice);
  const canPlay = state.quotes.length > 0 && state.ttsSupported && hasVoice && !active && !paused;

  if (playButton) playButton.disabled = !canPlay;
  if (pauseButton) pauseButton.disabled = !active;
  if (resumeButton) resumeButton.disabled = !paused;
  if (stopButton) stopButton.disabled = !(active || paused);
  if (clearQuotesButton) clearQuotesButton.disabled = state.quotes.length === 0;
  if (addQuoteButton) addQuoteButton.disabled = false;
  if (removePhotoButton) removePhotoButton.disabled = !state.photoReady;
  if (removeVideoButton) removeVideoButton.disabled = !state.videoReady;
}

function clearPhotoObjectUrl() {
  if (state.photoObjectUrl) {
    URL.revokeObjectURL(state.photoObjectUrl);
    state.photoObjectUrl = '';
  }
}

function removePhoto() {
  state.photoToken += 1;
  clearPhotoObjectUrl();
  state.photoReady = false;
  if (stagePhoto) stagePhoto.removeAttribute('src');
  if (photoFrame) photoFrame.hidden = true;
  if (photoUpload) photoUpload.value = '';
  if (photoStatus) photoStatus.textContent = 'कोई फोटो चयनित नहीं है।';
  updateControls();
  msg('फोटो हटा दी गई।');
}

function photoSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    if (photoStatus) photoStatus.textContent = 'मान्य image file चुनें।';
    event.target.value = '';
    msg('अमान्य photo file अस्वीकार कर दी गई।');
    return;
  }

  const token = ++state.photoToken;
  clearPhotoObjectUrl();
  state.photoReady = false;
  const url = URL.createObjectURL(file);
  state.photoObjectUrl = url;

  if (stagePhoto) {
    stagePhoto.onload = () => {
      if (token !== state.photoToken || state.photoObjectUrl !== url) return;
      state.photoReady = true;
      if (photoFrame) photoFrame.hidden = false;
      updateControls();
    };
    stagePhoto.onerror = () => {
      if (token !== state.photoToken || state.photoObjectUrl !== url) return;
      clearPhotoObjectUrl();
      state.photoReady = false;
      if (stagePhoto) stagePhoto.removeAttribute('src');
      if (photoFrame) photoFrame.hidden = true;
      if (photoStatus) photoStatus.textContent = 'फोटो load नहीं हो सकी।';
      updateControls();
      msg('फोटो load नहीं हो सकी।');
    };
    stagePhoto.src = url;
  }

  if (photoStatus) photoStatus.textContent = `चयनित: ${file.name}`;
  msg('फोटो display में जोड़ी जा रही है।');
}

function clearVideoObjectUrl() {
  if (state.videoObjectUrl) {
    URL.revokeObjectURL(state.videoObjectUrl);
    state.videoObjectUrl = '';
  }
}

function removeVideo(clearInput = true) {
  state.videoToken += 1;
  if (videoPlayer) {
    videoPlayer.pause();
    videoPlayer.removeAttribute('src');
    videoPlayer.load();
  }
  clearVideoObjectUrl();
  state.videoReady = false;
  if (videoPlaceholder) videoPlaceholder.hidden = false;
  if (videoUploadStatus) videoUploadStatus.textContent = 'कोई वीडियो चयनित नहीं है।';
  if (clearInput && videoUpload) videoUpload.value = '';
  if (videoPlayer) videoPlayer.onloadedmetadata = null;
  if (videoPlayer) videoPlayer.oncanplay = null;
  if (videoPlayer) videoPlayer.onerror = null;
  updateControls();
  if (videoStatus) videoStatus.textContent = 'वीडियो तैयार नहीं है।';
}

function videoSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('video/')) {
    if (videoUploadStatus) videoUploadStatus.textContent = 'मान्य video file चुनें।';
    event.target.value = '';
    msg('अमान्य video file अस्वीकार कर दी गई।');
    return;
  }

  removeVideo(false);
  const token = ++state.videoToken;
  const url = URL.createObjectURL(file);
  state.videoObjectUrl = url;

  if (videoPlayer) {
    videoPlayer.muted = true;
    videoPlayer.playsInline = true;
    videoPlayer.loop = true;
    videoPlayer.preload = 'metadata';
    videoPlayer.onloadedmetadata = () => {
      if (token !== state.videoToken || state.videoObjectUrl !== url) return;
      if (videoStatus) videoStatus.textContent = `Metadata मिला — ${Math.round(videoPlayer.videoWidth)}×${Math.round(videoPlayer.videoHeight)} px; playable frame की प्रतीक्षा है।`;
    };
    videoPlayer.oncanplay = () => {
      if (token !== state.videoToken || state.videoObjectUrl !== url) return;
      state.videoReady = true;
      if (videoPlaceholder) videoPlaceholder.hidden = true;
      if (videoUploadStatus) videoUploadStatus.textContent = `चयनित: ${file.name}`;
      if (videoStatus) videoStatus.textContent = 'वीडियो तैयार है; Play पर चलेगी और repeat होगी।';
      updateControls();
      if (state.playback === PLAYBACK.PLAYING) startVideoPlayback();
    };
    videoPlayer.onerror = () => {
      if (token !== state.videoToken || state.videoObjectUrl !== url) return;
      state.videoReady = false;
      clearVideoObjectUrl();
      videoPlayer.removeAttribute('src');
      videoPlayer.onloadedmetadata = null;
      videoPlayer.oncanplay = null;
      videoPlayer.onerror = null;
      videoPlayer.load();
      if (videoPlaceholder) videoPlaceholder.hidden = false;
      if (videoUploadStatus) videoUploadStatus.textContent = 'वीडियो load नहीं हो सकी।';
      if (videoStatus) videoStatus.textContent = 'वीडियो load error।';
      updateControls();
      msg('वीडियो load नहीं हो सकी।');
    };
    videoPlayer.src = url;
    videoPlayer.load();
  }

  if (videoUploadStatus) videoUploadStatus.textContent = `लोड हो रहा है: ${file.name}`;
  if (videoStatus) videoStatus.textContent = 'वीडियो metadata लोड हो रहा है…';
}

function setPlayingStatus() {
  if (completionGate) completionGate.textContent = 'वाचन चल रहा है';
  if (ttsStatus) ttsStatus.textContent = `सुविचार ${state.index + 1} / ${state.quotes.length} पढ़ा जा रहा है।`;
}

function setPausedStatus(message = 'वाचन विराम पर है। Resume दबाएँ।') {
  if (completionGate) completionGate.textContent = 'वाचन विराम पर है';
  if (ttsStatus) ttsStatus.textContent = message;
}

function makeUtterance(text, token, index) {
  const utterance = new SpeechSynthesisUtterance(speechText(text));
  utterance.voice = state.voice;
  utterance.lang = state.voice?.lang || 'hi-IN';
  utterance.rate = selectedRate();
  utterance.pitch = profilePitch(index);
  utterance.volume = 1;

  utterance.onstart = () => {
    if (token !== state.speechToken) return;
    state.playback = PLAYBACK.PLAYING;
    showQuote(index);
    setPlayingStatus();
    updateControls();
  };

  utterance.onend = () => {
    if (token !== state.speechToken) return;
    if (state.playback !== PLAYBACK.PLAYING) return;

    state.index = index + 1;
    updateProgress();

    if (state.index >= state.quotes.length) {
      state.playback = PLAYBACK.COMPLETED;
      if (videoPlayer) videoPlayer.pause();
      if (completionGate) completionGate.textContent = 'सभी सुविचार पूर्ण';
      if (ttsStatus) ttsStatus.textContent = 'पूरी सुविचार कतार का वाचन पूर्ण हुआ।';
      updateQueueHighlight();
      updateControls();
      msg('सभी सुविचार पूर्ण हो गए।');
      return;
    }

    if (state.playback === PLAYBACK.PLAYING) {
      speakQuote(state.index);
    }
  };

  utterance.onerror = event => {
    if (token !== state.speechToken) return;
    state.playback = PLAYBACK.PAUSED;
    if (videoPlayer) videoPlayer.pause();
    setPausedStatus(`TTS त्रुटि: ${event?.error || 'अज्ञात त्रुटि'} — Resume दबाएँ।`);
    updateControls();
    msg('TTS त्रुटि के कारण वाचन paused है।');
  };

  return utterance;
}

function speakQuote(index) {
  const api = synth();
  if (!api || !state.ttsSupported || state.playback !== PLAYBACK.PLAYING || !state.quotes[index] || !state.voice) return false;

  const token = ++state.speechToken;
  if (api.speaking || api.pending) {
    try { api.cancel(); } catch (error) { /* non-fatal cancellation failure */ }
  }
  const utterance = makeUtterance(state.quotes[index], token, index);

  try {
    api.speak(utterance);
    return true;
  } catch (error) {
    if (token !== state.speechToken) return false;
    state.playback = PLAYBACK.PAUSED;
    if (videoPlayer) videoPlayer.pause();
    setPausedStatus(`TTS प्रारंभ नहीं हो सका: ${error?.message || 'अज्ञात त्रुटि'}`);
    updateControls();
    msg('TTS प्रारंभ नहीं हो सका।');
    return false;
  }
}

function startVideoPlayback() {
  if (!videoPlayer || !state.videoReady) return;
  videoPlayer.loop = true;
  videoPlayer.muted = true;
  videoPlayer.playsInline = true;

  let result;
  try {
    result = videoPlayer.play();
  } catch (error) {
    if (videoStatus) videoStatus.textContent = 'वीडियो शुरू नहीं हो सकी; TTS स्वतंत्र रूप से जारी है।';
    return;
  }

  if (result && typeof result.then === 'function') {
    result.then(() => {
      if (state.playback === PLAYBACK.PLAYING && videoStatus) {
        videoStatus.textContent = 'वीडियो चल रही है और repeat होगी।';
      }
    }).catch(() => {
      if (videoStatus) videoStatus.textContent = 'Browser ने video playback रोकी; TTS जारी रहेगा।';
      msg('वीडियो autoplay अस्वीकार हुई; TTS को नहीं रोका गया।');
    });
  }
}

function startPlayback() {
  const api = synth();
  if (!api || !state.ttsSupported) {
    msg('इस browser में Speech Synthesis उपलब्ध नहीं है।');
    return false;
  }
  if (!state.quotes.length) {
    msg('पहले कम-से-कम एक सुविचार queue में जोड़ें।');
    quoteInput?.focus();
    return false;
  }
  if (!state.voice) {
    msg('कोई TTS voice उपलब्ध/चयनित नहीं है। Voice सूची की प्रतीक्षा करें या उसे रीफ़्रेश करें।');
    return false;
  }
  if (state.playback === PLAYBACK.PLAYING || state.playback === PLAYBACK.PAUSED) return false;

  state.speechToken += 1;
  try { api.cancel(); } catch (error) { /* non-fatal cancellation failure */ }
  state.index = 0;
  state.playback = PLAYBACK.PLAYING;
  updateProgress();
  updateQueueHighlight();

  // Start TTS synchronously in the actual button click path. A stalled video.play()
  // Promise must never prevent the selected voice from starting.
  const started = speakQuote(0);
  if (!started) {
    state.playback = PLAYBACK.PAUSED;
    if (videoPlayer) videoPlayer.pause();
    updateControls();
    return false;
  }

  if (state.videoReady) {
    startVideoPlayback();
  } else if (state.videoObjectUrl && videoStatus) {
    videoStatus.textContent = 'वीडियो अभी तैयार नहीं; TTS शुरू है। playable frame मिलते ही वीडियो शुरू करने का प्रयास होगा।';
  }

  if (videoStatus && state.videoReady) videoStatus.textContent = 'वीडियो + TTS सक्रिय हैं।';
  msg('वाचन प्रारंभ हो गया।');
  return true;
}

function pausePlayback() {
  const api = synth();
  if (state.playback !== PLAYBACK.PLAYING) return;

  try {
    api?.pause();
  } catch (error) {
    msg('TTS pause नहीं हो सका।');
  }
  if (videoPlayer) videoPlayer.pause();
  state.playback = PLAYBACK.PAUSED;
  setPausedStatus();
  updateQueueHighlight();
  updateControls();
  msg('वाचन और वीडियो विराम पर हैं।');
}

function resumePlayback() {
  const api = synth();
  if (!api || !state.ttsSupported || state.playback !== PLAYBACK.PAUSED || !state.voice) return false;

  state.playback = PLAYBACK.PLAYING;
  try {
    if (api.paused) {
      api.resume();
    } else if (!api.speaking && !api.pending) {
      if (!speakQuote(state.index)) {
        state.playback = PLAYBACK.PAUSED;
        updateControls();
        return false;
      }
    }
  } catch (error) {
    state.playback = PLAYBACK.PAUSED;
    if (videoPlayer) videoPlayer.pause();
    setPausedStatus(`Resume विफल: ${error?.message || 'अज्ञात त्रुटि'}`);
    updateControls();
    return false;
  }

  // Resume video independently: a video failure must not pause successful TTS.
  if (state.videoReady) startVideoPlayback();
  setPlayingStatus();
  updateQueueHighlight();
  updateControls();
  msg('वाचन पुनः जारी है; वीडियो अलग से resume की जा रही है।');
  return true;
}

function stopPlayback(silent = false) {
  state.speechToken += 1;
  const api = synth();
  try { api?.cancel(); } catch (error) { /* cancellation failure is non-fatal */ }
  if (videoPlayer) videoPlayer.pause();

  state.playback = PLAYBACK.IDLE;
  state.index = 0;
  updateProgress();
  renderQueue();
  clearDisplay();
  if (ttsStatus) ttsStatus.textContent = 'वाचन प्रारंभ नहीं हुआ है।';
  if (videoStatus) videoStatus.textContent = state.videoReady ? 'वीडियो तैयार है; Play की प्रतीक्षा है।' : 'वीडियो तैयार नहीं है।';
  updateControls();
  if (!silent) msg('वाचन और वीडियो रोक दिए गए; स्थिति reset है।');
}

function bindEvents() {
  addQuoteButton?.addEventListener('click', addQuote);
  clearQuotesButton?.addEventListener('click', clearQuotes);
  playButton?.addEventListener('click', startPlayback);
  pauseButton?.addEventListener('click', pausePlayback);
  resumeButton?.addEventListener('click', resumePlayback);
  stopButton?.addEventListener('click', () => stopPlayback(false));
  removePhotoButton?.addEventListener('click', removePhoto);
  removeVideoButton?.addEventListener('click', removeVideo);
  photoUpload?.addEventListener('change', photoSelected);
  videoUpload?.addEventListener('change', videoSelected);
  voiceSelect?.addEventListener('change', selectVoice);
  ttsRate?.addEventListener('input', () => {
    updateRateLabel();
    if (state.playback === PLAYBACK.PLAYING || state.playback === PLAYBACK.PAUSED) {
      msg('नई वाचन गति अगले utterance पर लागू होगी।');
    }
  });
  quoteInput?.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      addQuote();
    }
  });

  const api = synth();
  if (api) {
    if (typeof api.addEventListener === 'function') {
      api.addEventListener('voiceschanged', refreshVoices);
    } else {
      api.onvoiceschanged = refreshVoices;
    }
  }

  videoPlayer?.addEventListener('play', () => {
    if (state.playback === PLAYBACK.PLAYING && videoStatus) videoStatus.textContent = 'वीडियो चल रही है और repeat होगी।';
  });
  videoPlayer?.addEventListener('pause', () => {
    if (state.playback === PLAYBACK.PAUSED && videoStatus) videoStatus.textContent = 'वीडियो paused है।';
  });
}

function browserCheck() {
  state.ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
  if (!state.ttsSupported) {
    if (ttsVoiceStatus) ttsVoiceStatus.textContent = 'Speech Synthesis API उपलब्ध नहीं है। TTS प्रारंभ नहीं किया जा सकता।';
    if (ttsStatus) ttsStatus.textContent = 'TTS उपलब्ध नहीं है।';
    msg('Browser में Speech Synthesis उपलब्ध नहीं है।');
  }
}

function init() {
  if (state.initialized) return;
  state.initialized = true;
  browserCheck();
  updateRateLabel();
  renderQueue();
  updateProgress();
  clearDisplay();
  bindEvents();
  refreshVoices();
  updateControls();

  if (state.ttsSupported && !state.voices.length) scheduleVoiceRetry();

  if (videoPlayer) {
    videoPlayer.loop = true;
    videoPlayer.muted = true;
    videoPlayer.playsInline = true;
  }
}

window.addEventListener('beforeunload', () => {
  state.speechToken += 1;
  state.photoToken += 1;
  state.videoToken += 1;
  try { synth()?.cancel(); } catch (error) { /* no-op during unload */ }
  if (state.voiceLoadTimer) window.clearTimeout(state.voiceLoadTimer);
  clearPhotoObjectUrl();
  clearVideoObjectUrl();
});

document.addEventListener('DOMContentLoaded', init, { once: true });
