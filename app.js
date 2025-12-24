/* app.js - Gemini transcription with speaker-separated chat UI + Google Drive Picker.
   Key points:
   - iPhone/iPad (iOS/iPadOS) ALWAYS uses Gemini Files API (no inline/base64), for stability.
   - Speaker bubbles are color-coded (max 10) and labels are rendered as 「話者1」…「話者10」.
*/

(() => {
  'use strict';

  // ====== Your Google Cloud OAuth Client ID & API key (for Drive Picker) ======
  const GCP_OAUTH_CLIENT_ID = '478200222114-ronuhiecjrc0lp9t1b6nnqod7cji46o3.apps.googleusercontent.com';
  const GCP_API_KEY = 'AIzaSyB6YPsmEy62ltuh1aqZX6Z5Hjx0P9mt0Lw';

  // Drive scopes required for reading chosen file
  const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.readonly';

  // Gemini Developer API base
  const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

  // Inline size thresholds (non-iOS only). Total request limit is 20MB; keep margin.
  const INLINE_MAX_BYTES = 15 * 1024 * 1024;

  // LocalStorage keys
  const LS_GEMINI_KEY = 'gemini_api_key';
  const LS_SPEAKER_COUNT = 'speaker_count';
  const LS_MODEL = 'gemini_model';
  const LS_PINNED_FOLDER = 'drive_pinned_folder';

  function $(id) {
    return document.getElementById(id);
  }

  function isIOSLike() {
    // iPadOS 13+ may report MacIntel
    const ua = navigator.userAgent || '';
    const iOS = /iP(hone|od|ad)/.test(ua);
    const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    return iOS || iPadOS;
  }

  function clampSpeakerCount(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 2;
    return Math.max(1, Math.min(10, Math.floor(x)));
  }

  function bytesToHuman(bytes) {
    if (!Number.isFinite(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = bytes;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u += 1;
    }
    return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`;
  }

  function safeJsonParseMaybe(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    // Direct
    try {
      return JSON.parse(trimmed);
    } catch {}

    // Extract first JSON object/array region
    const firstObj = trimmed.indexOf('{');
    const lastObj = trimmed.lastIndexOf('}');
    const firstArr = trimmed.indexOf('[');
    const lastArr = trimmed.lastIndexOf(']');

    const cand = [];
    if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) cand.push(trimmed.slice(firstObj, lastObj + 1));
    if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) cand.push(trimmed.slice(firstArr, lastArr + 1));

    for (const c of cand) {
      try {
        return JSON.parse(c);
      } catch {}
    }
    return null;
  }

  function toCamelGenerateRequest(body) {
    // Convert the subset we use from snake_case to lowerCamelCase for compatibility.
    const out = JSON.parse(JSON.stringify(body || {}));

    if (out.generation_config) {
      out.generationConfig = out.generation_config;
      delete out.generation_config;

      if (out.generationConfig.response_mime_type) {
        out.generationConfig.responseMimeType = out.generationConfig.response_mime_type;
        delete out.generationConfig.response_mime_type;
      }
      if (out.generationConfig.max_output_tokens != null) {
        out.generationConfig.maxOutputTokens = out.generationConfig.max_output_tokens;
        delete out.generationConfig.max_output_tokens;
      }
    }

    const contents = Array.isArray(out.contents) ? out.contents : [];
    for (const c of contents) {
      const parts = Array.isArray(c.parts) ? c.parts : [];
      for (const p of parts) {
        if (p.inline_data) {
          p.inlineData = p.inline_data;
          delete p.inline_data;
          if (p.inlineData.mime_type) {
            p.inlineData.mimeType = p.inlineData.mime_type;
            delete p.inlineData.mime_type;
          }
        }
        if (p.file_data) {
          p.fileData = p.file_data;
          delete p.file_data;
          if (p.fileData.mime_type) {
            p.fileData.mimeType = p.fileData.mime_type;
            delete p.fileData.mime_type;
          }
          if (p.fileData.file_uri) {
            p.fileData.fileUri = p.fileData.file_uri;
            delete p.fileData.file_uri;
          }
        }
      }
    }

    return out;
  }

  function toCamelFileUploadBody(body) {
    const out = JSON.parse(JSON.stringify(body || {}));
    if (out.file?.display_name) {
      out.file.displayName = out.file.display_name;
      delete out.file.display_name;
    }
    return out;
  }

  function normalizeSpeakerLabel(raw) {
    if (!raw) return '話者?';
    const s = String(raw).trim();

    // S1 / s1 / speaker1 -> 話者1
    const m = s.match(/(\d{1,2})/);
    if (m) {
      const n = clampSpeakerCount(parseInt(m[1], 10));
      return `話者${n}`;
    }

    // already Japanese
    if (s.startsWith('話者')) return s;

    return s;
  }

  function speakerIndexFromLabel(label) {
    const m = String(label || '').match(/(\d{1,2})/);
    if (!m) return 0;
    const n = clampSpeakerCount(parseInt(m[1], 10));
    return n;
  }

  class TranscriberApp {
    constructor() {
      // DOM
      this.apiKeyInput = $('apiKeyInput');
      this.saveKeyBtn = $('saveKeyBtn');
      this.toggleKeyBtn = $('toggleKeyBtn');
      this.keyStatus = $('keyStatus');

      this.modelSelect = $('modelSelect');
      this.speakerCountSelect = $('speakerCountSelect');

      this.tabDrive = $('tabDrive');
      this.tabLocal = $('tabLocal');
      this.drivePanel = $('drivePanel');
      this.localPanel = $('localPanel');

      this.driveConnectBtn = $('driveConnectBtn');
      this.driveStatus = $('driveStatus');
      this.pickFolderBtn = $('pickFolderBtn');
      this.clearFolderBtn = $('clearFolderBtn');
      this.pinnedFolderLabel = $('pinnedFolderLabel');
      this.pickFileBtn = $('pickFileBtn');

      this.localFileInput = $('localFileInput');
      this.localFileName = $('localFileName');

      this.selectedFileName = $('selectedFileName');

      this.startBtn = $('startBtn');
      this.progressBar = $('progressBar');
      this.progressText = $('progressText');
      this.promptPreview = $('promptPreview');

      this.chatThread = $('chatThread');
      this.jsonOutput = $('jsonOutput');
      this.downloadJsonBtn = $('downloadJsonBtn');

      // State
      this.geminiApiKey = '';
      this.geminiModel = 'gemini-3-flash-preview';
      this.speakerCount = 2;

      this.oauthToken = '';
      this.tokenClient = null;

      this.pinnedFolder = null; // {id,name}

      // selectedFile can be either local or drive
      this.selectedFile = null; // { name, mimeType, size, getBlob():Promise<Blob> }

      this.latestJsonText = '';

      this.init();
    }

    init() {
      this.initSpeakerSelect();
      this.loadSettings();
      this.bindEvents();
      this.renderPromptPreview();

      // Drive init is lazy (when user clicks login), but we prepare picker loading
      this.prepareGapiPickerLoad();

      this.updateUiState();
    }

    initSpeakerSelect() {
      this.speakerCountSelect.innerHTML = '';
      for (let i = 1; i <= 10; i += 1) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = String(i);
        this.speakerCountSelect.appendChild(opt);
      }
    }

    loadSettings() {
      const savedKey = localStorage.getItem(LS_GEMINI_KEY);
      if (savedKey) {
        this.geminiApiKey = savedKey;
        this.apiKeyInput.value = savedKey;
        this.keyStatus.textContent = '保存済み';
      }

      const savedSpeaker = localStorage.getItem(LS_SPEAKER_COUNT);
      if (savedSpeaker) this.speakerCount = clampSpeakerCount(savedSpeaker);

      const savedModel = localStorage.getItem(LS_MODEL);
      if (savedModel) this.geminiModel = savedModel;

      const pinnedRaw = localStorage.getItem(LS_PINNED_FOLDER);
      if (pinnedRaw) {
        try {
          this.pinnedFolder = JSON.parse(pinnedRaw);
        } catch {
          this.pinnedFolder = null;
        }
      }

      this.speakerCountSelect.value = String(this.speakerCount);
      this.modelSelect.value = this.geminiModel;

      if (this.pinnedFolder?.name) {
        this.pinnedFolderLabel.textContent = `固定: ${this.pinnedFolder.name}`;
      }
    }

    bindEvents() {
      this.saveKeyBtn.addEventListener('click', () => this.onSaveKey());
      this.toggleKeyBtn.addEventListener('click', () => this.onToggleKeyVisibility());

      this.modelSelect.addEventListener('change', () => {
        this.geminiModel = this.modelSelect.value;
        localStorage.setItem(LS_MODEL, this.geminiModel);
      });

      this.speakerCountSelect.addEventListener('change', () => {
        this.speakerCount = clampSpeakerCount(this.speakerCountSelect.value);
        localStorage.setItem(LS_SPEAKER_COUNT, String(this.speakerCount));
        this.renderPromptPreview();
      });

      this.tabDrive.addEventListener('click', () => this.setSource('drive'));
      this.tabLocal.addEventListener('click', () => this.setSource('local'));

      this.driveConnectBtn.addEventListener('click', () => this.onDriveConnect());
      this.pickFolderBtn.addEventListener('click', () => this.onPickFolder());
      this.clearFolderBtn.addEventListener('click', () => this.onClearPinnedFolder());
      this.pickFileBtn.addEventListener('click', () => this.onPickDriveFile());

      this.localFileInput.addEventListener('change', () => this.onLocalFileSelected());

      this.startBtn.addEventListener('click', () => this.onStartTranscription());
      this.downloadJsonBtn.addEventListener('click', () => this.downloadLatestJson());
    }

    setSource(which) {
      const isDrive = which === 'drive';
      this.tabDrive.classList.toggle('is-active', isDrive);
      this.tabLocal.classList.toggle('is-active', !isDrive);
      this.drivePanel.classList.toggle('is-hidden', !isDrive);
      this.localPanel.classList.toggle('is-hidden', isDrive);

      // Don't discard the selected file automatically; just show state.
      this.updateUiState();
    }

    onSaveKey() {
      const v = (this.apiKeyInput.value || '').trim();
      if (!v) {
        this.keyStatus.textContent = '未設定（空です）';
        this.geminiApiKey = '';
        localStorage.removeItem(LS_GEMINI_KEY);
        this.updateUiState();
        return;
      }
      this.geminiApiKey = v;
      localStorage.setItem(LS_GEMINI_KEY, v);
      this.keyStatus.textContent = '保存しました';
      this.updateUiState();
    }

    onToggleKeyVisibility() {
      const isPassword = this.apiKeyInput.type === 'password';
      this.apiKeyInput.type = isPassword ? 'text' : 'password';
      this.toggleKeyBtn.textContent = isPassword ? '隠す' : '表示';
    }

    updateUiState() {
      const hasKey = !!(this.geminiApiKey || (this.apiKeyInput.value || '').trim());
      const hasFile = !!this.selectedFile;

      // Drive buttons depend on oauthToken + picker readiness
      const driveReady = !!this.oauthToken && !!window.google?.picker;

      this.pickFileBtn.disabled = !driveReady;
      this.pickFolderBtn.disabled = !driveReady;
      this.clearFolderBtn.disabled = !driveReady;

      this.startBtn.disabled = !(hasKey && hasFile);
    }

    // ===== Drive / Picker =====

    prepareGapiPickerLoad() {
      // gapi.js is loaded async; when ready, we can set API key and load picker.
      const poll = async () => {
        // Wait for gapi to exist
        if (!window.gapi) {
          setTimeout(poll, 150);
          return;
        }
        try {
          window.gapi.load('picker', { callback: () => {} });
        } catch {
          // retry
          setTimeout(poll, 300);
          return;
        }
      };
      poll();
    }

    onDriveConnect() {
      if (!window.google?.accounts?.oauth2) {
        this.driveStatus.textContent = 'Google Identity Services が未ロードです';
        return;
      }
      if (!this.tokenClient) {
        this.tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: GCP_OAUTH_CLIENT_ID,
          scope: DRIVE_SCOPES,
          callback: (resp) => {
            if (resp?.access_token) {
              this.oauthToken = resp.access_token;
              this.driveStatus.textContent = '接続済み';
              this.updateUiState();
            } else {
              this.driveStatus.textContent = '接続失敗';
            }
          }
        });
      }
      this.tokenClient.requestAccessToken({ prompt: '' });
    }

    async ensurePickerReady() {
      // Wait for google.picker and gapi
      const start = Date.now();
      while (!window.google?.picker) {
        if (Date.now() - start > 8000) throw new Error('Picker のロードに失敗しました');
        await new Promise(r => setTimeout(r, 120));
      }
      return true;
    }

    async onPickFolder() {
      try {
        await this.ensurePickerReady();
        if (!this.oauthToken) throw new Error('Drive に未接続です');

        const view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true);

        const picker = new window.google.picker.PickerBuilder()
          .setAppId('478200222114')
          .setOAuthToken(this.oauthToken)
          .setDeveloperKey(GCP_API_KEY)
          .addView(view)
          .enableFeature(window.google.picker.Feature.SUPPORT_DRIVES)
          .setCallback((data) => this.onFolderPicked(data))
          .build();

        picker.setVisible(true);
      } catch (e) {
        this.driveStatus.textContent = `フォルダ選択エラー: ${e?.message || e}`;
      }
    }

    onFolderPicked(data) {
      const Action = window.google.picker.Action;
      if (data.action !== Action.PICKED) return;
      const doc = data.docs?.[0];
      if (!doc?.id) return;

      this.pinnedFolder = { id: doc.id, name: doc.name || doc.id };
      localStorage.setItem(LS_PINNED_FOLDER, JSON.stringify(this.pinnedFolder));
      this.pinnedFolderLabel.textContent = `固定: ${this.pinnedFolder.name}`;

      // iOS/Safari: avoid accidental navigation by forcing focus back
      this.pinnedFolderLabel.scrollIntoView({ block: 'nearest' });

      this.updateUiState();
    }

    onClearPinnedFolder() {
      this.pinnedFolder = null;
      localStorage.removeItem(LS_PINNED_FOLDER);
      this.pinnedFolderLabel.textContent = '固定なし';
      this.updateUiState();
    }

    async onPickDriveFile() {
      try {
        await this.ensurePickerReady();
        if (!this.oauthToken) throw new Error('Drive に未接続です');

        const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
          .setIncludeFolders(false)
          .setMimeTypes([
            // audio
            'audio/mpeg','audio/mp3','audio/mp4','audio/wav','audio/x-wav','audio/aac','audio/ogg','audio/webm','audio/flac',
            // video
            'video/mp4','video/quicktime','video/webm','video/x-matroska'
          ].join(','));

        // Folder pin: if setParent is used, do NOT use DocsView.setEnableDrives(true) (it would override parent).
        if (this.pinnedFolder?.id) {
          view.setParent(this.pinnedFolder.id);
        }

        const picker = new window.google.picker.PickerBuilder()
          .setAppId('478200222114')
          .setOAuthToken(this.oauthToken)
          .setDeveloperKey(GCP_API_KEY)
          .addView(view)
          .enableFeature(window.google.picker.Feature.SUPPORT_DRIVES)
          .setCallback((data) => this.onDriveFilePicked(data))
          .build();

        picker.setVisible(true);
      } catch (e) {
        this.driveStatus.textContent = `ファイル選択エラー: ${e?.message || e}`;
      }
    }

    async onDriveFilePicked(data) {
      const Action = window.google.picker.Action;
      if (data.action !== Action.PICKED) return;

      const doc = data.docs?.[0];
      if (!doc?.id) return;

      const picked = {
        id: doc.id,
        name: doc.name || 'drive_file',
        mimeType: doc.mimeType || '',
        sizeBytes: Number(doc.sizeBytes || doc.size || 0)
      };

      // Resolve shortcuts (if any)
      const resolved = await this.resolveDriveShortcutIfNeeded(picked.id);
      const meta = await this.getDriveFileMeta(resolved);

      const finalName = meta.name || picked.name;
      const finalMime = meta.mimeType || picked.mimeType || 'application/octet-stream';
      const finalSize = Number(meta.size || picked.sizeBytes || 0);

      this.selectedFile = {
        name: finalName,
        mimeType: finalMime,
        size: finalSize,
        getBlob: async () => this.downloadDriveFileBlob(resolved)
      };

      this.selectedFileName.textContent = `${finalName} (${bytesToHuman(finalSize)})`;
      this.localFileName.textContent = '未選択';
      this.localFileInput.value = '';

      this.updateUiState();
      this.renderPromptPreview();
    }

    async resolveDriveShortcutIfNeeded(fileId) {
      // If fileId points to a shortcut, resolve to the target.
      try {
        const meta = await this.getDriveFileMeta(fileId, 'mimeType,shortcutDetails');
        if (meta?.mimeType === 'application/vnd.google-apps.shortcut' && meta.shortcutDetails?.targetId) {
          return meta.shortcutDetails.targetId;
        }
      } catch {
        // ignore
      }
      return fileId;
    }

    async getDriveFileMeta(fileId, fields = 'id,name,mimeType,size,shortcutDetails') {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
      url.searchParams.set('fields', fields);
      url.searchParams.set('supportsAllDrives', 'true');

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.oauthToken}` }
      });
      if (!res.ok) throw new Error(`Drive metadata 取得失敗: ${res.status}`);
      return res.json();
    }

    async downloadDriveFileBlob(fileId) {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
      url.searchParams.set('alt', 'media');
      url.searchParams.set('supportsAllDrives', 'true');

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.oauthToken}` }
      });
      if (!res.ok) throw new Error(`Drive download 失敗: ${res.status}`);
      return res.blob();
    }

    // ===== Local file =====

    onLocalFileSelected() {
      const f = this.localFileInput.files?.[0];
      if (!f) {
        this.localFileName.textContent = '未選択';
        this.selectedFile = null;
        this.updateUiState();
        return;
      }
      this.localFileName.textContent = `${f.name} (${bytesToHuman(f.size)})`;
      this.selectedFileName.textContent = `${f.name} (${bytesToHuman(f.size)})`;

      this.selectedFile = {
        name: f.name,
        mimeType: f.type || 'application/octet-stream',
        size: f.size,
        getBlob: async () => f
      };

      this.updateUiState();
      this.renderPromptPreview();
    }

    // ===== Prompt / Transcription =====

    buildPrompt() {
      const n = clampSpeakerCount(this.speakerCount);
      const speakerList = Array.from({ length: n }, (_, i) => `話者${i + 1}`).join('、');

      // JSON schema (simple) for predictable parsing
      const schema = {
        type: 'object',
        properties: {
          segments: {
            type: 'array',
            description: '発話の順番を保持した配列（時刻は不要）。',
            items: {
              type: 'object',
              properties: {
                speaker: { type: 'string', description: `話者ラベル。必ず ${speakerList} のいずれか。` },
                text: { type: 'string', description: '発話内容（日本語）' }
              },
              required: ['speaker', 'text'],
              additionalProperties: false
            }
          }
        },
        required: ['segments'],
        additionalProperties: false
      };

      const prompt = [
        '音声/動画を日本語で文字起こししてください。',
        '長くても最後まで諦めずに生成してください。',
        '話者分離を行い、話者別にラベルを付けてください。',
        '文字起こし以外の説明、コメント、タイムスタンプは禁止します。',
        '',
        `話者は ${n} 人です。使用できる話者ラベルは次の通りです: ${speakerList}`,
        '',
        '出力は必ず JSON のみ。次の JSON Schema に厳密に従ってください:',
        JSON.stringify(schema, null, 2)
      ].join('\n');

      return { prompt, schema };
    }

    renderPromptPreview() {
      const { prompt } = this.buildPrompt();
      this.promptPreview.textContent = prompt;
    }

    setProgress(percent, text) {
      const p = Math.max(0, Math.min(100, Number(percent) || 0));
      this.progressBar.style.width = `${p}%`;
      this.progressText.textContent = text || '';
    }

    async onStartTranscription() {
      try {
        this.geminiApiKey = (this.geminiApiKey || (this.apiKeyInput.value || '').trim());
        if (!this.geminiApiKey) throw new Error('Gemini API Key が未設定です');
        if (!this.selectedFile) throw new Error('ファイルが未選択です');

        this.startBtn.disabled = true;
        this.downloadJsonBtn.disabled = true;
        this.chatThread.innerHTML = '';
        this.jsonOutput.textContent = '';
        this.latestJsonText = '';

        this.setProgress(5, 'ファイル準備中...');
        const blob = await this.selectedFile.getBlob();
        const mimeType = this.selectedFile.mimeType || blob.type || 'application/octet-stream';
        const displayName = this.selectedFile.name || 'media';

        // Important: iOS always uses Files API (no inline/base64)
        const forceFilesApi = isIOSLike();
        const useFilesApi = forceFilesApi || blob.size > INLINE_MAX_BYTES;

        this.setProgress(15, useFilesApi ? 'Files API へアップロード中...' : 'インライン送信準備中...');

        let resultText = '';
        if (useFilesApi) {
          const fileInfo = await this.uploadViaFilesApi(blob, mimeType, displayName);
          this.setProgress(55, 'Gemini に文字起こしリクエスト中...');
          resultText = await this.generateWithFileUri(fileInfo.file.uri, mimeType);
        } else {
          const base64 = await this.blobToBase64(blob);
          this.setProgress(55, 'Gemini に文字起こしリクエスト中...');
          resultText = await this.generateWithInline(base64, mimeType);
        }

        this.setProgress(80, '結果を解析中...');
        this.latestJsonText = resultText;
        this.jsonOutput.textContent = this.prettyJsonOrRaw(resultText);
        this.downloadJsonBtn.disabled = false;

        const parsed = safeJsonParseMaybe(resultText);
        const messages = this.extractMessages(parsed, resultText);
        this.renderChat(messages);

        this.setProgress(100, '完了');
      } catch (e) {
        this.setProgress(0, `エラー: ${e?.message || e}`);
      } finally {
        this.updateUiState();
      }
    }

    prettyJsonOrRaw(text) {
      const obj = safeJsonParseMaybe(text);
      if (!obj) return String(text || '');
      try {
        return JSON.stringify(obj, null, 2);
      } catch {
        return String(text || '');
      }
    }

    extractMessages(parsed, rawText) {
      // Output preference:
      // { "segments": [ { "speaker":"話者1", "text":"..." }, ... ] }
      const messages = [];

      if (parsed && Array.isArray(parsed.segments)) {
        for (const seg of parsed.segments) {
          const speaker = normalizeSpeakerLabel(seg?.speaker);
          const text = (seg?.text ?? '').toString();
          if (!text.trim()) continue;
          messages.push({ speaker, text });
        }
        return messages;
      }

      // Fallback: if model returned something else, keep as one message
      const fallback = String(rawText || '').trim();
      if (fallback) {
        messages.push({ speaker: '話者?', text: fallback });
      }
      return messages;
    }

    renderChat(messages) {
      if (!messages.length) {
        this.chatThread.innerHTML = '<div class="muted">結果が空でした。</div>';
        return;
      }
      this.chatThread.innerHTML = '';

      for (const m of messages) {
        const label = normalizeSpeakerLabel(m.speaker);
        const idx = speakerIndexFromLabel(label);
        const row = document.createElement('div');
        row.className = `msg-row ${idx ? `speaker-${idx}` : ''}`.trim();

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.textContent = label; // 「S1」ではなく「話者1」

        const bubble = document.createElement('div');
        bubble.className = 'bubble';

        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = label;

        const text = document.createElement('div');
        text.className = 'text';
        text.textContent = m.text;

        bubble.appendChild(meta);
        bubble.appendChild(text);

        row.appendChild(avatar);
        row.appendChild(bubble);
        this.chatThread.appendChild(row);
      }
    }

    // ===== Gemini API calls =====

    async generateWithInline(base64Data, mimeType) {
      if (!base64Data) throw new Error('inline データが空です');
      const { prompt } = this.buildPrompt();

      // REST API expects snake_case fields for generativelanguage v1beta
      const body = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Data } }
            ]
          }
        ],
        generation_config: {
          response_mime_type: 'application/json',
          max_output_tokens: 8192
        }
      };

      return this.callGenerateContent(body);
    }

    async generateWithFileUri(fileUri, mimeType) {
      if (!fileUri) throw new Error('file_uri が空です');
      const { prompt } = this.buildPrompt();

      const body = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { file_data: { mime_type: mimeType, file_uri: fileUri } }
            ]
          }
        ],
        generation_config: {
          response_mime_type: 'application/json',
          max_output_tokens: 8192
        }
      };

      return this.callGenerateContent(body);
    }

    async callGenerateContent(body) {
      const url = `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(this.geminiModel)}:generateContent?key=${encodeURIComponent(this.geminiApiKey)}`;

      // 1st try: snake_case (as documented in Gemini API reference)
      let res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      let json = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = json?.error?.message || '';

        // 2nd try: lowerCamelCase (in case the backend expects protobuf JSON mapping)
        const shouldRetry =
          msg.includes('Unknown name') ||
          msg.includes('Invalid JSON payload') ||
          msg.includes('Cannot find field') ||
          msg.includes('unknown field') ||
          msg.includes('Unrecognized field');

        if (shouldRetry) {
          const altBody = toCamelGenerateRequest(body);
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(altBody)
          });
          json = await res.json().catch(() => null);
        }
      }

      if (!res.ok) {
        const msg = json?.error?.message || `HTTP ${res.status}`;
        throw new Error(msg);
      }

      const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
      if (!text.trim()) {
        // JSON mode sometimes returns structured JSON as text; if empty, return full response for debugging.
        return JSON.stringify(json, null, 2);
      }
      return text;
    }

    // ===== Gemini Files API upload (resumable) =====

    async uploadViaFilesApi(blob, mimeType, displayName) {
      // Start resumable session
      const startUrl = `${GEMINI_BASE_URL}/upload/v1beta/files?key=${encodeURIComponent(this.geminiApiKey)}`;

      const snakeBody = { file: { display_name: displayName || 'media' } };
      const camelBody = toCamelFileUploadBody(snakeBody);

      const startTry = async (body) => fetch(startUrl, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(blob.size),
          'X-Goog-Upload-Header-Content-Type': mimeType,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      let startRes = await startTry(snakeBody);
      if (!startRes.ok) {
        // Retry with camelCase field names if backend expects protobuf JSON mapping
        startRes = await startTry(camelBody);
      }

      if (!startRes.ok) {
        const t = await startRes.text().catch(() => '');
        throw new Error(`Files API start 失敗: ${startRes.status} ${t}`);
      }

      const uploadUrl = startRes.headers.get('x-goog-upload-url') || startRes.headers.get('X-Goog-Upload-URL');
      if (!uploadUrl) throw new Error('Files API upload URL が取得できません');

      // Upload bytes
      const upRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Length': String(blob.size),
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize'
        },
        body: blob
      });

      const fileInfo = await upRes.json().catch(() => null);
      if (!upRes.ok) {
        const msg = fileInfo?.error?.message || `Files API upload 失敗: ${upRes.status}`;
        throw new Error(msg);
      }

      // Wait until ACTIVE (some files are PROCESSING)
      const fileName = fileInfo?.file?.name;
      if (fileName) {
        await this.waitForFileActive(fileName);
      }

      return fileInfo;
    }

    async waitForFileActive(fileName) {
      // Poll Files API until ACTIVE (some uploads are processed asynchronously).
      const url = `${GEMINI_BASE_URL}/v1beta/${encodeURIComponent(fileName)}?key=${encodeURIComponent(this.geminiApiKey)}`;
      const start = Date.now();
      let delay = 600;

      while (Date.now() - start < 45000) {
        const res = await fetch(url, { method: 'GET' });
        if (res.ok) {
          const j = await res.json().catch(() => null);
          const state = j?.file?.state || j?.state || '';
          if (state === 'ACTIVE' || state === 'STATE_ACTIVE') return true;
          if (state === 'FAILED' || state === 'STATE_FAILED') throw new Error('Files API: ファイル処理に失敗しました');
        }
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(5000, Math.floor(delay * 1.35));
      }
      // Not fatal; proceed anyway
      return false;
    }

    async blobToBase64(blob) {
      // Convert Blob to base64 (without data: prefix)
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('base64 変換に失敗しました'));
        reader.onload = () => {
          const result = String(reader.result || '');
          const comma = result.indexOf(',');
          if (comma === -1) return reject(new Error('base64 形式が不正です'));
          resolve(result.slice(comma + 1));
        };
        reader.readAsDataURL(blob);
      });
    }

    // ===== Download =====

    downloadLatestJson() {
      const content = this.prettyJsonOrRaw(this.latestJsonText);
      const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = 'transcript.json';
      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    // expose for debugging
    window.__transcriberApp = new TranscriberApp();
  });
})();
