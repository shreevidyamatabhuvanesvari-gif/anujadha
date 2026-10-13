import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import {
  pauseRecitation,
  resumeRecitation,
  startRecitation,
  stopRecitation,
  type TtsSettings,
} from './lib/tts';

type PlaybackStatus = 'idle' | 'playing' | 'paused' | 'finished' | 'error';

const STORAGE_KEY = 'shruti-saved-script-v1';
const DEFAULT_SCRIPT =
  'ॐ त्र्यम्बकं यजामहे सुगन्धिं पुष्टिवर्धनम्।\n\nउर्वारुकमिव बन्धनान्मृत्योर्मुक्षीय मामृतात्॥';
const MAX_SPEECH_LINE_LENGTH = 42;

const CAPTION_COLORS = [
  '#ff5252',
  '#ffb300',
  '#ffee58',
  '#69f0ae',
  '#40c4ff',
  '#b388ff',
  '#ff80ab',
  '#ffffff',
];

/** पाठ को शब्दों की सीमाओं पर बाँटें; किसी शब्द को बीच से न तोड़ें। */
function splitIntoSpeechLines(text: string): string[] {
  const result: string[] = [];

  for (const sourceLine of text.split(/\r?\n/)) {
    const words = sourceLine.trim().split(/\s+/).filter(Boolean);
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;

      if (
        current &&
        Array.from(candidate).length > MAX_SPEECH_LINE_LENGTH
      ) {
        result.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }

    if (current) result.push(current);
  }

  return result;
}

function loadSavedScript(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_SCRIPT;
  } catch {
    return DEFAULT_SCRIPT;
  }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';

  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');

  return `${mins}:${secs}`;
}

export default function App() {
  const [script, setScript] = useState<string>(loadSavedScript);
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [videoName, setVideoName] = useState<string>('');
  const [videoError, setVideoError] = useState<string>('');
  const [status, setStatus] = useState<PlaybackStatus>('idle');

  const [statusMessage, setStatusMessage] = useState<string>(
    'अपना पाठ लिखें या वीडियो चुनें; वाचन ब्राउज़र की उपलब्ध आवाज़ पर निर्भर करेगा।',
  );

  const [currentLineIndex, setCurrentLineIndex] = useState<number>(-1);
  const [rate, setRate] = useState<number>(0.9);
  const [pitch, setPitch] = useState<number>(1.0);
  const [volume, setVolume] = useState<number>(1.0);

  const [savedStatus, setSavedStatus] = useState<string>(
    'पाठ इस ब्राउज़र में सहेजा जाएगा',
  );

  const [videoTime, setVideoTime] = useState<number>(0);
  const [videoDuration, setVideoDuration] = useState<number>(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const lines = useMemo(() => splitIntoSpeechLines(script), [script]);

  const ttsSettings = useMemo<TtsSettings>(
    () => ({ rate, pitch, volume }),
    [rate, pitch, volume],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, script);
      setSavedStatus('पाठ सुरक्षित है');
    } catch {
      setSavedStatus('यह ब्राउज़र पाठ सहेज नहीं सका');
    }
  }, [script]);

  useEffect(() => {
    return () => {
      if (videoUrl.startsWith('blob:')) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  useEffect(() => {
    return () => {
      stopRecitation();
      videoRef.current?.pause();
    };
  }, []);

  const handleVideoChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];

      if (!file) return;

      if (!file.type.startsWith('video/')) {
        setVideoError(
          'कृपया MP4, WebM या ब्राउज़र में समर्थित वीडियो फ़ाइल चुनें।',
        );
        event.target.value = '';
        return;
      }

      stopRecitation();
      videoRef.current?.pause();

      setVideoError('');
      setVideoName(file.name);
      setVideoUrl(URL.createObjectURL(file));
      setVideoTime(0);
      setVideoDuration(0);
      setStatusMessage(
        'वीडियो तैयार है। वाचन शुरू करने पर वीडियो लूप में चलेगा।',
      );
      setCurrentLineIndex(-1);
      setStatus('idle');

      event.target.value = '';
    },
    [],
  );

  const start = useCallback(() => {
    if (lines.length === 0) {
      setStatus('error');
      setStatusMessage('पहले वाचन के लिए पाठ लिखें।');
      return;
    }

    stopRecitation();

    setStatus('playing');
    setCurrentLineIndex(0);
    setStatusMessage('वाचन शुरू किया जा रहा है…');

    const video = videoRef.current;

    if (video && videoUrl) {
      video.loop = true;

      void video.play().catch(() => {
        setVideoError(
          'ब्राउज़र ने वीडियो स्वतः चलाने की अनुमति नहीं दी। वीडियो पर Play दबाएँ।',
        );
      });
    }

    try {
      startRecitation(lines, ttsSettings, {
        onLineChange: (index: number) => {
          setCurrentLineIndex(index);
          setStatus('playing');
          setStatusMessage(
            `वाचन चल रहा है — पंक्ति ${index + 1} / ${lines.length}`,
          );
        },

        onEnd: () => {
          setStatus('finished');
          setCurrentLineIndex(-1);
          setStatusMessage('पूरा पाठ पढ़ लिया गया है।');
          videoRef.current?.pause();
        },

        onError: (message: string) => {
          setStatus('error');
          setCurrentLineIndex(-1);
          setStatusMessage(message);
          videoRef.current?.pause();
        },
      });
    } catch {
      setStatus('error');
      setCurrentLineIndex(-1);
      setStatusMessage(
        'वाचन शुरू नहीं हो सका। ब्राउज़र TTS की उपलब्धता जाँचें।',
      );
      videoRef.current?.pause();
    }
  }, [lines, ttsSettings, videoUrl]);

  const pause = useCallback(() => {
    pauseRecitation();
    videoRef.current?.pause();

    setStatus('paused');
    setStatusMessage('वाचन रुका हुआ है। Resume दबाकर आगे बढ़ाएँ।');
  }, []);

  const resume = useCallback(() => {
    resumeRecitation();

    const video = videoRef.current;

    if (video && videoUrl) {
      void video.play().catch(() => {
        setVideoError(
          'वाचन फिर शुरू है, लेकिन वीडियो स्वतः नहीं चला। वीडियो पर Play दबाएँ।',
        );
      });
    }

    setStatus('playing');
    setStatusMessage('वाचन फिर शुरू किया गया है।');
  }, [videoUrl]);

  const stop = useCallback(() => {
    stopRecitation();
    videoRef.current?.pause();

    setStatus('idle');
    setCurrentLineIndex(-1);
    setStatusMessage('वाचन रोक दिया गया है।');
  }, []);

  const clearScript = useCallback(() => {
    stopRecitation();
    videoRef.current?.pause();

    setScript('');
    setCurrentLineIndex(-1);
    setStatus('idle');
    setStatusMessage('पाठ साफ़ कर दिया गया है।');
  }, []);

  const currentLine =
    currentLineIndex >= 0 ? lines[currentLineIndex] ?? '' : '';

  // प्रत्येक शब्द को अलग रंग दें; मूल शब्द और उनके क्रम को न बदलें।
  const captionWords = currentLine
    ? currentLine.split(/(\s+)/).filter((part) => part.length > 0)
    : [];

  let captionWordIndex = 0;

  return (
    <main className="shruti-app">
      <header className="shruti-header">
        <div className="shruti-brand-mark" aria-hidden="true">
          श्री
        </div>

        <div className="shruti-heading-group">
          <p className="shruti-eyebrow">संस्कृत • हिंदी • वैदिक पाठ</p>
          <h1>श्रुति</h1>
          <p className="shruti-subtitle">
            वाचन एवं 9:16 वीडियो स्टूडियो
          </p>
        </div>

        <div className="shruti-save-state" role="status" aria-live="polite">
          <span className="shruti-save-dot" aria-hidden="true" />
          {savedStatus}
        </div>
      </header>

      <div className="shruti-layout">
        <section
          className="shruti-preview-section"
          aria-labelledby="preview-title"
        >
          <div className="shruti-section-title-row">
            <div>
              <p className="shruti-kicker">LIVE PREVIEW</p>
              <h2 id="preview-title">वीडियो पूर्वावलोकन</h2>
            </div>

            <span className="shruti-ratio-badge">9:16 VERTICAL</span>
          </div>

          <div className="shruti-preview-frame">
            {videoUrl ? (
              <video
                ref={videoRef}
                className="shruti-video"
                src={videoUrl}
                controls
                playsInline
                preload="metadata"
                aria-label="अपलोड किए गए वीडियो का पूर्वावलोकन"
                onTimeUpdate={(event) =>
                  setVideoTime(event.currentTarget.currentTime)
                }
                onLoadedMetadata={(event) =>
                  setVideoDuration(event.currentTarget.duration)
                }
              />
            ) : (
              <div className="shruti-video-placeholder">
                <div className="shruti-play-symbol" aria-hidden="true">
                  ▶
                </div>

                <strong>आपका वीडियो यहाँ दिखाई देगा</strong>
                <span>9:16 पोर्ट्रेट पूर्वावलोकन</span>

                <button
                  className="shruti-button shruti-button--outline"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  ＋ वीडियो चुनें
                </button>
              </div>
            )}

            <div
              className="made-in-anjali-logo"
              role="img"
              aria-label="Made in Anjali watermark"
            >
              <span className="made-in-anjali-top">MADE IN</span>
              <span className="made-in-anjali-name">ANJALI</span>
              <span className="made-in-anjali-bottom">SHRUTI STUDIO</span>
            </div>

            {currentLine && (
              <div
                className="shruti-live-caption"
                aria-live="polite"
                aria-label={currentLine}
              >
                {captionWords.map((part, index) => {
                  if (/^\s+$/.test(part)) {
                    return (
                      <span
                        className="shruti-caption-space"
                        aria-hidden="true"
                        key={`space-${index}`}
                      >
                        {part}
                      </span>
                    );
                  }

                  const color =
                    CAPTION_COLORS[
                      captionWordIndex++ % CAPTION_COLORS.length
                    ];

                  return (
                    <span
                      className="shruti-caption-word"
                      aria-hidden="true"
                      key={`word-${index}`}
                      style={{ color }}
                    >
                      {part}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          <input
            ref={fileInputRef}
            className="shruti-visually-hidden"
            type="file"
            accept="video/*"
            onChange={handleVideoChange}
            aria-label="वीडियो फ़ाइल चुनें"
          />

          <div className="shruti-video-meta">
            <span className="shruti-file-name" title={videoName}>
              {videoName || 'कोई वीडियो नहीं चुना गया'}
            </span>

            {videoUrl && (
              <span className="shruti-time-code">
                {formatTime(videoTime)} / {formatTime(videoDuration)}
              </span>
            )}
          </div>

          {videoError && (
            <p className="shruti-error" role="alert">
              {videoError}
            </p>
          )}

          <p className="shruti-small-note">
            वीडियो आपके डिवाइस पर ही पूर्वावलोकित होता है। गोल लोगो और
            बहुरंगी पाठ पूर्वावलोकन के ऊपर दिखते हैं; MP4 निर्यात या मूल
            फ़ाइल में स्थायी एम्बेडिंग शामिल नहीं है।
          </p>
        </section>

        <section
          className="shruti-controls-section"
          aria-labelledby="controls-title"
        >
          <div className="shruti-section-title-row">
            <div>
              <p className="shruti-kicker">RECITATION DESK</p>
              <h2 id="controls-title">पाठ और वाचन नियंत्रण</h2>
            </div>
          </div>

          <label className="shruti-field-label" htmlFor="shruti-script">
            वाचन-पाठ
          </label>

          <textarea
            id="shruti-script"
            className="shruti-script-input"
            value={script}
            onChange={(event) => {
              setScript(event.target.value);
              setCurrentLineIndex(-1);

              if (status === 'playing' || status === 'paused') {
                stopRecitation();
                videoRef.current?.pause();

                setStatus('idle');
                setStatusMessage(
                  'पाठ बदला गया। नए पाठ के लिए वाचन दोबारा शुरू करें।',
                );
              }
            }}
            placeholder="संस्कृत, हिंदी या वैदिक पाठ यहाँ लिखें…"
            rows={8}
            spellCheck={false}
          />

          <div className="shruti-script-meta">
            <span>{script.length.toLocaleString('hi-IN')} अक्षर</span>
            <span>{lines.length.toLocaleString('hi-IN')} वाचन-पंक्तियाँ</span>

            <button
              className="shruti-text-button"
              type="button"
              onClick={clearScript}
            >
              पाठ साफ़ करें
            </button>
          </div>

          <div className="shruti-settings-card">
            <div className="shruti-settings-heading">
              <h3>आवाज़ की सेटिंग</h3>
              <span>ब्राउज़र TTS</span>
            </div>

            <label className="shruti-range-row" htmlFor="shruti-rate">
              <span>बोलने की गति</span>
              <strong>{rate.toFixed(1)}×</strong>

              <input
                id="shruti-rate"
                type="range"
                min="0.5"
                max="1.5"
                step="0.1"
                value={rate}
                onChange={(event) => setRate(Number(event.target.value))}
              />
            </label>

            <label className="shruti-range-row" htmlFor="shruti-pitch">
              <span>पिच</span>
              <strong>{pitch.toFixed(1)}</strong>

              <input
                id="shruti-pitch"
                type="range"
                min="0.5"
                max="2"
                step="0.1"
                value={pitch}
                onChange={(event) => setPitch(Number(event.target.value))}
              />
            </label>

            <label className="shruti-range-row" htmlFor="shruti-volume">
              <span>आवाज़ का स्तर</span>
              <strong>{Math.round(volume * 100)}%</strong>

              <input
                id="shruti-volume"
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </label>
          </div>

          <div className="shruti-playback-controls" aria-label="वाचन नियंत्रण">
            <button
              className="shruti-button shruti-button--primary"
              type="button"
              onClick={start}
              disabled={lines.length === 0 || status === 'playing'}
            >
              ▶ वाचन शुरू करें
            </button>

            <button
              className="shruti-button shruti-button--secondary"
              type="button"
              onClick={status === 'paused' ? resume : pause}
              disabled={status !== 'playing' && status !== 'paused'}
            >
              {status === 'paused' ? '⏵ फिर शुरू करें' : 'Ⅱ रोकें'}
            </button>

            <button
              className="shruti-button shruti-button--outline"
              type="button"
              onClick={stop}
              disabled={status === 'idle' || status === 'finished'}
            >
              ■ बंद करें
            </button>
          </div>

          <div
            className={`shruti-status-panel shruti-status-panel--${status}`}
            role="status"
            aria-live="polite"
          >
            <span className="shruti-status-light" aria-hidden="true" />
            <span>{statusMessage}</span>
          </div>

          <div className="shruti-current-line">
            <span className="shruti-current-line-label">
              वर्तमान उच्चरित पंक्ति
            </span>

            <p>
              {currentLine ||
                'वाचन शुरू होने पर वर्तमान पंक्ति यहाँ दिखाई देगी।'}
            </p>
          </div>
        </section>
      </div>

      <footer className="shruti-footer">
        <span>श्रुति · संस्कृत एवं वैदिक पाठ स्टूडियो</span>
        <span>MADE IN ANJALI</span>
      </footer>
    </main>
  );
}
