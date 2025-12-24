/**
 * Gemini Transcriber - 仕切り直し版
 * - 元のダーク/Glass UIに寄せる（index/stylesの系統を踏襲） 
 * - “フォルダ固定”は削除（安定化優先）
 * - Files APIはブラウザで通りやすい FormData 単発POST（resumableは使わない） :contentReference[oaicite:5]{index=5}
 * - 出力は JSON（segments: [{speaker,text}]）→ チャット表示＋JSON表示
 * - 話者色は最大20
 */

/* === Drive settings (コード埋め込みOKという要望に従う) === */
const GCP_OAUTH_CLIENT_ID = '478200222114-ronuhiecjrc0lp9t1b6nnqod7cji46o3.apps.googleusercontent.com';
const GCP_API_KEY = 'AIzaSyB6YPsmEy62ltuh1aqZX6Z5Hjx0P9mt0Lw';
const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.readonly';

class GeminiTranscriber {
  constructor() {
    // DOM
    this.apiKeyInput = document.getElementById('apiKeyInput');
    this.toggleApiKeyBtn = document.getElementById('toggleApiKey');
    this.saveApiKeyBtn = document.getElementById('saveApiKey');
    this.apiKeyFile = document.getElementById('apiKeyFile');
    this.apiKeyStatus = document.getElementById('apiKeyStatus');

    this.modelSelect = document.getElementById('modelSelect');
    this.speakerCountSelect = document.getElementById('speakerCount');

    this.driveLoginBtn = document.getElementById('driveLoginBtn');
    this.drivePickBtn = document.getElementById('drivePickBtn');
    this.driveStatus = document.getElementById('driveStatus');

    this.dropzone = document.getElementById('dropzone');
    this.audioFileInput = document.getElementById('audioFileInput');
    this.fileList = document.getElementById('fileList');

    this.transcribeBtn = document.getElementById('transcribeBtn');
    this.progressSection = document.getElementById('progressSection');
    this.progressFill = document.getElementById('progressFill');
    this.progressText = document.getElementById('progressText');

    this.resultsSection = document.getElementById('resultsSection');
    this.resultsList = document.getElementById('resultsList');

    // State
    this.files = []; // { id, name, size, mimeType, source, getBlob():Promise<Blob> }
    this.apiKey = '';
    this.isProcessing = false;

    this.model = 'gemini-3-flash-preview'; // :contentReference[oaicite:6]{index=6}
    this.speakerCount = 2;

    // Drive
    this.oauthToken = '';
    this.tokenClient = null;
    this.pickerReady = false;

    this.init();
  }

  init() {
    this.initSpeakerSelect();
    this.bindEvents();
    this.loadSavedSettings();
    this.initPickerLoader();
    this.updateTranscribeButton();
  }

  initSpeakerSelect() {
    this.speakerCountSelect.innerHTML = '';
    for (let i = 1; i <= 20; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = String(i);
      this.speakerCountSelect.appendChild(opt);
    }
  }

  bindEvents() {
    // API key
    this.apiKeyInput.addEventListener('input', () => this.onApiKeyInput());
    this.toggleApiKeyBtn.addEventListener('click', () => this.toggleApiKeyVisibility());
    this.saveApiKeyBtn.addEventListener('click', () => this.saveApiKey());
    this.apiKeyFile.addEventListener('change', (e) => this.loadApiKeyFile(e));

    // model / speakers
    this.modelSelect.addEventListener('change', () => {
      this.model = this.modelSelect.value;
      localStorage.setItem('gemini_model', this.model);
    });
    this.speakerCountSelect.addEventListener('change', () => {
      this.speakerCount = this.clampSpeaker(parseInt(this.speakerCountSelect.value, 10));
      localStorage.setItem('speaker_count', String(this.speakerCount));
    });

    // drive
    this.driveLoginBtn.addEventListener('click', () => this.driveLogin());
    this.drivePickBtn.addEventListener('click', () => this.openDrivePicker());

    // file upload
    this.dropzone.addEventListener('click', (e) => {
      if (e.target.closest('.file-select-btn')) return;
      this.audioFileInput.click();
    });
    this.dropzone.addEventListener('dragover', (e) => this.onDragOver(e));
    this.dropzone.addEventListener('dragleave', () => this.onDragLeave());
    this.dropzone.addEventListener('drop', (e) => this.onDrop(e));
    this.audioFileInput.addEventListener('change', (e) => this.onFileSelect(e));

    // transcribe
    this.transcribeBtn.addEventListener('click', () => this.startTranscription());
  }

  loadSavedSettings() {
    try {
      const savedKey = localStorage.getItem('gemini_api_key');
      if (savedKey) {
        this.apiKeyInput.value = savedKey;
        this.apiKey = savedKey;
        this.updateApiKeyStatus(true, '✓ 設定済み');
      }

      const savedModel = localStorage.getItem('gemini_model');
      if (savedModel) this.model = savedModel;

      const savedSp = localStorage.getItem('speaker_count');
      if (savedSp) this.speakerCount = this.clampSpeaker(parseInt(savedSp, 10));

      this.modelSelect.value = this.model;
      this.speakerCountSelect.value = String(this.speakerCount);
    } catch (e) {
      // localStorageが使えない環境もあるため黙って継続
    }
  }

  onApiKeyInput() {
    this.apiKey = this.apiKeyInput.value.trim();
    this.updateTranscribeButton();
  }

  saveApiKey() {
    this.apiKey = this.apiKeyInput.value.trim();
    if (!this.apiKey) {
      this.updateApiKeyStatus(false, 'APIキーを入力してください');
      this.updateTranscribeButton();
      return;
    }

    try {
      localStorage.setItem('gemini_api_key', this.apiKey);
      this.updateApiKeyStatus(true, '✓ 保存しました');
      this.saveApiKeyBtn.classList.add('saved');
      this.saveApiKeyBtn.textContent = '✓ 保存済';
      setTimeout(() => {
        this.saveApiKeyBtn.classList.remove('saved');
        this.saveApiKeyBtn.textContent = '💾 保存';
      }, 1500);
    } catch (e) {
      this.updateApiKeyStatus(false, '保存に失敗しました');
    }

    this.updateTranscribeButton();
  }

  toggleApiKeyVisibility() {
    if (this.apiKeyInput.type === 'password') {
      this.apiKeyInput.type = 'text';
      this.toggleApiKeyBtn.textContent = '🙈';
    } else {
      this.apiKeyInput.type = 'password';
      this.toggleApiKeyBtn.textContent = '👁️';
    }
  }

  async loadApiKeyFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      this.apiKey = text.trim();
      this.apiKeyInput.value = this.apiKey;
      localStorage.setItem('gemini_api_key', this.apiKey);
      this.updateApiKeyStatus(true, 'ファイルから読み込み完了');
      this.updateTranscribeButton();
    } catch (err) {
      this.updateApiKeyStatus(false, '読み込み失敗');
    }
  }

  updateApiKeyStatus(success, message = '') {
    if (success) {
      this.apiKeyStatus.textContent = message || '✓ 設定済み';
      this.apiKeyStatus.className = 'status-badge success';
    } else {
      this.apiKeyStatus.textContent = message || '';
      this.apiKeyStatus.className = message ? 'status-badge error' : 'status-badge';
    }
  }

  // ===== Drive =====

  initPickerLoader() {
    const poll = () => {
      if (!window.gapi) return setTimeout(poll, 120);
      try {
        window.gapi.load('picker', {
          callback: () => { this.pickerReady = true; this.refreshDriveUi(); }
        });
      } catch {
        setTimeout(poll, 250);
      }
    };
    poll();
  }

  refreshDriveUi() {
    const canPick = !!this.oauthToken && this.pickerReady && !!window.google?.picker;
    this.drivePickBtn.disabled = !canPick;
    if (!this.driveStatus.textContent) this.driveStatus.textContent = canPick ? '接続済み' : '未接続';
  }

  driveLogin() {
    if (!window.google?.accounts?.oauth2) {
      this.driveStatus.textContent = 'Google認証の読み込み待ちです';
      this.driveStatus.className = 'status-badge error';
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
            this.driveStatus.className = 'status-badge success';
            this.refreshDriveUi();
          } else {
            this.driveStatus.textContent = '接続失敗';
            this.driveStatus.className = 'status-badge error';
          }
        }
      });
    }
    this.tokenClient.requestAccessToken({ prompt: '' });
  }

  async openDrivePicker() {
    try {
      if (!this.oauthToken) throw new Error('Driveに未接続です');
      if (!this.pickerReady || !window.google?.picker) throw new Error('Pickerの準備中です');

      const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
        .setIncludeFolders(false)
        .setMimeTypes([
          'audio/mpeg','audio/mp3','audio/mp4','audio/wav','audio/x-wav','audio/aac','audio/ogg','audio/webm','audio/flac',
          'video/mp4','video/quicktime','video/webm','video/x-matroska'
        ].join(','));

      const picker = new window.google.picker.PickerBuilder()
        .setOAuthToken(this.oauthToken)
        .setDeveloperKey(GCP_API_KEY)
        .addView(view)
        .enableFeature(window.google.picker.Feature.SUPPORT_DRIVES) // 共有ドライブ/共有アイテムも対象
        .setCallback((data) => this.onDrivePicked(data))
        .build();

      picker.setVisible(true);
    } catch (e) {
      this.driveStatus.textContent = e?.message || String(e);
      this.driveStatus.className = 'status-badge error';
    }
  }

  async onDrivePicked(data) {
    const Action = window.google.picker.Action;
    if (data.action !== Action.PICKED) return;

    const doc = data.docs?.[0];
    if (!doc?.id) return;

    try {
      const fileId = await this.resolveShortcut(doc.id);
      const meta = await this.getDriveMeta(fileId);
      const name = meta.name || doc.name || 'drive_file';
      const mimeType = meta.mimeType || doc.mimeType || 'application/octet-stream';
      const size = Number(meta.size || 0);

      const item = {
        id: crypto.randomUUID(),
        name,
        size,
        mimeType,
        source: 'drive',
        getBlob: async () => this.downloadDriveBlob(fileId)
      };

      this.files.push(item);
      this.renderFileList();
      this.updateTranscribeButton();
    } catch (e) {
      this.driveStatus.textContent = `取得失敗: ${e?.message || e}`;
      this.driveStatus.className = 'status-badge error';
    }
  }

  async resolveShortcut(fileId) {
    try {
      const meta = await this.getDriveMeta(fileId, 'mimeType,shortcutDetails');
      if (meta?.mimeType === 'application/vnd.google-apps.shortcut' && meta.shortcutDetails?.targetId) {
        return meta.shortcutDetails.targetId;
      }
    } catch {}
    return fileId;
  }

  async getDriveMeta(fileId, fields = 'id,name,mimeType,size,shortcutDetails') {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('supportsAllDrives', 'true');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.oauthToken}` }
    });
    if (!res.ok) throw new Error(`Drive metadata: HTTP ${res.status}`);
    return res.json();
  }

  async downloadDriveBlob(fileId) {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set('alt', 'media');
    url.searchParams.set('supportsAllDrives', 'true');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.oauthToken}` }
    });
    if (!res.ok) throw new Error(`Drive download: HTTP ${res.status}`);
    return res.blob();
  }

  // ===== Local file =====

  onDragOver(e) { e.preventDefault(); this.dropzone.classList.add('dragover'); }
  onDragLeave() { this.dropzone.classList.remove('dragover'); }

  onDrop(e) {
    e.preventDefault();
    this.dropzone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files || []);
    this.addLocalFiles(files);
  }

  onFileSelect(e) {
    const files = Array.from(e.target.files || []);
    this.addLocalFiles(files);
    e.target.value = '';
  }

  addLocalFiles(files) {
    const audioFiles = files.filter(file =>
      file.type.startsWith('audio/') ||
      file.type.startsWith('video/') ||
      /\.(mp3|wav|m4a|webm|ogg|mp4|flac|mov)$/i.test(file.name)
    );

    const mapped = audioFiles.map(f => ({
      id: crypto.randomUUID(),
      name: f.name,
      size: f.size,
      mimeType: f.type || this.guessMime(f.name),
      source: 'local',
      getBlob: async () => f
    }));

    this.files.push(...mapped);
    this.renderFileList();
    this.updateTranscribeButton();
  }

  removeFileById(id) {
    this.files = this.files.filter(f => f.id !== id);
    this.renderFileList();
    this.updateTranscribeButton();
  }

  renderFileList() {
    if (this.files.length === 0) {
      this.fileList.innerHTML = '';
      return;
    }

    this.fileList.innerHTML = this.files.map((file) => `
      <div class="file-item">
        <div class="file-item-info">
          <span class="file-item-icon">${file.source === 'drive' ? '☁️' : '🎵'}</span>
          <div>
            <div class="file-item-name">${this.escapeHtml(file.name)}</div>
            <div class="file-item-size">${this.formatFileSize(file.size)}${file.source === 'drive' ? '（Drive）' : ''}</div>
          </div>
        </div>
        <button class="file-item-remove" data-remove="${file.id}" title="削除" type="button">✕</button>
      </div>
    `).join('');

    this.fileList.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => this.removeFileById(btn.getAttribute('data-remove')));
    });
  }

  formatFileSize(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  updateTranscribeButton() {
    this.transcribeBtn.disabled = !this.apiKey || this.files.length === 0 || this.isProcessing;
  }

  // ===== Transcription pipeline =====

  async startTranscription() {
    if (this.isProcessing) return;

    this.apiKey = (this.apiKeyInput.value || '').trim();
    if (!this.apiKey) {
      this.updateApiKeyStatus(false, 'APIキーを入力してください');
      return;
    }

    this.isProcessing = true;
    this.updateTranscribeButton();

    this.progressSection.style.display = 'block';
    this.resultsSection.style.display = 'block';
    this.resultsList.innerHTML = '';

    const total = this.files.length;

    for (let i = 0; i < total; i++) {
      const f = this.files[i];
      const pct = Math.floor((i / total) * 100);
      this.progressFill.style.width = `${pct}%`;
      this.progressText.textContent = `処理中: ${f.name} (${i + 1}/${total})`;

      await this.transcribeOne(f, i);
    }

    this.progressFill.style.width = '100%';
    this.progressText.textContent = `完了！ ${total}ファイルを処理しました`;

    this.isProcessing = false;
    this.files = [];
    this.renderFileList();
    this.updateTranscribeButton();
  }

  async transcribeOne(fileItem, index) {
    const resultId = `result-${index}-${fileItem.id}`;

    this.resultsList.innerHTML += `
      <div class="result-item" id="${resultId}">
        <div class="result-header">
          <span class="result-filename">📄 ${this.escapeHtml(fileItem.name)}</span>
          <span class="status-badge" id="${resultId}-status">アップロード準備...</span>
        </div>
        <div class="result-tabs">
          <button class="tab-btn active" data-tab="chat" data-for="${resultId}" type="button">チャット</button>
          <button class="tab-btn" data-tab="json" data-for="${resultId}" type="button">JSON</button>
        </div>
        <div class="chat-view" id="${resultId}-chat">準備中...</div>
        <pre class="json-view" id="${resultId}-json" style="display:none;">準備中...</pre>
      </div>
    `;

    this.bindResultTabs(resultId);

    const statusEl = document.getElementById(`${resultId}-status`);
    const chatEl = document.getElementById(`${resultId}-chat`);
    const jsonEl = document.getElementById(`${resultId}-json`);

    try {
      statusEl.textContent = 'ファイル取得中...';
      const blob = await fileItem.getBlob();
      const mimeType = fileItem.mimeType || blob.type || 'application/octet-stream';

      statusEl.textContent = 'アップロード中...';
      const uploaded = await this.uploadFileToGemini(blob, fileItem.name);

      statusEl.textContent = 'ファイル処理待ち...';
      await this.waitForFileActive(uploaded.name);

      statusEl.textContent = '文字起こし中...';
      const prompt = this.buildPrompt(this.speakerCount);

      const resultText = await this.generateWithFile(uploaded.uri, mimeType, prompt);

      const parsed = this.safeJsonParseMaybe(resultText);
      const pretty = parsed ? JSON.stringify(parsed, null, 2) : resultText;

      jsonEl.textContent = pretty;

      const segments = this.extractSegments(parsed, resultText);
      chatEl.innerHTML = this.renderChatHtml(segments);

      statusEl.textContent = '完了';
      statusEl.className = 'status-badge success';

      // cleanup（失敗しても無視）
      try {
        await fetch(`https://generativelanguage.googleapis.com/v1beta/${uploaded.name}?key=${encodeURIComponent(this.apiKey)}`, {
          method: 'DELETE'
        });
      } catch {}

    } catch (e) {
      const msg = this.normalizeFetchError(e);
      statusEl.textContent = 'エラー';
      statusEl.className = 'status-badge error';
      chatEl.innerHTML = `<div class="result-error">❌ ${this.escapeHtml(msg)}</div>`;
      jsonEl.textContent = msg;
    }
  }

  bindResultTabs(resultId) {
    const root = document.getElementById(resultId);
    if (!root) return;

    root.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        root.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const chat = document.getElementById(`${resultId}-chat`);
        const json = document.getElementById(`${resultId}-json`);
        if (tab === 'chat') {
          chat.style.display = 'block';
          json.style.display = 'none';
        } else {
          chat.style.display = 'none';
          json.style.display = 'block';
        }
      });
    });
  }

  buildPrompt(speakerCount) {
    const n = this.clampSpeaker(speakerCount);
    const labels = Array.from({ length: n }, (_, i) => `話者${i + 1}`).join('、');

    return [
      '音声/動画を日本語で文字起こししてください。',
      '長くても最後まで諦めずに生成してください。',
      '話者分離をして話者別にラベルを付けて出力してください。',
      '文字起こし以外の説明、コメント、タイムスタンプは禁止します。',
      '',
      `話者は ${n} 人です。使用できる話者ラベルは次のみ: ${labels}`,
      '',
      '出力は必ずJSONのみ。以下の形式に厳密に従ってください。',
      '{',
      '  "segments": [',
      '    { "speaker": "話者1", "text": "..." },',
      '    { "speaker": "話者2", "text": "..." }',
      '  ]',
      '}'
    ].join('\n');
  }

  async uploadFileToGemini(blob, displayName) {
    // ブラウザで通りやすい FormData 方式（仕切り直しの要点）
    const formData = new FormData();
    // name指定はブラウザ依存なので、ファイル名はここで付ける
    const file = new File([blob], displayName || 'media', { type: blob.type || 'application/octet-stream' });
    formData.append('file', file);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(this.apiKey)}`,
      { method: 'POST', body: formData }
    );

    if (!res.ok) {
      let err;
      try { err = await res.json(); } catch {}
      throw new Error(err?.error?.message || `Upload failed: HTTP ${res.status}`);
    }

    const data = await res.json();
    const uri = data?.file?.uri;
    const name = data?.file?.name;
    if (!uri || !name) throw new Error('Upload response is missing file.uri or file.name');
    return { uri, name };
  }

  async waitForFileActive(fileName) {
    const maxAttempts = 90;
    for (let i = 0; i < maxAttempts; i++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(this.apiKey)}`,
        { method: 'GET' }
      );

      if (res.ok) {
        const data = await res.json();
        if (data?.state === 'ACTIVE') return;
        if (data?.state === 'FAILED') throw new Error('File processing failed');
      }

      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('File processing timeout');
  }

  async generateWithFile(fileUri, mimeType, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    // 1st: camelCase（推奨）
    const body1 = {
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { fileData: { mimeType: mimeType || 'application/octet-stream', fileUri } }
        ]
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 8192,
        temperature: 0.2
      }
    };

    let res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body1)
    });

    let data = null;
    try { data = await res.json(); } catch {}

    // fallback: snake_case
    if (!res.ok) {
      const body2 = {
        contents: [{
          parts: [
            { text: prompt },
            { file_data: { mime_type: mimeType || 'application/octet-stream', file_uri: fileUri } }
          ]
        }],
        generation_config: {
          response_mime_type: 'application/json',
          max_output_tokens: 8192,
          temperature: 0.2
        }
      };

      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body2)
      });

      try { data = await res.json(); } catch {}
    }

    if (!res.ok) {
      throw new Error(data?.error?.message || `API Error: HTTP ${res.status}`);
    }

    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
    return text || JSON.stringify(data, null, 2);
  }

  extractSegments(parsed, rawText) {
    if (parsed && Array.isArray(parsed.segments)) {
      return parsed.segments
        .map(s => ({
          speaker: this.normalizeSpeaker(s?.speaker),
          text: String(s?.text ?? '').trim()
        }))
        .filter(x => x.text);
    }

    // JSONが崩れた場合の最終フォールバック
    const fallback = String(rawText || '').trim();
    return fallback ? [{ speaker: '話者?', text: fallback }] : [];
  }

  renderChatHtml(segments) {
    if (!segments.length) return '結果が空でした。';

    return segments.map(seg => {
      const sp = seg.speaker;
      const idx = this.speakerIndex(sp);
      const cls = idx ? `msg spk-${idx}` : 'msg';
      return `
        <div class="${cls}">
          <div class="avatar">${this.escapeHtml(sp)}</div>
          <div class="bubble">
            <div class="meta">${this.escapeHtml(sp)}</div>
            <div class="text">${this.escapeHtml(seg.text)}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ===== Utilities =====

  clampSpeaker(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 2;
    return Math.max(1, Math.min(20, Math.floor(x)));
  }

  normalizeSpeaker(label) {
    const s = String(label || '').trim();
    const m = s.match(/(\d{1,2})/);
    if (m) return `話者${this.clampSpeaker(parseInt(m[1], 10))}`;
    if (!s) return '話者?';
    if (s.startsWith('話者')) return s;
    return s;
  }

  speakerIndex(label) {
    const m = String(label || '').match(/(\d{1,2})/);
    if (!m) return 0;
    return this.clampSpeaker(parseInt(m[1], 10));
  }

  safeJsonParseMaybe(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (!t) return null;
    try { return JSON.parse(t); } catch {}
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch {}
    }
    return null;
  }

  guessMime(name) {
    const n = (name || '').toLowerCase();
    if (n.endsWith('.mp3')) return 'audio/mpeg';
    if (n.endsWith('.wav')) return 'audio/wav';
    if (n.endsWith('.m4a')) return 'audio/mp4';
    if (n.endsWith('.ogg')) return 'audio/ogg';
    if (n.endsWith('.webm')) return 'audio/webm';
    if (n.endsWith('.flac')) return 'audio/flac';
    if (n.endsWith('.mp4')) return 'video/mp4';
    if (n.endsWith('.mov')) return 'video/quicktime';
    return 'application/octet-stream';
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
  }

  normalizeFetchError(e) {
    // fetch のネットワークエラーは TypeError: Failed to fetch になりがち
    const msg = e?.message || String(e);
    if (msg === 'Failed to fetch') {
      return [
        'Failed to fetch（ネットワーク/CORS/ブロックの可能性）',
        '・企業ネットワーク/拡張機能/セキュリティで generativelanguage.googleapis.com が遮断されていないか',
        '・DevToolsのNetworkで該当リクエストが(OPTIONS含め)失敗していないか',
        '・別タブでGoogleログインが必要な状態になっていないか'
      ].join('\n');
    }
    return msg;
  }
}

// Initialize
let transcriber;
document.addEventListener('DOMContentLoaded', () => {
  transcriber = new GeminiTranscriber();
});
