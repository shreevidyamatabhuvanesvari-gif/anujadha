import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  BookOpenText,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  CloudOff,
  Download,
  FileText,
  Film,
  Headphones,
  Info,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  Volume2,
  X,
} from 'lucide-react';

import {
  exportLexiconJson,
  normalizeForSpeech,
  getLexiconMetadata,
  getPronunciationEntries,
  getVedicCharacters,
} from './lib/pronunciation';

import { splitRecitationLines } from './lib/recitation';
import { readSavedScript, saveScript } from './lib/storage';

const SAMPLE_TEXT =
  'ॐ त्र्यम्बकं यजामहे सुगन्धिं पुष्टिवर्धनम्।\nउर्वारुकमिव बन्धनान्मृत्योर्मुक्षीय मामृतात्॥';

type EngineState = 'checking' | 'online' | 'offline' | 'preparing';

interface HealthResponse {
  ok: boolean;
  model_loaded: boolean;
  model_id: string;
  device: string;
  offline_mode: boolean;
  detail?: string;
}

interface Notice {
  tone: 'success' | 'warning' | 'error' | 'info';
  text: string;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      detail?: string;
      message?: string;
    };

    return (
      body.detail ??
      body.message ??
      `स्थानीय इंजन ने ${response.status} त्रुटि दी।`
    );
  } catch {
    return `स्थानीय इंजन उपलब्ध नहीं है (${response.status})।`;
  }
}

export default function App() {
  const [scriptText, setScriptText] = useState(() =>
    readSavedScript(SAMPLE_TEXT),
  );

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [isReciting, setIsReciting] = useState(false);
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);

  const [engineState, setEngineState] =
    useState<EngineState>('checking');

  const [engineInfo, setEngineInfo] =
    useState<HealthResponse | null>(null);

  const [engineMessage, setEngineMessage] = useState(
    'स्थानीय TTS इंजन की जाँच हो रही है…',
  );

  const [notice, setNotice] = useState<Notice | null>(null);

  const [showLexicon, setShowLexicon] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [speechVolume, setSpeechVolume] = useState(1);
  const [pace, setPace] = useState<
    'slow' | 'moderate' | 'steady'
  >('slow');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const lines = useMemo(
    () => splitRecitationLines(scriptText),
    [scriptText],
  );

  const lexiconMetadata = getLexiconMetadata();
  const pronunciationEntries = getPronunciationEntries();
  const vedicCharacters = getVedicCharacters();

  // वीडियो को browser-local object URL के रूप में दिखाएँ।
  useEffect(() => {
    if (!videoFile) {
      setVideoUrl(null);
      return;
    }

    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  // पाठ को ब्राउज़र में सुरक्षित रखें।
  useEffect(() => {
    const saved = saveScript(scriptText);

    if (!saved) {
      setNotice({
        tone: 'warning',
        text: 'ब्राउज़र स्टोरेज उपलब्ध नहीं है; आपका पाठ स्थायी रूप से सुरक्षित नहीं हो पाया।',
      });
    }
  }, [scriptText]);

  // स्थानीय TTS इंजन की स्थिति जाँचें।
  useEffect(() => {
    void checkLocalEngine(false);

    return () => {
      abortRef.current?.abort();
      audioRef.current?.pause();

      if (audioRef.current) {
        audioRef.current.removeAttribute('src');
      }
    };
  }, []);

  async function checkLocalEngine(
    showNotice = true,
  ): Promise<void> {
    setEngineState('checking');

    try {
      const response = await fetch('/api/health', {
        method: 'GET',
      });

      if (!response.ok) {
        throw new Error(await responseError(response));
      }

      const info = (await response.json()) as HealthResponse;

      setEngineInfo(info);
      setEngineState('online');

      setEngineMessage(
        info.model_loaded
          ? `मॉडल तैयार · ${info.device}`
          : 'स्थानीय इंजन जुड़ा है · मॉडल तैयार करना बाकी है',
      );

      if (showNotice) {
        setNotice({
          tone: 'success',
          text: info.model_loaded
            ? `TTS तैयार है (${info.device})।`
            : 'स्थानीय इंजन जुड़ गया है। पहला वाचन मॉडल तैयार करने के बाद चलेगा।',
        });
      }
    } catch (error) {
      setEngineInfo(null);
      setEngineState('offline');
      setEngineMessage('स्थानीय TTS इंजन से संपर्क नहीं हुआ');

      if (showNotice) {
        setNotice({
          tone: 'error',
          text:
            error instanceof Error
              ? error.message
              : 'स्थानीय इंजन नहीं मिला। backend चलाएँ।',
        });
      }
    }
  }

  async function prepareEngine(): Promise<void> {
    if (
      engineState === 'preparing' ||
      engineState === 'checking'
    ) {
      return;
    }

    setEngineState('preparing');
    setEngineMessage(
      'मॉडल लोड हो रहा है; पहली बार इसमें समय लग सकता है…',
    );

    setNotice({
      tone: 'info',
      text: 'स्थानीय TTS मॉडल तैयार हो रहा है। इस दौरान पेज खुला रखें।',
    });

    try {
      const response = await fetch('/api/prepare', {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(await responseError(response));
      }

      const info = (await response.json()) as HealthResponse;

      setEngineInfo(info);
      setEngineState('online');
      setEngineMessage(`मॉडल तैयार · ${info.device}`);

      setNotice({
        tone: 'success',
        text: `स्थानीय मॉडल तैयार है (${info.device})। अब वाचन शुरू किया जा सकता है।`,
      });
    } catch (error) {
      setEngineState('offline');
      setEngineMessage('मॉडल तैयार नहीं हो सका');

      setNotice({
        tone: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'मॉडल लोड नहीं हो सका। स्थानीय मॉडल सेटअप जाँचें।',
      });
    }
  }

  // वीडियो केवल इसी browser में preview होता है।
  function acceptVideo(file?: File): void {
    if (!file) return;

    if (isReciting) {
      setNotice({
        tone: 'warning',
        text: 'वाचन के दौरान वीडियो नहीं बदल सकते। पहले वाचन रोकें।',
      });
      return;
    }

    if (!file.type.startsWith('video/')) {
      setNotice({
        tone: 'error',
        text: 'कृपया मान्य वीडियो फ़ाइल चुनें।',
      });
      return;
    }

    if (file.size > 1024 * 1024 * 1024) {
      setNotice({
        tone: 'error',
        text: 'वीडियो 1 GB से बड़ी है। कृपया छोटी क्लिप चुनें।',
      });
      return;
    }

    setVideoFile(file);

    setNotice({
      tone: 'success',
      text: `वीडियो तैयार है: ${file.name} (${formatBytes(file.size)})। फ़ाइल बाहरी सर्वर पर अपलोड नहीं की जाती।`,
    });
  }

  function stopRecitation(showNotice = true): void {
    abortRef.current?.abort();
    abortRef.current = null;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
      audioRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
    }

    setIsReciting(false);
    setCurrentLineIndex(-1);

    if (showNotice) {
      setNotice({
        tone: 'info',
        text: 'वाचन रोक दिया गया है।',
      });
    }
  }

  // एक पंक्ति का ऑडियो पूरी तरह समाप्त होने तक प्रतीक्षा करें।
  async function playAudioBlob(
    blob: Blob,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;

    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);

    audio.volume = speechVolume;
    audioRef.current = audio;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;

          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('error', onError);
          signal.removeEventListener('abort', onAbort);

          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };

        const onEnded = (): void => finish();

        const onError = (): void =>
          finish(
            new Error(
              'जनरेट किए गए ऑडियो को चलाया नहीं जा सका।',
            ),
          );

        const onAbort = (): void => {
          audio.pause();
          finish();
        };

        audio.addEventListener('ended', onEnded, {
          once: true,
        });

        audio.addEventListener('error', onError, {
          once: true,
        });

        signal.addEventListener('abort', onAbort, {
          once: true,
        });

        void audio.play().catch((error: unknown) => {
          finish(
            error instanceof Error
              ? error
              : new Error('ऑडियो प्लेबैक असफल रहा।'),
          );
        });
      });
    } finally {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();

      URL.revokeObjectURL(audioUrl);

      if (audioRef.current === audio) {
        audioRef.current = null;
      }
    }
  }

  async function startRecitation(): Promise<void> {
    if (isReciting) return;

    const scriptLines = splitRecitationLines(scriptText);

    if (!videoUrl || !videoRef.current) {
      setNotice({
        tone: 'warning',
        text: 'पहले वीडियो क्लिप चुनें।',
      });
      return;
    }

    if (!scriptLines.length) {
      setNotice({
        tone: 'warning',
        text: 'वाचन शुरू करने के लिए संस्कृत या हिंदी पाठ लिखें।',
      });
      return;
    }

    const longLineIndex = scriptLines.findIndex(
      (line) => line.length > 1600,
    );

    if (longLineIndex >= 0) {
      setNotice({
        tone: 'warning',
        text: `पंक्ति ${longLineIndex + 1} बहुत लंबी है। इसे छोटी पंक्तियों में बाँटें।`,
      });
      return;
    }

    if (engineState !== 'online') {
      setNotice({
        tone: 'error',
        text: 'स्थानीय TTS इंजन उपलब्ध नहीं है। पहले स्थानीय backend चालू करें।',
      });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setIsReciting(true);
    setCurrentLineIndex(0);

    setNotice({
      tone: 'info',
      text: 'वाचन शुरू हो रहा है। अगली पंक्ति वर्तमान ऑडियो पूरा होने के बाद ही आएगी।',
    });

    const video = videoRef.current;

    video.loop = true;
    video.muted = true;

    try {
      video.currentTime = 0;
      await video.play();

      for (
        let index = 0;
        index < scriptLines.length;
        index += 1
      ) {
        if (controller.signal.aborted) break;

        setCurrentLineIndex(index);

        setNotice({
          tone: 'info',
          text: `पंक्ति ${index + 1} / ${scriptLines.length} का वाचन चल रहा है।`,
        });

        const response = await fetch('/api/tts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            text: normalizeForSpeech(scriptLines[index]),
            pace,
          }),
        });

        if (!response.ok) {
          throw new Error(await responseError(response));
        }

        const audioBlob = await response.blob();

        if (controller.signal.aborted) break;

        // यह Promise ऑडियो के ended होने पर ही resolve होता है।
        await playAudioBlob(audioBlob, controller.signal);
      }

      if (!controller.signal.aborted) {
        setCurrentLineIndex(-1);
        video.pause();

        setNotice({
          tone: 'success',
          text: `पूरा पाठ पढ़ लिया गया (${scriptLines.length} पंक्तियाँ)। वीडियो अब रुक गया है।`,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        video.pause();

        setNotice({
          tone: 'error',
          text:
            error instanceof Error
              ? error.message
              : 'वाचन के दौरान त्रुटि हुई।',
        });
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }

      setIsReciting(false);

      if (controller.signal.aborted) {
        setCurrentLineIndex(-1);
      }
    }
  }

  function handleScriptImport(file?: File): void {
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setNotice({
        tone: 'error',
        text: 'पाठ फ़ाइल 2 MB से बड़ी है।',
      });
      return;
    }

    void file
      .text()
      .then((text) => {
        setScriptText(text);

        setNotice({
          tone: 'success',
          text: `${file.name} से पाठ आयात किया गया।`,
        });
      })
      .catch(() => {
        setNotice({
          tone: 'error',
          text: 'पाठ फ़ाइल पढ़ी नहीं जा सकी।',
        });
      });
  }

  const currentLine =
    currentLineIndex >= 0
      ? lines[currentLineIndex] ?? ''
      : '';

  const visibleEngineState =
    engineState === 'online'
      ? 'online'
      : engineState === 'preparing' ||
          engineState === 'checking'
        ? 'busy'
        : 'offline';

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Sparkles size={22} strokeWidth={1.8} />
          </div>

          <div>
            <div className="brand-name">
              श्रुति<span> / SHRUTI</span>
            </div>

            <div className="brand-subtitle">
              Vedic Video Recitation Studio
            </div>
          </div>
        </div>

        <div
          className={`engine-pill engine-${visibleEngineState}`}
          aria-live="polite"
        >
          {engineState === 'online' ? (
            <CheckCircle2 size={15} />
          ) : engineState === 'offline' ? (
            <CloudOff size={15} />
          ) : (
            <LoaderCircle className="spin" size={15} />
          )}

          <span>
            {engineState === 'online'
              ? engineInfo?.model_loaded
                ? 'स्थानीय TTS तैयार'
                : 'स्थानीय TTS जुड़ा है'
              : engineState === 'offline'
                ? 'TTS ऑफ़लाइन'
                : engineState === 'preparing'
                  ? 'मॉडल तैयार हो रहा है'
                  : 'इंजन जाँच रहा है'}
          </span>
        </div>
      </header>

      <section className="hero-row">
        <div>
          <p className="eyebrow">
            <span className="eyebrow-line" />
            VEDIC TEXT · LOCAL AUDIO · 9:16 VIDEO
          </p>

          <h1>
            श्लोक को <em>दृश्य</em> और <em>स्वर</em> दें।
          </h1>

          <p className="hero-description">
            वीडियो चुनें, संस्कृत या हिंदी पाठ लिखें और एक-एक
            पंक्ति के क्रमिक वाचन के साथ अपना क्लिप तैयार करें।
            पाठ और वीडियो इसी डिवाइस पर रहते हैं।
          </p>
        </div>

        <div className="hero-badges">
          <span>
            <ShieldCheck size={15} />
            कोई बाहरी speech API नहीं
          </span>

          <span>
            <Volume2 size={15} />
            स्थानीय neural TTS
          </span>
        </div>
      </section>

      <div className="workspace-grid">
        <section
          className="editor-column"
          aria-label="पाठ और वीडियो सेटिंग"
        >
          <section className="panel upload-panel">
            <div className="panel-heading">
              <div className="section-icon">
                <Film size={18} />
              </div>

              <div>
                <h2>वीडियो क्लिप</h2>
                <p>स्थानीय फ़ाइल · वर्टिकल 9:16 preview</p>
              </div>

              <span className="step-label">01</span>
            </div>

            <div
              className={`drop-zone ${
                isDragging ? 'drop-zone-active' : ''
              } ${videoFile ? 'drop-zone-filled' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);

                if (!isReciting) {
                  acceptVideo(event.dataTransfer.files[0]);
                }
              }}
            >
              <input
                className="visually-hidden"
                id="video-upload"
                type="file"
                disabled={isReciting}
                accept="video/*"
                onChange={(event) => {
                  acceptVideo(event.currentTarget.files?.[0]);
                  event.currentTarget.value = '';
                }}
              />

              <div className="upload-emblem">
                {videoFile ? (
                  <Check size={21} />
                ) : (
                  <Upload size={21} />
                )}
              </div>

              {videoFile ? (
                <>
                  <strong className="file-title">
                    {videoFile.name}
                  </strong>

                  <span className="muted-line">
                    {formatBytes(videoFile.size)} · क्लिप
                    इसी browser में रखी गई है
                  </span>
                </>
              ) : (
                <>
                  <strong>वीडियो यहाँ छोड़ें</strong>
                  <span className="muted-line">
                    या अपने डिवाइस से फ़ाइल चुनें
                  </span>
                </>
              )}

              <label
                className={`button button-secondary button-compact ${
                  isReciting ? 'disabled-label' : ''
                }`}
                htmlFor="video-upload"
              >
                <Upload size={15} />
                {videoFile ? 'दूसरी क्लिप चुनें' : 'वीडियो चुनें'}
              </label>

              <span className="format-note">
                MP4 · WebM · MOV · अधिकतम 1 GB
              </span>
            </div>

            {videoFile && (
              <div className="selected-file-row">
                <span className="file-status">
                  <CheckCircle2 size={15} />
                  वीडियो तैयार
                </span>

                <button
                  className="text-button danger-text"
                  disabled={isReciting}
                  onClick={() => {
                    stopRecitation(false);
                    setVideoFile(null);

                    setNotice({
                      tone: 'info',
                      text: 'वीडियो हटाई गई।',
                    });
                  }}
                  type="button"
                >
                  हटाएँ
                </button>
              </div>
            )}
          </section>

          <section className="panel script-panel">
            <div className="panel-heading">
              <div className="section-icon">
                <BookOpenText size={18} />
              </div>

              <div>
                <h2>पाठ और श्लोक</h2>
                <p>देवनागरी · संस्कृत · हिंदी · वैदिक चिह्न</p>
              </div>

              <span className="step-label">02</span>
            </div>

            <label
              htmlFor="script-input"
              className="field-label"
            >
              आपका पाठ
            </label>

            <textarea
              id="script-input"
              value={scriptText}
              disabled={isReciting}
              onChange={(event) =>
                setScriptText(event.currentTarget.value)
              }
              placeholder="यहाँ संस्कृत या हिंदी में पाठ लिखें…"
              spellCheck={false}
              lang="sa"
            />

            <div className="script-meta">
              <span>
                {scriptText.length.toLocaleString('hi-IN')} अक्षर
              </span>

              <span>
                {lines.length.toLocaleString('hi-IN')} वाचन-पंक्तियाँ
              </span>

              <span className="autosave-label">
                <CheckCircle2 size={13} />
                ब्राउज़र में auto-save
              </span>
            </div>

            <div className="script-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={isReciting}
                onClick={() => {
                  setScriptText(SAMPLE_TEXT);

                  setNotice({
                    tone: 'info',
                    text: 'नमूना महामृत्युंजय मंत्र पाठ में रखा गया।',
                  });
                }}
              >
                <RefreshCw size={15} />
                नमूना पाठ
              </button>

              <label
                className={`button button-secondary ${
                  isReciting ? 'disabled-label' : ''
                }`}
                htmlFor="script-import"
              >
                <FileText size={15} />
                TXT आयात
              </label>

              <input
                className="visually-hidden"
                id="script-import"
                type="file"
                disabled={isReciting}
                accept=".txt,text/plain"
                onChange={(event) => {
                  handleScriptImport(
                    event.currentTarget.files?.[0],
                  );
                  event.currentTarget.value = '';
                }}
              />

              <button
                className="button button-secondary"
                type="button"
                onClick={() =>
                  downloadBlob(
                    new Blob([scriptText], {
                      type: 'text/plain;charset=utf-8',
                    }),
                    'shruti-script.txt',
                  )
                }
              >
                <Download size={15} />
                TXT निर्यात
              </button>
            </div>
          </section>

          <section className="panel settings-panel">
            <button
              className="panel-heading panel-heading-button"
              type="button"
              aria-expanded={showSettings}
              onClick={() =>
                setShowSettings((value) => !value)
              }
            >
              <div className="section-icon">
                <Settings2 size={18} />
              </div>

              <div className="heading-copy">
                <h2>वाचन सेटिंग</h2>
                <p>स्पष्टता और गति समायोजित करें</p>
              </div>

              <ChevronDown
                className={showSettings ? 'chevron-open' : ''}
                size={18}
              />
            </button>

            {showSettings && (
              <div className="settings-fields">
                <div className="setting-item">
                  <label htmlFor="pace">वाचन गति</label>

                  <select
                    id="pace"
                    disabled={isReciting}
                    value={pace}
                    onChange={(event) =>
                      setPace(
                        event.currentTarget.value as
                          | 'slow'
                          | 'moderate'
                          | 'steady',
                      )
                    }
                  >
                    <option value="slow">
                      धीमी — श्लोक अभ्यास
                    </option>
                    <option value="moderate">
                      मध्यम — स्पष्ट पाठ
                    </option>
                    <option value="steady">
                      स्थिर — सामान्य वाचन
                    </option>
                  </select>

                  <small>
                    गति स्थानीय मॉडल को दी जाती है। वास्तविक
                    वाचन गति वाक्य के अनुसार बदल सकती है।
                  </small>
                </div>

                <div className="setting-item">
                  <div className="range-head">
                    <label htmlFor="volume">TTS आवाज़</label>
                    <span>
                      {Math.round(speechVolume * 100)}%
                    </span>
                  </div>

                  <input
                    id="volume"
                    disabled={isReciting}
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={speechVolume}
                    onChange={(event) =>
                      setSpeechVolume(
                        Number(event.currentTarget.value),
                      )
                    }
                  />
                </div>
              </div>
            )}
          </section>

          <section className="panel lexicon-teaser">
            <div className="lexicon-copy">
              <div className="section-icon">
                <BookOpenText size={18} />
              </div>

              <div>
                <h2>वैदिक उच्चारण कोश</h2>
                <p>
                  {lexiconMetadata.vedicCharacterCount} Unicode
                  वैदिक चिह्न ·{' '}
                  {lexiconMetadata.pronunciationCount} शब्द-प्रविष्टियाँ
                </p>
              </div>
            </div>

            <button
              className="button button-secondary"
              type="button"
              onClick={() => setShowLexicon(true)}
            >
              कोश खोलें
              <ChevronDown size={15} className="rotate-minus" />
            </button>

            <button
              className="icon-button"
              type="button"
              aria-label="उच्चारण कोश JSON डाउनलोड करें"
              title="उच्चारण कोश JSON डाउनलोड करें"
              onClick={() =>
                downloadBlob(
                  new Blob([exportLexiconJson()], {
                    type: 'application/json;charset=utf-8',
                  }),
                  'vedic-lexicon.json',
                )
              }
            >
              <Download size={17} />
            </button>
          </section>

          <div className="engine-card">
            <div className="engine-card-top">
              <div className="engine-card-icon">
                <Headphones size={19} />
              </div>

              <div className="engine-card-copy">
                <strong>लोकल संस्कृत TTS</strong>
                <span>{engineMessage}</span>

                {engineInfo && (
                  <small>
                    {engineInfo.model_id} ·{' '}
                    {engineInfo.offline_mode
                      ? 'offline-only mode'
                      : 'local inference'}
                  </small>
                )}
              </div>
            </div>

            <div className="engine-card-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={
                  engineState === 'preparing' ||
                  engineState === 'checking'
                }
                onClick={() => void checkLocalEngine(true)}
              >
                <RefreshCw size={15} />
                स्थिति जाँचें
              </button>

              <button
                className="button button-quiet"
                type="button"
                disabled={
                  engineState === 'preparing' ||
                  engineState === 'checking'
                }
                onClick={() => void prepareEngine()}
              >
                {engineState === 'preparing' ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Activity size={15} />
                )}
                मॉडल तैयार करें
              </button>
            </div>

            <p className="privacy-note">
              <ShieldCheck size={14} />
              वाचन स्थानीय मशीन पर होता है। मॉडल को पहली बार
              डाउनलोड करना पड़ सकता है; कोई cloud speech request
              नहीं भेजी जाती।
            </p>
          </div>
        </section>

        <aside
          className="preview-column"
          aria-label="वीडियो preview और वाचन"
        >
          <div className="preview-header">
            <div>
              <p className="eyebrow">LIVE CANVAS</p>
              <h2>वीडियो preview</h2>
            </div>

            <span className="aspect-badge">
              9:16 <span>PORTRAIT</span>
            </span>
          </div>

          <div
            className={`video-stage ${
              videoUrl ? 'has-video' : ''
            }`}
          >
            {videoUrl ? (
              <>
                <video
                  key={videoUrl}
                  ref={videoRef}
                  className="preview-video"
                  src={videoUrl}
                  loop
                  muted
                  playsInline
                  controls={!isReciting}
                  preload="metadata"
                />

                <div
                  className={`subtitle-overlay ${
                    currentLine ? 'subtitle-visible' : ''
                  }`}
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {currentLine ? (
                    <span>{currentLine}</span>
                  ) : (
                    <span className="subtitle-placeholder">
                      वाचन शुरू करने पर वर्तमान पंक्ति यहाँ दिखाई देगी
                    </span>
                  )}
                </div>

                <div className="video-watermark">
                  <span className="watermark-dot" />
                  श्रुति
                </div>
              </>
            ) : (
              <div className="empty-video">
                <div className="empty-video-mark">
                  <Film size={30} strokeWidth={1.4} />
                </div>

                <strong>आपका 9:16 canvas</strong>

                <p>
                  वीडियो चुनने पर यहाँ उसका vertical preview दिखेगा।
                </p>

                <label
                  className={`button button-secondary ${
                    isReciting ? 'disabled-label' : ''
                  }`}
                  htmlFor="video-upload"
                >
                  <Upload size={15} />
                  क्लिप चुनें
                </label>
              </div>
            )}
          </div>

          <div className="preview-caption-row">
            <div className="play-state-icon">
              {isReciting ? (
                <Volume2 size={17} />
              ) : (
                <Pause size={17} />
              )}
            </div>

            <div className="preview-caption-copy">
              <strong>
                {isReciting
                  ? `पंक्ति ${currentLineIndex + 1} / ${lines.length} पढ़ी जा रही है`
                  : 'पंक्ति-दर-पंक्ति वाचन'}
              </strong>

              <span>
                {isReciting
                  ? 'अगली पंक्ति ऑडियो पूरा होने तक नहीं आएगी।'
                  : 'वीडियो वाचन के दौरान loop होगा।'}
              </span>
            </div>
          </div>

          {isReciting && (
            <div
              className="reading-progress"
              aria-label="वाचन प्रगति"
            >
              <div className="reading-progress-label">
                <span>वाचन प्रगति</span>
                <strong>
                  {currentLineIndex + 1} / {lines.length}
                </strong>
              </div>

              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{
                    width: `${
                      ((currentLineIndex + 1) /
                        Math.max(lines.length, 1)) *
                      100
                    }%`,
                  }}
                />
              </div>
            </div>
          )}

          <div className="primary-actions">
            <button
              className="button button-primary button-large"
              type="button"
              disabled={
                isReciting ||
                engineState !== 'online' ||
                !videoUrl ||
                !lines.length
              }
              onClick={() => void startRecitation()}
            >
              <Play size={17} fill="currentColor" />
              वाचन शुरू करें
            </button>

            <button
              className="button button-stop button-large"
              type="button"
              disabled={!isReciting}
              onClick={() => stopRecitation()}
            >
              <CircleStop size={17} />
              रोकें
            </button>
          </div>

          {notice && (
            <div
              className={`notice notice-${notice.tone}`}
              role="status"
              aria-live="polite"
            >
              <span className="notice-icon">
                {notice.tone === 'success' ? (
                  <CheckCircle2 size={16} />
                ) : notice.tone === 'error' ||
                  notice.tone === 'warning' ? (
                  <AlertCircle size={16} />
                ) : (
                  <Info size={16} />
                )}
              </span>

              <p>{notice.text}</p>

              <button
                type="button"
                className="notice-close"
                aria-label="संदेश बंद करें"
                onClick={() => setNotice(null)}
              >
                <X size={15} />
              </button>
            </div>
          )}

          <div className="workflow-note">
            <div className="workflow-note-icon">
              <Activity size={16} />
            </div>

            <div>
              <strong>लाइन सिंक्रोनाइज़ेशन</strong>
              <p>
                हर पंक्ति का ऑडियो स्थानीय मॉडल से बनाया जाता है।
                वर्तमान पंक्ति तब तक दिखाई देती है जब तक उसका
                ऑडियो समाप्त नहीं होता। इस दौरान वीडियो loop करता
                रहता है।
              </p>
            </div>
          </div>

          <div className="capability-list">
            <div>
              <CheckCircle2 size={15} />
              <span>वीडियो browser में स्थानीय रूप से preview होता है</span>
            </div>

            <div>
              <CheckCircle2 size={15} />
              <span>पाठ browser storage में auto-save होता है</span>
            </div>

            <div>
              <CheckCircle2 size={15} />
              <span>उच्चारण कोश frontend और local TTS से जुड़ा है</span>
            </div>
          </div>
        </aside>
      </div>

      <footer className="footer">
        <span>श्रुति · लोकल वैदिक वाचन कार्यशाला</span>
        <span>
          UI build v1.0 ·{' '}
          <a
            href="https://github.com/ai4bharat/indic-parler-tts"
            target="_blank"
            rel="noreferrer"
          >
            Indic Parler-TTS model reference
          </a>
        </span>
      </footer>

      {showLexicon && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowLexicon(false);
            }
          }}
        >
          <section
            className="lexicon-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lexicon-title"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">
                  SHARED PRONUNCIATION DATA
                </p>

                <h2 id="lexicon-title">
                  वैदिक उच्चारण कोश
                </h2>

                <p>
                  {lexiconMetadata.name} ·{' '}
                  {lexiconMetadata.vedicCharacterCount} चिह्न ·{' '}
                  {lexiconMetadata.pronunciationCount} शब्द
                </p>
              </div>

              <button
                className="icon-button"
                aria-label="कोश बंद करें"
                type="button"
                onClick={() => setShowLexicon(false)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="modal-content">
              <div className="lexicon-warning">
                <Info size={17} />
                <p>{lexiconMetadata.importantLimit}</p>
              </div>

              <h3>उच्चारण शब्द</h3>

              <div className="word-table-wrap">
                <table className="word-table">
                  <thead>
                    <tr>
                      <th>पाठ में शब्द</th>
                      <th>TTS पाठ</th>
                      <th>उच्चारण संकेत</th>
                    </tr>
                  </thead>

                  <tbody>
                    {pronunciationEntries.map((entry) => (
                      <tr key={entry.term}>
                        <td>
                          <strong>{entry.term}</strong>
                          <small>{entry.category}</small>
                        </td>

                        <td>{entry.spoken}</td>
                        <td>{entry.guide}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3>देवनागरी और वैदिक Unicode inventory</h3>

              <div className="character-grid">
                {vedicCharacters.map((character) => (
                  <div
                    className="character-card"
                    key={character.codepoint}
                  >
                    <strong>
                      {character.display ?? character.character}
                    </strong>

                    <span>{character.codepoint}</span>

                    <small>
                      {character.name
                        .toLowerCase()
                        .replaceAll('_', ' ')}
                    </small>
                  </div>
                ))}
              </div>

              <div className="lexicon-warning subtle-warning">
                <AlertCircle size={17} />
                <p>{lexiconMetadata.accentPolicy.note}</p>
              </div>
            </div>

            <div className="modal-footer">
              <button
                className="button button-secondary"
                type="button"
                onClick={() =>
                  downloadBlob(
                    new Blob([exportLexiconJson()], {
                      type: 'application/json;charset=utf-8',
                    }),
                    'vedic-lexicon.json',
                  )
                }
              >
                <Download size={15} />
                JSON फ़ाइल डाउनलोड करें
              </button>

              <button
                className="button button-primary"
                type="button"
                onClick={() => setShowLexicon(false)}
              >
                हो गया
                <Check size={15} />
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
