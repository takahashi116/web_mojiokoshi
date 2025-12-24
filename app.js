class ChatTranscriber {
  constructor() {
    // ===== DOM =====
    this.apiKeyInput = document.getElementById('apiKeyInput');
    this.toggleApiKeyBtn = document.getElementById('toggleApiKey');
    this.saveApiKeyBtn = document.getElementById('saveApiKey');
    this.apiKeyFile = document.getElementById('apiKeyFile');
    this.apiKeyStatus = document.getElementById('apiKeyStatus');

    this.speakerCountInput = document.getElementById('speakerCount'); // select
    this.modelSelect = document.getElementById('modelSelect');

    this.tabDrive = document.getElementById('tabDrive');
    this.tabLocal = document.getElementById('tabLocal');
    this.drivePanel = document.getElementById('drivePanel');
    this.localPanel = document.getElementById('localPanel');

    this.driveConnectBtn = document.getElementById('driveConnectBtn');
    this.drivePickBtn = document.getElementById('drivePickBtn');
    this.drivePickFolderBtn = document.getElementById('drivePickFolderBtn');
    this.driveClearFolderBtn = document.getElementById('driveClearFolderBtn');
    this.driveFolderLabel = document.getElementById('driveFolderLabel');
    this.driveStatus = document.getElementById('driveStatus');

    this.dropzone = document.getElementById('dropzone');
    this.audioFileInput = document.getElementById('audioFileInput');
    this.fileList = document.getElementById('fileList');

    this.transcribeBtn = document.getElementById('transcribeBtn');
    this.progressSection = document.getElementById('progressSection');
    this.progressFill = document.getElementById('progressFill');
    this.progressText = document.getElementById('progressText');

    this.resultsSection = document.getElementById('resultsSection');
    this.chatThread = document.getElementById('chatThread');
    this.rawJsonPre = document.getElementById('rawJsonPre');
    this.copyJsonBtn = document.getElementById('copyJsonBtn');
    this.downloadJsonBtn = document.getElementById('downloadJsonBtn');

    // ===== State =====
    this.apiKey = '';
    this.speakerCount = 2;
    this.model = this.modelSelect.value;

    this.source = 'drive';
    this.selected = null;  // { name, mimeType, size, getBytes: async()=>Uint8Array }
    this.isProcessing = false;

    // Drive auth/token
    this.oauthToken = '';
    this.tokenClient = null;

    // Drive folder pinning
    this.pinnedFolderId = '';
    this.pinnedFolderName = '';

    // Picker callback mode
    this.pickerMode = 'file'; // 'file' | 'folder'

    // ===== Constants (User provided) =====
    this.GOOGLE_CLIENT_ID = '478200222114-ronuhiecjrc0lp9t1b6nnqod7cji46o3.apps.googleusercontent.com';
    this.GOOGLE_API_KEY = 'AIzaSyB6YPsmEy62ltuh1aqZX6Z5Hjx0P9mt0Lw';
    this.DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

    // ===== Gemini file strategy =====
    this.INLINE_MAX_BYTES = 18 * 1024 * 1024;
    this.FORCE_FILES_API = false;

    this.init();
  }

  init() {
    const savedKey = localStorage.getItem('gemini_api_key');
    if (savedKey) {
      this.apiKey = savedKey;
      this.apiKeyInput.value = savedKey;
      this.updateApiKeyStatus(true);
    }

    const savedCount = localStorage.getItem('speaker_count');
    if (savedCount) {
      const n = Number(savedCount);
      if (Number.isFinite(n)) this.speakerCountInput.value = String(n);
    }

    const savedModel = localStorage.getItem('gemini_model');
    if (savedModel) this.modelSelect.value = savedModel;

    const savedFolderId = localStorage.getItem('drive_pinned_folder_id') || '';
    const savedFolderName = localStorage.getItem('drive_pinned_folder_name') || '';
    if (savedFolderId) {
      this.pinnedFolderId = savedFolderId;
      this.pinnedFolderName = savedFolderName;
    }

    // Events
    this.apiKeyInput.addEventListener('input', () => this.onApiKeyInput());
    this.toggleApiKeyBtn.addEventListener('click', () => this.toggleApiKeyVisibility());
    this.saveApiKeyBtn.addEventListener('click', () => this.saveApiKey());
    this.apiKeyFile.addEventListener('change', (e) => this.loadApiKeyFile(e));

    // iPhone対策：selectは change が自然
    this.speakerCountInput.addEventListener('change', () => this.onSpeakerCountChanged());
    this.modelSelect.addEventListener('change', () => this.onModelChanged());

    this.tabDrive.addEventListener('click', () => this.setSource('drive'));
    this.tabLocal.addEventListener('click', () => this.setSource('local'));

    if (this.dropzone) {
      this.dropzone.addEventListener('click', () => this.audioFileInput.click());
      this.dropzone.addEventListener('dragover', (e) => this.onDragOver(e));
      this.dropzone.addEventListener('dragleave', () => this.onDragLeave());
      this.dropzone.addEventListener('drop', (e) => this.onDrop(e));
    }
    this.audioFileInput.addEventListener('change', (e) => this.onFileSelect(e));

    this.driveConnectBtn.addEventListener('click', () => this.connectDrive());
    this.drivePickFolderBtn.addEventListener('click', () => this.openDriveFolderPicker());
    this.drivePickBtn.addEventListener('click', () => this.openDriveFilePicker());
    this.driveClearFolderBtn.addEventListener('click', () => this.clearPinnedFolder());

    this.transcribeBtn.addEventListener('click', () => this.startTranscription());

    this.copyJsonBtn.addEventListener('click', () => this.copyJson());
    this.downloadJsonBtn.addEventListener('click', () => this.downloadJson());

    this.loadPicker();
    this.onSpeakerCountChanged();
    this.onModelChanged();
    this.setSource('drive');

    this.renderPinnedFolder();
    this.updateTranscribeButton();
  }

  // ===== Settings =====
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
    localStorage.setItem('gemini_api_key', this.apiKey);
    this.updateApiKeyStatus(true, '✓ 保存しました');
    this.saveApiKeyBtn.classList.add('saved');
    this.saveApiKeyBtn.textContent = '✓ 保存済';
    setTimeout(() => {
      this.saveApiKeyBtn.classList.remove('saved');
      this.saveApiKeyBtn.innerHTML = '💾 保存';
    }, 1500);
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
      console.error(err);
      this.updateApiKeyStatus(false, '読み込み失敗');
    }
  }

  updateApiKeyStatus(success, message = '') {
    if (success) {
      this.apiKeyStatus.textContent = message || '✓ 設定済み';
      this.apiKeyStatus.className = 'status-badge success';
    } else if (message) {
      this.apiKeyStatus.textContent = message;
      this.apiKeyStatus.className = 'status-badge error';
    } else {
      this.apiKeyStatus.textContent = '';
      this.apiKeyStatus.className = 'status-badge';
    }
  }

  onSpeakerCountChanged() {
    const n = Number(this.speakerCountInput.value);
    this.speakerCount = Math.max(1, Math.min(10, Number.isFinite(n) ? n : 2));
    this.speakerCountInput.value = String(this.speakerCount);
    localStorage.setItem('speaker_count', String(this.speakerCount));
    this.updateTranscribeButton();
  }

  onModelChanged() {
    this.model = this.modelSelect.value;
    localStorage.setItem('gemini_model', this.model);
    this.updateTranscribeButton();
  }

  // ===== Source switching =====
  setSource(source) {
    this.source = source;
    if (source === 'drive') {
      this.tabDrive.classList.add('active');
      this.tabLocal.classList.remove('active');
      this.drivePanel.style.display = '';
      this.localPanel.style.display = 'none';
    } else {
      this.tabLocal.classList.add('active');
      this.tabDrive.classList.remove('active');
      this.localPanel.style.display = '';
      this.drivePanel.style.display = 'none';
    }
    this.selected = null;
    this.renderFileList();
    this.updateTranscribeButton();
  }

  // ===== Local upload =====
  onDragOver(e) { e.preventDefault(); this.dropzone.classList.add('dragover'); }
  onDragLeave() { this.dropzone.classList.remove('dragover'); }

  onDrop(e) {
    e.preventDefault();
    this.dropzone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) this.selectLocalFile(files[0]);
  }

  onFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    this.selectLocalFile(file);
    e.target.value = '';
  }

  selectLocalFile(file) {
    if (!this.isAudioFileName(file.name) && !file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
      alert('音声/動画ファイルを選択してください');
      return;
    }
    this.selected = {
      name: file.name,
      mimeType: file.type || this.guessMimeTypeFromName(file.name),
      size: file.size,
      getBytes: async () => new Uint8Array(await file.arrayBuffer()),
    };
    this.renderFileList();
    this.updateTranscribeButton();
  }

  isAudioFileName(name) {
    return /\.(mp3|wav|m4a|webm|ogg|mp4|flac)$/i.test(name);
  }

  guessMimeTypeFromName(name) {
    const lower = (name || '').toLowerCase();
    if (lower.endsWith('.mp3')) return 'audio/mpeg';
    if (lower.endsWith('.wav')) return 'audio/wav';
    if (lower.endsWith('.m4a')) return 'audio/mp4';
    if (lower.endsWith('.flac')) return 'audio/flac';
    if (lower.endsWith('.ogg')) return 'audio/ogg';
    if (lower.endsWith('.webm')) return 'audio/webm';
    if (lower.endsWith('.mp4')) return 'video/mp4';
    return 'application/octet-stream';
  }

  // ===== Google Drive Picker =====
  loadPicker() {
    if (!window.gapi) return;
    window.gapi.load('picker');
  }

  connectDrive() {
    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      alert('Google Identity Services の読み込みを待ってから再試行してください');
      return;
    }

    this.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: this.GOOGLE_CLIENT_ID,
      scope: this.DRIVE_SCOPE,
      callback: (resp) => {
        if (resp && resp.access_token) {
          this.oauthToken = resp.access_token;
          this.updateDriveStatus(true, '✓ 接続済み');
          this.drivePickBtn.disabled = false;
          this.drivePickFolderBtn.disabled = false;
          this.updateTranscribeButton();
        } else {
          this.updateDriveStatus(false, '認可失敗');
        }
      },
    });

    this.updateDriveStatus(true, '認可中...');
    this.tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  updateDriveStatus(success, message = '') {
    if (success) {
      this.driveStatus.textContent = message || '✓';
      this.driveStatus.className = 'status-badge success';
    } else {
      this.driveStatus.textContent = message || '×';
      this.driveStatus.className = 'status-badge error';
    }
  }

  clearPinnedFolder() {
    this.pinnedFolderId = '';
    this.pinnedFolderName = '';
    localStorage.removeItem('drive_pinned_folder_id');
    localStorage.removeItem('drive_pinned_folder_name');
    this.renderPinnedFolder();
  }

  renderPinnedFolder() {
    if (!this.driveFolderLabel) return;
    if (this.pinnedFolderId) {
      const name = this.pinnedFolderName || this.pinnedFolderId;
      this.driveFolderLabel.textContent = name;
    } else {
      this.driveFolderLabel.textContent = '（未選択：マイドライブ全体）';
    }
  }

  openDriveFolderPicker() {
    if (!this.oauthToken) {
      alert('先に Google に接続してください');
      return;
    }
    if (!window.google || !window.google.picker) {
      alert('Picker の読み込みを待ってから再試行してください');
      return;
    }

    this.pickerMode = 'folder';

    // フォルダのみを表示・選択可能にする
    const folderView = new window.google.picker.DocsView()
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes('application/vnd.google-apps.folder');

    const picker = new window.google.picker.PickerBuilder()
      .addView(folderView)
      .setOAuthToken(this.oauthToken)
      .setDeveloperKey(this.GOOGLE_API_KEY)
      .setCallback((data) => this.onPicked(data))
      .build();

    picker.setVisible(true);
  }

  openDriveFilePicker() {
    if (!this.oauthToken) {
      alert('先に Google に接続してください');
      return;
    }
    if (!window.google || !window.google.picker) {
      alert('Picker の読み込みを待ってから再試行してください');
      return;
    }

    this.pickerMode = 'file';

    // 音声/動画に寄せる（全部のaudio/*を完全には指定できないので主要MIMEを列挙）
    const mediaMimeTypes = [
      'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg', 'audio/webm',
      'video/mp4', 'video/quicktime', 'video/webm'
    ].join(',');

    const fileView = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
      .setIncludeFolders(false)
      .setSelectFolderEnabled(false)
      .setMimeTypes(mediaMimeTypes);

    // フォルダ固定があれば、その配下を初期表示（重要：setParent） :contentReference[oaicite:3]{index=3}
    if (this.pinnedFolderId) {
      fileView.setParent(this.pinnedFolderId);
    }

    // 追加：最近使った を出す（タブが増えるので好み次第）
    // WARNING: Google docs上 “deprecated” 表記があるため、環境によっては非推奨。必要なら削除。:contentReference[oaicite:4]{index=4}
    const recentView = new window.google.picker.View(window.google.picker.ViewId.RECENTLY_PICKED);

    const picker = new window.google.picker.PickerBuilder()
      .addView(fileView)
      .addView(recentView)
      .setOAuthToken(this.oauthToken)
      .setDeveloperKey(this.GOOGLE_API_KEY)
      .setCallback((data) => this.onPicked(data))
      .build();

    picker.setVisible(true);
  }

  async onPicked(data) {
    const action = data.action;
    if (action !== window.google.picker.Action.PICKED) return;

    const doc = data.docs?.[0];
    if (!doc) return;

    if (this.pickerMode === 'folder') {
      // フォルダ固定
      this.pinnedFolderId = doc.id;
      this.pinnedFolderName = doc.name || doc.id;

      localStorage.setItem('drive_pinned_folder_id', this.pinnedFolderId);
      localStorage.setItem('drive_pinned_folder_name', this.pinnedFolderName);

      this.renderPinnedFolder();
      return;
    }

    // file pick
    const fileId = doc.id;
    const name = doc.name || 'drive_file';
    const mimeType = doc.mimeType || this.guessMimeTypeFromName(name);
    const size = Number(doc.sizeBytes || 0);

    const looksAudio = mimeType.startsWith('audio/') || mimeType.startsWith('video/') || this.isAudioFileName(name);
    if (!looksAudio) {
      alert('音声/動画ファイルを選択してください（Drive上のファイル種別を確認してください）');
      return;
    }

    this.selected = {
      name,
      mimeType: mimeType === 'application/octet-stream' ? this.guessMimeTypeFromName(name) : mimeType,
      size,
      getBytes: async () => await this.downloadDriveFileBytes(fileId),
    };

    this.renderFileList();
    this.updateTranscribeButton();
  }

  async downloadDriveFileBytes(fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.oauthToken}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Drive download failed: ${res.status} ${text}`);
    }
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (!bytes.length) throw new Error('Drive file is empty (0 bytes)');
    return bytes;
  }

  // ===== UI: file list =====
  clearSelected() {
    this.selected = null;
    this.renderFileList();
    this.updateTranscribeButton();
  }

  renderFileList() {
    if (!this.selected) {
      this.fileList.innerHTML = '';
      return;
    }
    const f = this.selected;
    this.fileList.innerHTML = `
      <div class="file-item">
        <div class="file-item-info">
          <span class="file-item-icon">🎵</span>
          <div style="overflow:hidden">
            <div class="file-item-name">${this.escapeHtml(f.name)}</div>
            <div class="file-item-meta">${this.formatFileSize(f.size)} • ${this.escapeHtml(f.mimeType)}</div>
          </div>
        </div>
        <button class="file-item-remove" title="削除" onclick="transcriber.clearSelected()">✕</button>
      </div>
    `;
  }

  formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  updateTranscribeButton() {
    const hasKey = !!this.apiKey;
    const hasFile = !!this.selected;
    const driveReady = (this.source !== 'drive') || !!this.oauthToken;
    this.transcribeBtn.disabled = !hasKey || !hasFile || !driveReady || this.isProcessing;
  }

  // ===== Transcription =====
  async startTranscription() {
    if (this.isProcessing || !this.selected) return;

    this.isProcessing = true;
    this.updateTranscribeButton();

    this.progressSection.style.display = 'block';
    this.resultsSection.style.display = 'block';
    this.progressFill.style.width = '0%';
    this.progressText.textContent = 'ファイル取得中...';

    this.chatThread.innerHTML = '';
    this.rawJsonPre.textContent = '';
    this.copyJsonBtn.disabled = true;
    this.downloadJsonBtn.disabled = true;

    try {
      const bytes = await this.selected.getBytes();
      const numBytes = bytes.byteLength || bytes.length || 0;
      if (!numBytes) throw new Error('ファイルが空です（0 bytes）');

      this.progressFill.style.width = '20%';

      const useFilesApi = this.FORCE_FILES_API || (numBytes > this.INLINE_MAX_BYTES);
      const prompt = this.buildPrompt(this.speakerCount);

      let jsonText;

      if (useFilesApi) {
        this.progressText.textContent = 'Gemini Files API にアップロード中...';
        const uploaded = await this.uploadToGeminiFilesApiResumable({
          bytes,
          mimeType: this.selected.mimeType,
          displayName: this.selected.name,
        });

        this.progressFill.style.width = '55%';
        this.progressText.textContent = 'Gemini 文字起こし中（file_uri参照）...';

        jsonText = await this.callGeminiWithFileUri(prompt, uploaded.uri, uploaded.mimeType);
      } else {
        this.progressText.textContent = 'Gemini へ送信準備中（inline）...';
        const base64 = this.uint8ToBase64(bytes);
        if (!base64) throw new Error('inlineData が空です（base64 empty）');

        this.progressFill.style.width = '45%';
        this.progressText.textContent = 'Gemini 文字起こし中（inline）...';

        jsonText = await this.callGeminiInline(prompt, this.selected.mimeType, base64);
      }

      this.progressFill.style.width = '85%';
      this.progressText.textContent = '表示用に整形中...';

      const resultObj = this.safeParseJson(jsonText);
      if (!resultObj) {
        this.rawJsonPre.textContent = jsonText;
        throw new Error('Gemini の出力がJSONとして解析できませんでした（Raw JSON を確認）');
      }

      this.rawJsonPre.textContent = JSON.stringify(resultObj, null, 2);
      this.renderChat(resultObj);

      this.copyJsonBtn.disabled = false;
      this.downloadJsonBtn.disabled = false;

      this.progressFill.style.width = '100%';
      this.progressText.textContent = '完了';
    } catch (err) {
      console.error(err);
      this.progressFill.style.width = '100%';
      this.progressText.textContent = 'エラー';
      this.chatThread.innerHTML = `<div class="result-error">❌ エラー: ${this.escapeHtml(err.message || String(err))}</div>`;
    } finally {
      this.isProcessing = false;
      this.updateTranscribeButton();
    }
  }

  buildPrompt(speakerCount) {
    return [
      'あなたは「文字起こし専用」のアシスタントです。',
      '次の音声の内容を日本語で文字起こししてください。',
      '長くても最後まで諦めずに生成してください。',
      '',
      '【厳守】',
      `- 話者分離をして、話者ラベルを「話者1」〜「話者${speakerCount}」で付与してください（話者は${speakerCount}人です）。`,
      '- タイムスタンプは禁止です。',
      '- 文字起こし以外の説明、コメント、注釈、要約は禁止です。',
      '- 出力は必ずJSONのみ（前後の文章、コードフェンス```、マークダウンは禁止）',
      '',
      '【出力JSON仕様】',
      '{',
      `  "meta": { "language": "ja", "speakerCount": ${speakerCount} },`,
      '  "speakers": [',
      '    { "id": "S1", "label": "話者1" },',
      '    { "id": "S2", "label": "話者2" }',
      '  ],',
      '  "messages": [',
      '    { "seq": 1, "speakerId": "S1", "text": "発話テキスト" }',
      '  ]',
      '}',
      '',
      '【注意】',
      `- speakers は必ず S1〜S${speakerCount} を全て列挙してください。`,
      '- messages は会話順に seq を 1 から連番にしてください。',
      '- text は改行を含んで構いませんが、1メッセージは1話者の発話単位にしてください。',
    ].join('\n');
  }

  async callGeminiInline(prompt, mimeType, base64Data) {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Data } }
        ]
      }]
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => null);
      const msg = err?.error?.message || `API Error: ${res.status}`;
      throw new Error(msg);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini から結果が返りませんでした');
    return text;
  }

  async uploadToGeminiFilesApiResumable({ bytes, mimeType, displayName }) {
    const numBytes = bytes.byteLength || bytes.length || 0;
    if (!numBytes) throw new Error('アップロード対象が空です（0 bytes）');

    const startUrl = 'https://generativelanguage.googleapis.com/upload/v1beta/files';

    const startRes = await fetch(startUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(numBytes),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file: { display_name: displayName || 'audio' },
      }),
    });

    if (!startRes.ok) {
      const t = await startRes.text().catch(() => '');
      throw new Error(`Files API start failed: ${startRes.status} ${t}`);
    }

    const uploadUrl =
      startRes.headers.get('X-Goog-Upload-URL') ||
      startRes.headers.get('x-goog-upload-url');

    if (!uploadUrl) {
      throw new Error('Files API: upload URL を取得できませんでした（X-Goog-Upload-URL が空）');
    }

    const blob = new Blob([bytes], { type: mimeType });

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(numBytes),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: blob,
    });

    if (!uploadRes.ok) {
      const t = await uploadRes.text().catch(() => '');
      throw new Error(`Files API upload failed: ${uploadRes.status} ${t}`);
    }

    const info = await uploadRes.json().catch(() => null);
    const file = info?.file;
    if (!file?.uri || !file?.name) {
      throw new Error('Files API upload: file.uri / file.name を取得できませんでした');
    }

    if (file.state && String(file.state).toUpperCase() === 'PROCESSING') {
      this.progressText.textContent = 'アップロード後の処理待ち（PROCESSING）...';
      const activeFile = await this.waitForGeminiFileActive(file.name);
      return { uri: activeFile.uri, name: activeFile.name, mimeType: activeFile.mime_type || mimeType };
    }

    return { uri: file.uri, name: file.name, mimeType: file.mime_type || mimeType };
  }

  async waitForGeminiFileActive(fileName) {
    const deadline = Date.now() + 120000;
    const url = `https://generativelanguage.googleapis.com/v1beta/files/${encodeURIComponent(fileName)}`;

    while (Date.now() < deadline) {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'x-goog-api-key': this.apiKey },
      });
      if (!res.ok) break;

      const data = await res.json().catch(() => null);
      const file = data?.file;
      const state = String(file?.state || '').toUpperCase();

      if (state === 'ACTIVE' && file?.uri) return file;

      await this.sleep(2000);
    }

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-goog-api-key': this.apiKey },
    }).catch(() => null);

    const data = res ? await res.json().catch(() => null) : null;
    const file = data?.file;
    if (file?.uri) return file;

    throw new Error('Files API: ファイルが ACTIVE になりませんでした（タイムアウト）');
  }

  async callGeminiWithFileUri(prompt, fileUri, mimeType) {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { file_data: { mime_type: mimeType, file_uri: fileUri } },
        ]
      }]
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => null);
      const msg = err?.error?.message || `API Error: ${res.status}`;
      throw new Error(msg);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini から結果が返りませんでした');
    return text;
  }

  safeParseJson(text) {
    if (!text) return null;
    let s = String(text).trim();
    s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    const firstBrace = s.indexOf('{');
    const lastBrace = s.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      s = s.slice(firstBrace, lastBrace + 1);
    }

    try { return JSON.parse(s); } catch { return null; }
  }

  renderChat(result) {
    const speakers = new Map();
    (result.speakers || []).forEach(sp => speakers.set(sp.id, sp.label || sp.id));

    const msgs = Array.isArray(result.messages) ? result.messages : [];
    if (!msgs.length) {
      this.chatThread.innerHTML = '<div class="result-error">（messages が空です）</div>';
      return;
    }

    const selfId = 'S1';
    this.chatThread.innerHTML = msgs.map(m => {
      const speakerId = m.speakerId || 'S?';
      const label = speakers.get(speakerId) || speakerId;
      const text = (m.text ?? '').toString();

      const rowClass = (speakerId === selfId) ? 'msg-row self' : 'msg-row';
      const avatar = this.escapeHtml(label.replace('話者', 'S'));
      const safeLabel = this.escapeHtml(label);
      const safeText = this.escapeHtml(text);

      return `
        <div class="${rowClass}">
          <div class="avatar">${avatar}</div>
          <div class="bubble-wrap">
            <div class="speaker-label">${safeLabel}</div>
            <div class="bubble">${safeText}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  }

  uint8ToBase64(bytes) {
    const CHUNK_SIZE = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, i + CHUNK_SIZE);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  copyJson() {
    const text = this.rawJsonPre.textContent || '';
    if (!text) return;
    navigator.clipboard.writeText(text)
      .then(() => alert('JSONをコピーしました'))
      .catch(() => alert('コピーに失敗しました'));
  }

  downloadJson() {
    const text = this.rawJsonPre.textContent || '';
    if (!text) return;
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'transcription.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

let transcriber;
document.addEventListener('DOMContentLoaded', () => {
  transcriber = new ChatTranscriber();
});
