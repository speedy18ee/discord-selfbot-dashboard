// ========================================================
// Custom Audio Studio: Voice Recording & MP3 Audio Player
// ========================================================

class CustomAudioStudio {
  constructor() {
    this.mediaStream = null;
    this.audioContext = null;
    this.processor = null;
    this.source = null;
    this.analyser = null;
    this.pcmChunks = [];
    this.isRecording = false;
    this.recordTimer = null;
    this.recordSeconds = 0;
    this.recordedBlob = null;
    this.recordedUrl = null;

    this.selectedFile = null;
    this.selectedFileBlob = null;
    this.selectedFileUrl = null;

    this.init();
  }

  init() {
    // Tab switching between Record, Upload MP3, and Direct URL
    document.querySelectorAll('.audio-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.currentTarget.dataset.audioTab;
        this.switchTab(tab);
      });
    });

    // Record buttons
    const btnRecordToggle = document.getElementById('btn-rec-toggle');
    if (btnRecordToggle) {
      btnRecordToggle.addEventListener('click', () => this.toggleRecord());
    }

    const btnRecPlay = document.getElementById('btn-rec-play-now');
    if (btnRecPlay) {
      btnRecPlay.addEventListener('click', () => this.submitAudio('record', 'playNow'));
    }

    const btnRecQueue = document.getElementById('btn-rec-queue');
    if (btnRecQueue) {
      btnRecQueue.addEventListener('click', () => this.submitAudio('record', 'queue'));
    }

    const btnRecReset = document.getElementById('btn-rec-reset');
    if (btnRecReset) {
      btnRecReset.addEventListener('click', () => this.resetRecord());
    }

    // Upload MP3 controls
    const fileInput = document.getElementById('mp3-file-input');
    const dropzone = document.getElementById('mp3-dropzone');

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          this.handleFileSelected(e.target.files[0]);
        }
      });
    }

    if (dropzone) {
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('drag-active');
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('drag-active');
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('drag-active');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          this.handleFileSelected(e.dataTransfer.files[0]);
        }
      });
    }

    const btnUploadPlay = document.getElementById('btn-upload-play-now');
    if (btnUploadPlay) {
      btnUploadPlay.addEventListener('click', () => this.submitAudio('upload', 'playNow'));
    }

    const btnUploadQueue = document.getElementById('btn-upload-queue');
    if (btnUploadQueue) {
      btnUploadQueue.addEventListener('click', () => this.submitAudio('upload', 'queue'));
    }

    const btnUploadReset = document.getElementById('btn-upload-reset');
    if (btnUploadReset) {
      btnUploadReset.addEventListener('click', () => this.resetUpload());
    }

    // Direct URL controls
    const btnUrlPlay = document.getElementById('btn-url-play-now');
    if (btnUrlPlay) {
      btnUrlPlay.addEventListener('click', () => this.submitAudio('url', 'playNow'));
    }

    const btnUrlQueue = document.getElementById('btn-url-queue');
    if (btnUrlQueue) {
      btnUrlQueue.addEventListener('click', () => this.submitAudio('url', 'queue'));
    }

    // Load saved MP3 library
    setTimeout(() => this.loadSavedSongs(), 300);
  }

  switchTab(tabName) {
    document.querySelectorAll('.audio-tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.audioTab === tabName);
    });
    document.querySelectorAll('.audio-tab-content').forEach(c => {
      c.style.display = c.dataset.tabContent === tabName ? 'block' : 'none';
    });
  }

  // --- Voice Recording Logic ---
  async toggleRecord() {
    if (this.isRecording) {
      await this.stopRecord();
    } else {
      await this.startRecord();
    }
  }

  async startRecord() {
    try {
      this.pcmChunks = [];
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx({ sampleRate: 44100 });
      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;

      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = (e) => {
        if (!this.isRecording) return;
        const channelData = e.inputBuffer.getChannelData(0);
        this.pcmChunks.push(new Float32Array(channelData));
      };

      this.source.connect(this.analyser);
      this.analyser.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.isRecording = true;
      this.recordSeconds = 0;
      this.updateRecordTimer();
      this.recordTimer = setInterval(() => {
        this.recordSeconds++;
        this.updateRecordTimer();
      }, 1000);

      this.drawVU();

      // UI changes
      const btn = document.getElementById('btn-rec-toggle');
      if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop Recording';
        btn.classList.add('recording-pulse');
      }
      const badge = document.getElementById('rec-status-badge');
      if (badge) {
        badge.className = 'badge badge-danger';
        badge.textContent = 'RECORDING';
      }

      const actions = document.getElementById('rec-action-row');
      if (actions) actions.style.display = 'none';

      const preview = document.getElementById('rec-preview-container');
      if (preview) preview.style.display = 'none';

      if (window.showToast) showToast('Microphone recording started. Speak now!', 'info');
    } catch (err) {
      console.error('Microphone access failed:', err);
      if (window.showToast) showToast('Failed to access microphone: ' + err.message, 'error');
    }
  }

  async stopRecord() {
    if (!this.isRecording) return;
    this.isRecording = false;

    if (this.recordTimer) {
      clearInterval(this.recordTimer);
      this.recordTimer = null;
    }

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { await this.audioContext.close(); } catch (e) {}
    }

    // Reset VU bar
    const vu = document.getElementById('rec-vu-bar');
    if (vu) vu.style.width = '0%';

    // Combine PCM chunks into standard 16-bit Stereo WAV
    const totalSamples = this.pcmChunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of this.pcmChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    this.recordedBlob = this.encodeStereoWAV(merged, 44100);
    this.recordedUrl = URL.createObjectURL(this.recordedBlob);

    // UI Updates
    const btn = document.getElementById('btn-rec-toggle');
    if (btn) {
      btn.innerHTML = '<i class="fa-solid fa-microphone"></i> Re-Record Voice';
      btn.classList.remove('recording-pulse');
    }

    const badge = document.getElementById('rec-status-badge');
    if (badge) {
      badge.className = 'badge badge-success';
      badge.textContent = 'READY TO PLAY';
    }

    const preview = document.getElementById('rec-preview-container');
    const audioElem = document.getElementById('rec-audio-elem');
    if (preview && audioElem) {
      audioElem.src = this.recordedUrl;
      preview.style.display = 'block';
    }

    const actions = document.getElementById('rec-action-row');
    if (actions) actions.style.display = 'flex';

    const titleInput = document.getElementById('rec-custom-title');
    if (titleInput && !titleInput.value) {
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      titleInput.value = `Voice Recording (${timeStr})`;
    }

    if (window.showToast) showToast(`Voice recorded successfully (${this.formatTime(this.recordSeconds)})!`, 'success');
  }

  resetRecord() {
    if (this.isRecording) {
      this.stopRecord();
    }
    this.pcmChunks = [];
    this.recordedBlob = null;
    this.recordedUrl = null;
    this.recordSeconds = 0;

    const preview = document.getElementById('rec-preview-container');
    const audioElem = document.getElementById('rec-audio-elem');
    if (preview && audioElem) {
      audioElem.src = '';
      preview.style.display = 'none';
    }

    const actions = document.getElementById('rec-action-row');
    if (actions) actions.style.display = 'none';

    const btn = document.getElementById('btn-rec-toggle');
    if (btn) {
      btn.innerHTML = '<i class="fa-solid fa-microphone"></i> Start Recording Voice';
      btn.classList.remove('recording-pulse');
    }

    const badge = document.getElementById('rec-status-badge');
    if (badge) {
      badge.className = 'badge badge-warning';
      badge.textContent = 'STANDBY';
    }

    const timer = document.getElementById('rec-timer');
    if (timer) timer.textContent = '00:00';

    const titleInput = document.getElementById('rec-custom-title');
    if (titleInput) titleInput.value = '';
  }

  updateRecordTimer() {
    const timer = document.getElementById('rec-timer');
    if (timer) timer.textContent = this.formatTime(this.recordSeconds);
  }

  formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  drawVU() {
    if (!this.isRecording || !this.analyser) return;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const avg = sum / data.length;
    const pct = Math.min(100, Math.round((avg / 128) * 100));

    const vu = document.getElementById('rec-vu-bar');
    if (vu) vu.style.width = `${pct}%`;

    requestAnimationFrame(() => this.drawVU());
  }

  encodeStereoWAV(samples, sampleRate = 44100) {
    const numSamples = samples.length;
    const buffer = new ArrayBuffer(44 + numSamples * 4);
    const view = new DataView(buffer);

    function writeString(v, offset, string) {
      for (let i = 0; i < string.length; i++) {
        v.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 4, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, 2, true); // 2 channels (stereo)
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true); // byte rate (sampleRate * 4)
    view.setUint16(32, 4, true); // block align (2 channels * 2 bytes)
    view.setUint16(34, 16, true); // bits per sample
    writeString(view, 36, 'data');
    view.setUint32(40, numSamples * 4, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(offset, val, true);     // Left
      view.setInt16(offset + 2, val, true); // Right
      offset += 4;
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  // --- MP3 / Audio File Handling ---
  handleFileSelected(file) {
    if (!file) return;
    this.selectedFile = file;
    this.selectedFileBlob = file;
    if (this.selectedFileUrl) {
      URL.revokeObjectURL(this.selectedFileUrl);
    }
    this.selectedFileUrl = URL.createObjectURL(file);

    // Update UI
    const nameElem = document.getElementById('upload-file-name');
    if (nameElem) nameElem.textContent = file.name;

    const sizeElem = document.getElementById('upload-file-size');
    if (sizeElem) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
      sizeElem.textContent = `${sizeMB} MB`;
    }

    const preview = document.getElementById('upload-preview-container');
    const audioElem = document.getElementById('upload-audio-elem');
    if (preview && audioElem) {
      audioElem.src = this.selectedFileUrl;
      preview.style.display = 'block';
    }

    const titleInput = document.getElementById('upload-custom-title');
    if (titleInput && !titleInput.value) {
      const cleanName = file.name.replace(/\.[^/.]+$/, '');
      titleInput.value = cleanName;
    }

    const actions = document.getElementById('upload-action-row');
    if (actions) actions.style.display = 'flex';

    if (window.showToast) showToast(`File loaded: ${file.name}`, 'info');
  }

  resetUpload() {
    this.selectedFile = null;
    this.selectedFileBlob = null;
    if (this.selectedFileUrl) {
      URL.revokeObjectURL(this.selectedFileUrl);
      this.selectedFileUrl = null;
    }

    const fileInput = document.getElementById('mp3-file-input');
    if (fileInput) fileInput.value = '';

    const preview = document.getElementById('upload-preview-container');
    const audioElem = document.getElementById('upload-audio-elem');
    if (preview && audioElem) {
      audioElem.src = '';
      preview.style.display = 'none';
    }

    const actions = document.getElementById('upload-action-row');
    if (actions) actions.style.display = 'none';

    const titleInput = document.getElementById('upload-custom-title');
    if (titleInput) titleInput.value = '';
  }

  // --- Audio Submission Handler (Play or Queue) ---
  async submitAudio(sourceType, playMode = 'playNow') {
    // 1. Resolve target bot and voice channel
    const botSelect = document.getElementById('music-bot-select');
    const guildSelect = document.getElementById('music-guild-select');
    const voiceSelect = document.getElementById('music-voice-select');

    const accountId = botSelect?.value || window.state?.selectedMusicBotId || null;
    const guildId = guildSelect?.value || null;
    const channelId = voiceSelect?.value || null;

    let payload = {
      mode: playMode,
      accountId: 'ALL_BOTS',
      allBots: true,
      guildId,
      channelId,
      loop: !!document.getElementById('custom-audio-loop-checkbox')?.checked
    };

    let buttonTarget = null;
    if (sourceType === 'record') {
      if (!this.recordedBlob) {
        if (window.showToast) showToast('Please record audio before submitting!', 'warning');
        return;
      }
      buttonTarget = playMode === 'playNow' ? document.getElementById('btn-rec-play-now') : document.getElementById('btn-rec-queue');
      const titleInput = document.getElementById('rec-custom-title');
      payload.title = titleInput?.value || 'Recorded Voice Note';
      payload.filename = 'recorded_voice.wav';
      payload.audioBase64 = await this.blobToBase64(this.recordedBlob);
    } else if (sourceType === 'upload') {
      if (!this.selectedFileBlob) {
        if (window.showToast) showToast('Please choose an MP3 or audio file first!', 'warning');
        return;
      }
      buttonTarget = playMode === 'playNow' ? document.getElementById('btn-upload-play-now') : document.getElementById('btn-upload-queue');
      const titleInput = document.getElementById('upload-custom-title');
      payload.title = titleInput?.value || this.selectedFile?.name || 'Uploaded Audio';
      payload.filename = this.selectedFile?.name || 'audio.mp3';
      payload.audioBase64 = await this.blobToBase64(this.selectedFileBlob);
    } else if (sourceType === 'url') {
      const urlInput = document.getElementById('direct-audio-url');
      const titleInput = document.getElementById('url-custom-title');
      if (!urlInput || !urlInput.value.trim()) {
        if (window.showToast) showToast('Please enter an audio URL!', 'warning');
        return;
      }
      buttonTarget = playMode === 'playNow' ? document.getElementById('btn-url-play-now') : document.getElementById('btn-url-queue');
      payload.audioUrl = urlInput.value.trim();
      payload.title = titleInput?.value || 'Audio Stream';
    }

    // Set loading indicator
    const origHTML = buttonTarget ? buttonTarget.innerHTML : '';
    if (buttonTarget) {
      buttonTarget.disabled = true;
      buttonTarget.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
    }

    if (window.showToast) {
      showToast(playMode === 'playNow' ? '🚀 Uploading and playing to Discord bot...' : '➕ Adding custom audio to queue...', 'info');
    }

    try {
      const token = localStorage.getItem('exc_user_token') || localStorage.getItem('token') || '';
      const res = await fetch('/api/music/custom-audio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to play audio');
      }

      if (window.showToast) {
        if (data.massPlay) {
          showToast(`🔥 Playing "${data.track.info.title}" on ALL ${data.botCount || ''} bots!`, 'success');
        } else if (playMode === 'playNow') {
          showToast(`🎵 Now Playing: "${data.track.info.title}"!`, 'success');
        } else {
          showToast(`✅ Added "${data.track.info.title}" to the queue!`, 'success');
        }
      }

      // Refresh Saved Songs Library
      this.loadSavedSongs();

      // Switch to Music Tab so user sees player immediately
      if (typeof window.switchTab === 'function') {
        window.switchTab('music');
      }

    } catch (err) {
      console.error('Audio play error:', err);
      if (window.showToast) showToast(err.message, 'error');
    } finally {
      if (buttonTarget) {
        buttonTarget.disabled = false;
        buttonTarget.innerHTML = origHTML;
      }
    }
  }

  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result.split(',')[1];
        resolve(base64String);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  async loadSavedSongs() {
    const listElem = document.getElementById('saved-mp3-list');
    if (!listElem) return;

    try {
      const token = localStorage.getItem('exc_user_token') || localStorage.getItem('token') || '';
      const res = await fetch('/api/music/uploads', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!data.success || !data.songs || data.songs.length === 0) {
        listElem.innerHTML = '<div style="color: #71717a; font-size: 0.85rem; text-align: center; padding: 16px; background: #0c0c10; border-radius: 8px;">No saved MP3 songs yet. Upload any MP3 song above to automatically save and keep it here!</div>';
        return;
      }

      listElem.innerHTML = data.songs.map(song => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: #0c0c10; border: 1px solid #1c1c24; border-radius: 8px; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1;">
            <i class="fa-solid fa-file-audio" style="color: #a855f7; font-size: 1.1rem; flex-shrink: 0;"></i>
            <div style="min-width: 0;">
              <div style="color: #ffffff; font-weight: 600; font-size: 0.88rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${song.title}</div>
              <div style="color: #71717a; font-size: 0.75rem;">${song.sizeFormatted || ''} • ${new Date(song.uploadedAt).toLocaleDateString()}</div>
            </div>
          </div>
          <div style="display: flex; gap: 6px; flex-shrink: 0;">
            <button class="btn btn-primary btn-sm" onclick="window.customAudioStudio.playSavedSong('${song.id}', false)" title="Play Now on All Bots" style="padding: 6px 12px; font-size: 0.8rem;">
              <i class="fa-solid fa-play"></i> Play
            </button>
            <button class="btn btn-outline btn-sm" onclick="window.customAudioStudio.playSavedSong('${song.id}', true)" title="Play in Continuous Loop" style="padding: 6px 12px; font-size: 0.8rem; border-color: #a855f7; color: #c084fc;">
              <i class="fa-solid fa-repeat"></i> Loop
            </button>
            <button class="btn btn-outline btn-danger-outline btn-sm" onclick="window.customAudioStudio.deleteSavedSong('${song.id}')" title="Delete Song" style="padding: 6px 10px; font-size: 0.8rem;">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      listElem.innerHTML = `<div style="color: #ef4444; font-size: 0.8rem; text-align: center; padding: 12px;">Failed to load saved songs: ${err.message}</div>`;
    }
  }

  async playSavedSong(songId, loop = false) {
    if (window.showToast) {
      showToast(loop ? '🔂 Streaming saved MP3 to all bots in CONTINUOUS LOOP mode...' : '🚀 Streaming saved MP3 to all bots at 1000% volume...', 'info');
    }
    try {
      const token = localStorage.getItem('exc_user_token') || localStorage.getItem('token') || '';
      const res = await fetch(`/api/music/uploads/${songId}/play`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ mode: 'playNow', loop })
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to play song');
      if (window.showToast) {
        showToast(loop ? `🔂 Playing "${data.track.info.title}" in CONTINUOUS LOOP on ALL bots!` : `🔥 Playing "${data.track.info.title}" on ALL bots with 1000% volume!`, 'success');
      }
      if (typeof window.switchTab === 'function') window.switchTab('music');
    } catch (err) {
      if (window.showToast) showToast(`Playback error: ${err.message}`, 'error');
    }
  }

  async deleteSavedSong(songId) {
    if (!confirm('Are you sure you want to delete this saved MP3 song?')) return;
    try {
      const token = localStorage.getItem('exc_user_token') || localStorage.getItem('token') || '';
      const res = await fetch(`/api/music/uploads/${songId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete song');
      if (window.showToast) showToast('Song removed from saved library.', 'success');
      this.loadSavedSongs();
    } catch (err) {
      if (window.showToast) showToast(`Delete error: ${err.message}`, 'error');
    }
  }
}

// Global instance
document.addEventListener('DOMContentLoaded', () => {
  window.customAudioStudio = new CustomAudioStudio();
});
