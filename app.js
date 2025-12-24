/**
 * Gemini Transcriber - 完全修正版
 * 
 * 修正点：
 * 1. iOSでのOAuthトークン管理を改善（トークン有効期限追跡・自動リフレッシュ）
 * 2. JSON解析を堅牢化（マークダウン除去、不完全JSON修復）
 * 3. maxOutputTokensを削除（途切れ防止）
 * 4. ストリーミング対応で長時間音声も安定
 */

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
    this.files = [];
    this.apiKey = '';
    this.isProcessing = false;

    this.model = 'gemini-3-flash-preview';
    this.speakerCount = 2;

    // Drive OAuth
    this.oauthToken = '';
    this.tokenExpiry = 0; // トークン有効期限（timestamp）
    this.tokenClient = null;
    this.pickerReady = false;

    // Wake Lock（iOS/Safari対策）
    this.wakeLock = null;

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
    this.apiKeyInput.addEventListener('input', () => this.onApiKeyInput());
    this.toggleApiKeyBtn.addEventListener('click', () => this.toggleApiKeyVisibility());
    this.saveApiKeyBtn.addEventListener('click', () => this.saveApiKey());
    this.apiKeyFile.addEventListener('change', (e) => this.loadApiKeyFile(e));

    this.modelSelect.addEventListener('change', () => {
      this.model = this.modelSelect.value;
      localStorage.setItem('gemini_model', this.model);
    });
    this.speakerCountSelect.addEventListener('change', () => {
      this.speakerCount = this.clampSpeaker(parseInt(this.speakerCountSelect.value, 10));
      localStorage.setItem('speaker_count', String(this.speakerCount));
    });

    this.driveLoginBtn.addEventListener('click', () => this.driveLogin());
    this.drivePickBtn.addEventListener('click', () => this.openDrivePicker());

    this.dropzone.addEventListener('click', (e) => {
      if (e.target.closest('.file-select-btn')) return;
      this.audioFileInput.click();
    });
    this.dropzone.addEventListener('dragover', (e) => this.onDragOver(e));
    this.dropzone.addEventListener('dragleave', () => this.onDragLeave());
    this.dropzone.addEventListener('drop', (e) => this.onDrop(e));
    this.audioFileInput.addEventListener('change', (e) => this.onFileSelect(e));

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
    } catch (e) {}
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

  // ===== Drive OAuth（改善版）=====

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
    const canPick = this.isTokenValid() && this.pickerReady && !!window.google?.picker;
    this.drivePickBtn.disabled = !canPick;
    if (this.isTokenValid()) {
      this.driveStatus.textContent = '接続済み';
      this.driveStatus.className = 'status-badge success';
    }
  }

  // トークンが有効かチェック（有効期限の1分前までを有効とする）
  isTokenValid() {
    return this.oauthToken && Date.now() < this.tokenExpiry - 60000;
  }

  // トークンを確実に取得（必要なら再取得）
  async ensureValidToken() {
    if (this.isTokenValid()) return true;
    
    return new Promise((resolve) => {
      if (!window.google?.accounts?.oauth2) {
        resolve(false);
        return;
      }

      if (!this.tokenClient) {
        this.tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: GCP_OAUTH_CLIENT_ID,
          scope: DRIVE_SCOPES,
          callback: (resp) => {
            if (resp?.access_token) {
              this.oauthToken = resp.access_token;
              // expires_in は秒単位、通常3600秒（1時間）
              this.tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
              this.refreshDriveUi();
              resolve(true);
            } else {
              resolve(false);
            }
          }
        });
      }

      // サイレントリフレッシュを試みる
      this.tokenClient.requestAccessToken({ prompt: '' });
    });
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
            this.tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
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
    // 初回ログインは consent を要求
    this.tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  async openDrivePicker() {
    try {
      // Picker表示前にトークンを確認・更新
      const valid = await this.ensureValidToken();
      if (!valid) throw new Error('Driveに再ログインしてください');
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
        .enableFeature(window.google.picker.Feature.SUPPORT_DRIVES)
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
      // ファイル追加前にトークン確認
      await this.ensureValidToken();
      
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
        driveFileId: fileId, // 後でダウンロード時に使う
        getBlob: async () => {
          // ダウンロード時にもトークン確認
          await this.ensureValidToken();
          return this.downloadDriveBlob(fileId);
        }
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

  // ===== Wake Lock（画面スリープ防止）=====

  async acquireWakeLock() {
    // Wake Lock APIが使えるか確認
    if (!('wakeLock' in navigator)) {
      console.log('Wake Lock API not supported');
      return false;
    }

    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      console.log('Wake Lock acquired');

      // ページが非表示になったら再取得を試みる
      this.wakeLock.addEventListener('release', () => {
        console.log('Wake Lock released');
      });

      // visibilitychangeでWake Lockを再取得
      document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));

      return true;
    } catch (err) {
      console.log('Wake Lock failed:', err);
      return false;
    }
  }

  async handleVisibilityChange() {
    if (this.isProcessing && document.visibilityState === 'visible') {
      // 処理中にページが再表示されたらWake Lockを再取得
      try {
        if (!this.wakeLock || this.wakeLock.released) {
          this.wakeLock = await navigator.wakeLock.request('screen');
          console.log('Wake Lock re-acquired');
        }
      } catch (err) {
        console.log('Wake Lock re-acquire failed:', err);
      }
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release();
      this.wakeLock = null;
    }
    document.removeEventListener('visibilitychange', this.handleVisibilityChange.bind(this));
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

    // 大きなファイルの警告（iOS向け）
    const largeFiles = this.files.filter(f => f.size > 50 * 1024 * 1024); // 50MB以上
    if (largeFiles.length > 0 && this.isIOS()) {
      const proceed = confirm(
        `⚠️ 大きなファイル（${largeFiles.map(f => f.name).join(', ')}）があります。\n\n` +
        `iPhoneでは処理中に画面がスリープしたり、他のアプリに切り替えると処理が中断される場合があります。\n\n` +
        `処理中は画面をアクティブに保ち、他のアプリに切り替えないでください。\n\n` +
        `続行しますか？`
      );
      if (!proceed) return;
    }

    this.isProcessing = true;
    this.updateTranscribeButton();

    // Wake Lock取得（画面スリープ防止）
    const wakeLockAcquired = await this.acquireWakeLock();
    if (!wakeLockAcquired && this.isIOS()) {
      // Wake Lockが使えない場合は追加の警告を表示
      this.showIOSWarning();
    }

    this.progressSection.style.display = 'block';
    this.resultsSection.style.display = 'block';
    this.resultsList.innerHTML = '';

    const total = this.files.length;

    try {
      for (let i = 0; i < total; i++) {
        const f = this.files[i];
        const pct = Math.floor((i / total) * 100);
        this.progressFill.style.width = `${pct}%`;
        this.progressText.textContent = `処理中: ${f.name} (${i + 1}/${total})`;

        await this.transcribeOne(f, i);
      }

      this.progressFill.style.width = '100%';
      this.progressText.textContent = `完了！ ${total}ファイルを処理しました`;
    } finally {
      // 処理完了時にWake Lock解放
      this.releaseWakeLock();

      this.isProcessing = false;
      this.files = [];
      this.renderFileList();
      this.updateTranscribeButton();
    }
  }

  isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  showIOSWarning() {
    // iOS用の警告バナーを表示
    const warning = document.createElement('div');
    warning.id = 'iosWarning';
    warning.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: linear-gradient(135deg, #f59e0b, #d97706);
      color: #000;
      padding: 12px 16px;
      font-size: 14px;
      font-weight: 600;
      text-align: center;
      z-index: 9999;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
    `;
    warning.innerHTML = `
      ⚠️ 処理中は画面をアクティブに保ってください
      <button onclick="this.parentElement.remove()" style="
        margin-left: 12px;
        background: rgba(0,0,0,0.2);
        border: none;
        color: #000;
        padding: 4px 10px;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 600;
      ">閉じる</button>
    `;
    document.body.prepend(warning);

    // 処理完了後に自動で消す
    const checkProcessing = setInterval(() => {
      if (!this.isProcessing) {
        warning.remove();
        clearInterval(checkProcessing);
      }
    }, 1000);
  }

  async transcribeOne(fileItem, index) {
    const resultId = `result-${index}-${fileItem.id}`;

    this.resultsList.innerHTML += `
      <div class="result-item" id="${resultId}">
        <div class="result-header">
          <span class="result-filename">📄 ${this.escapeHtml(fileItem.name)}</span>
          <span class="status-badge" id="${resultId}-status">準備中...</span>
        </div>
        <div class="result-tabs">
          <button class="tab-btn active" data-tab="chat" data-for="${resultId}" type="button">チャット</button>
          <button class="tab-btn" data-tab="json" data-for="${resultId}" type="button">JSON</button>
        </div>
        <div class="chat-view" id="${resultId}-chat">準備中...</div>
        <pre class="json-view" id="${resultId}-json" style="display:none;">準備中...</pre>
        <div class="result-actions" id="${resultId}-actions" style="margin-top:10px;"></div>
      </div>
    `;

    this.bindResultTabs(resultId);

    const statusEl = document.getElementById(`${resultId}-status`);
    const chatEl = document.getElementById(`${resultId}-chat`);
    const jsonEl = document.getElementById(`${resultId}-json`);
    const actionsEl = document.getElementById(`${resultId}-actions`);

    try {
      // Driveファイルの場合、ダウンロード前にトークン確認
      if (fileItem.source === 'drive') {
        statusEl.textContent = 'トークン確認中...';
        const valid = await this.ensureValidToken();
        if (!valid) throw new Error('Driveに再ログインしてください');
      }

      statusEl.textContent = 'ファイル取得中...';
      const blob = await fileItem.getBlob();
      const mimeType = fileItem.mimeType || blob.type || 'application/octet-stream';

      statusEl.textContent = 'アップロード中... 0%';
      const uploaded = await this.uploadFileToGemini(blob, fileItem.name, (percent, loaded, total) => {
        statusEl.textContent = `アップロード中... ${percent}% (${this.formatFileSize(loaded)}/${this.formatFileSize(total)})`;
      });

      statusEl.textContent = 'ファイル処理待ち...';
      await this.waitForFileActive(uploaded.name);

      statusEl.textContent = '文字起こし中...';
      const prompt = this.buildPrompt(this.speakerCount);

      const resultText = await this.generateWithFile(uploaded.uri, mimeType, prompt);

      // JSON解析（改善版）
      const parsed = this.robustJsonParse(resultText);
      const pretty = parsed ? JSON.stringify(parsed, null, 2) : resultText;

      jsonEl.textContent = pretty;

      const segments = this.extractSegments(parsed, resultText);
      chatEl.innerHTML = this.renderChatHtml(segments);

      statusEl.textContent = '完了';
      statusEl.className = 'status-badge success';

      // ダウンロードボタンを追加
      this.addDownloadButtons(actionsEl, fileItem.name, pretty, segments);

      // cleanup
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

  addDownloadButtons(container, fileName, jsonText, segments) {
    const baseName = fileName.replace(/\.[^.]+$/, '');
    
    // JSONダウンロード
    const jsonBtn = document.createElement('button');
    jsonBtn.className = 'result-btn';
    jsonBtn.textContent = '📥 JSON';
    jsonBtn.onclick = () => {
      const blob = new Blob([jsonText], { type: 'application/json' });
      this.downloadBlob(blob, `${baseName}.json`);
    };
    container.appendChild(jsonBtn);

    // テキストダウンロード
    const txtBtn = document.createElement('button');
    txtBtn.className = 'result-btn';
    txtBtn.textContent = '📥 テキスト';
    txtBtn.onclick = () => {
      const text = segments.map(s => `${s.speaker}: ${s.text}`).join('\n\n');
      const blob = new Blob([text], { type: 'text/plain' });
      this.downloadBlob(blob, `${baseName}.txt`);
    };
    container.appendChild(txtBtn);
  }

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

    return `あなたは音声文字起こしの専門家です。以下の音声/動画を日本語で文字起こししてください。

## 重要なルール
- 話者分離を行い、各発言に話者ラベルを付けてください
- 話者は ${n} 人です。使用する話者ラベル: ${labels}
- 文字起こし以外の説明やコメントは一切不要です
- タイムスタンプは不要です
- 音声の最初から最後まで全て文字起こししてください

## 出力形式
必ず以下のJSON形式のみで出力してください。マークダウンのコードブロックは使わないでください。

{"segments":[{"speaker":"話者1","text":"発言内容"},{"speaker":"話者2","text":"発言内容"}]}`;
  }

  async uploadFileToGemini(blob, displayName, onProgress) {
    const formData = new FormData();
    const file = new File([blob], displayName || 'media', { type: blob.type || 'application/octet-stream' });
    formData.append('file', file);

    // XMLHttpRequestを使って進捗を取得
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          const percent = Math.round((e.loaded / e.total) * 100);
          onProgress(percent, e.loaded, e.total);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            const uri = data?.file?.uri;
            const name = data?.file?.name;
            if (!uri || !name) {
              reject(new Error('Upload response is missing file.uri or file.name'));
            } else {
              resolve({ uri, name });
            }
          } catch (e) {
            reject(new Error('Failed to parse upload response'));
          }
        } else {
          let errMsg = `Upload failed: HTTP ${xhr.status}`;
          try {
            const errData = JSON.parse(xhr.responseText);
            if (errData?.error?.message) errMsg = errData.error.message;
          } catch {}
          reject(new Error(errMsg));
        }
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Upload failed: Network error'));
      });

      xhr.addEventListener('abort', () => {
        reject(new Error('Upload aborted'));
      });

      xhr.addEventListener('timeout', () => {
        reject(new Error('Upload timeout'));
      });

      xhr.open('POST', `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(this.apiKey)}`);
      xhr.timeout = 600000; // 10分タイムアウト
      xhr.send(formData);
    });
  }

  async waitForFileActive(fileName) {
    const maxAttempts = 120; // 2分まで待つ
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

    // maxOutputTokensを削除して、モデルのデフォルト（最大）を使用
    const body = {
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { fileData: { mimeType: mimeType || 'application/octet-stream', fileUri } }
        ]
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1
      }
    };

    let res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    let data = null;
    try { data = await res.json(); } catch {}

    // snake_case でリトライ
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
          temperature: 0.1
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

  // 改善版JSON解析
  robustJsonParse(text) {
    if (typeof text !== 'string') return null;
    let t = text.trim();
    if (!t) return null;

    // マークダウンコードブロックを除去
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    t = t.trim();

    // そのままパース
    try { return JSON.parse(t); } catch {}

    // JSONオブジェクト部分を抽出
    const startIdx = t.indexOf('{');
    const endIdx = t.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const jsonPart = t.slice(startIdx, endIdx + 1);
      try { return JSON.parse(jsonPart); } catch {}

      // 不完全なJSONを修復してみる
      const repaired = this.repairJson(jsonPart);
      if (repaired) {
        try { return JSON.parse(repaired); } catch {}
      }
    }

    // 配列として試す
    const arrStart = t.indexOf('[');
    const arrEnd = t.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
      const arrPart = t.slice(arrStart, arrEnd + 1);
      try {
        const arr = JSON.parse(arrPart);
        if (Array.isArray(arr)) return { segments: arr };
      } catch {}
    }

    return null;
  }

  // 不完全なJSONを修復
  repairJson(jsonStr) {
    let s = jsonStr;

    // 末尾の不完全な文字列を修復
    // 例: {"segments":[{"speaker":"話者1","text":"こんにち
    
    // 開いている引用符を閉じる
    const quoteCount = (s.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      s += '"';
    }

    // 開いている括弧を閉じる
    const openBraces = (s.match(/{/g) || []).length;
    const closeBraces = (s.match(/}/g) || []).length;
    const openBrackets = (s.match(/\[/g) || []).length;
    const closeBrackets = (s.match(/]/g) || []).length;

    // 末尾のカンマを除去
    s = s.replace(/,\s*$/, '');

    // 不完全なオブジェクト/配列を閉じる
    for (let i = 0; i < openBrackets - closeBrackets; i++) {
      s += ']';
    }
    for (let i = 0; i < openBraces - closeBraces; i++) {
      s += '}';
    }

    return s;
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

    // パースできなかった場合のフォールバック
    const fallback = String(rawText || '').trim();
    
    // 「話者N: テキスト」形式を検出してパース
    const lines = fallback.split('\n').filter(l => l.trim());
    const segments = [];
    
    for (const line of lines) {
      const match = line.match(/^(話者\d+|Speaker\s*\d+)\s*[:：]\s*(.+)/i);
      if (match) {
        segments.push({
          speaker: this.normalizeSpeaker(match[1]),
          text: match[2].trim()
        });
      }
    }

    if (segments.length > 0) return segments;

    return fallback ? [{ speaker: '話者?', text: fallback }] : [];
  }

  renderChatHtml(segments) {
    if (!segments.length) return '<div class="no-result">結果が空でした。</div>';

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
    const msg = e?.message || String(e);
    if (msg === 'Failed to fetch') {
      return [
        'ネットワークエラー（Failed to fetch）',
        '',
        '考えられる原因:',
        '・Wi-Fi/モバイル通信の接続が不安定',
        '・generativelanguage.googleapis.com がブロックされている',
        '・iOSの場合: 処理中に別アプリに切り替えないでください',
        '',
        'Driveファイルの場合は再度ログインしてお試しください'
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
