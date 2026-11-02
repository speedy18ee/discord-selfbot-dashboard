// ========================================================
// EXC WebCam Studio: Live Camera & Discord Video Controller
// ========================================================

class CameraStudio {
  constructor() {
    this.mediaStream = null;
    this.isCameraOpen = false;
    this.isBroadcastingToBots = false;
    this.facingMode = 'user'; // 'user' or 'environment'
    this.currentFilter = 'none';
    this.audioContext = null;
    this.analyser = null;
    this.vuInterval = null;

    this.init();
  }

  init() {
    // Master broadcast button
    const btnBroadcast = document.getElementById('btn-camera-broadcast-all');
    if (btnBroadcast) {
      btnBroadcast.addEventListener('click', () => this.toggleBroadcastAll());
    }

    // Camera open/close toggle
    const btnToggleCam = document.getElementById('btn-camera-toggle-webcam');
    if (btnToggleCam) {
      btnToggleCam.addEventListener('click', () => this.toggleWebcam());
    }

    // Flip camera
    const btnFlip = document.getElementById('btn-camera-flip');
    if (btnFlip) {
      btnFlip.addEventListener('click', () => this.flipCamera());
    }

    // Filter buttons
    document.querySelectorAll('.cam-filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const filter = e.currentTarget.dataset.filter || 'none';
        this.setFilter(filter);
      });
    });

    // Refresh bot list on camera deck
    const btnRefresh = document.getElementById('btn-camera-refresh-bots');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => this.renderCameraBotCards());
    }
  }

  async toggleWebcam() {
    if (this.isCameraOpen) {
      this.stopWebcam();
    } else {
      await this.startWebcam();
    }
  }

  async startWebcam() {
    const videoElem = document.getElementById('webcam-video');
    const placeholder = document.getElementById('webcam-placeholder');
    const btnToggle = document.getElementById('btn-camera-toggle-webcam');
    const statusBadge = document.getElementById('webcam-status-badge');

    try {
      if (window.showToast) showToast('Requesting camera permissions...', 'info');

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: this.facingMode
        },
        audio: true
      });

      if (videoElem) {
        videoElem.srcObject = this.mediaStream;
        videoElem.play().catch(() => {});
        videoElem.style.display = 'block';
      }
      if (placeholder) placeholder.style.display = 'none';

      this.isCameraOpen = true;

      if (btnToggle) {
        btnToggle.innerHTML = '<i class="fa-solid fa-video-slash"></i> Turn Off WebCam';
        btnToggle.className = 'btn btn-outline btn-danger-outline';
      }
      if (statusBadge) {
        statusBadge.className = 'badge badge-success';
        statusBadge.innerHTML = '<i class="fa-solid fa-circle" style="color: #22c55e; font-size: 0.6rem;"></i> LIVE WEBCAM';
      }

      // Start VU meter for audio
      this.startAudioVU();

      if (window.showToast) showToast('WebCam is now active!', 'success');
      this.updateResolutionBadge();
    } catch (err) {
      console.error('Camera open error:', err);
      if (window.showToast) showToast(`Failed to open camera: ${err.message}`, 'error');
    }
  }

  stopWebcam() {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    this.stopAudioVU();

    const videoElem = document.getElementById('webcam-video');
    const placeholder = document.getElementById('webcam-placeholder');
    const btnToggle = document.getElementById('btn-camera-toggle-webcam');
    const statusBadge = document.getElementById('webcam-status-badge');

    if (videoElem) {
      videoElem.srcObject = null;
      videoElem.style.display = 'none';
    }
    if (placeholder) placeholder.style.display = 'flex';

    this.isCameraOpen = false;

    if (btnToggle) {
      btnToggle.innerHTML = '<i class="fa-solid fa-video"></i> Start WebCam';
      btnToggle.className = 'btn btn-primary';
    }
    if (statusBadge) {
      statusBadge.className = 'badge badge-warning';
      statusBadge.innerHTML = '<i class="fa-solid fa-circle" style="color: #eab308; font-size: 0.6rem;"></i> STANDBY';
    }

    if (window.showToast) showToast('WebCam turned off.', 'info');
  }

  async flipCamera() {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    if (this.isCameraOpen) {
      this.stopWebcam();
      await this.startWebcam();
    }
    if (window.showToast) showToast(`Flipped to ${this.facingMode === 'user' ? 'Front' : 'Back'} Camera`, 'info');
  }

  setFilter(filterName) {
    this.currentFilter = filterName;
    const videoElem = document.getElementById('webcam-video');
    if (!videoElem) return;

    document.querySelectorAll('.cam-filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === filterName);
    });

    const filters = {
      none: 'none',
      cyberpunk: 'hue-rotate(270deg) saturate(1.8) contrast(1.2)',
      matrix: 'hue-rotate(90deg) saturate(2.5) contrast(1.3) brightness(0.9)',
      glow: 'brightness(1.15) contrast(1.1) saturate(1.3)',
      noir: 'grayscale(1) contrast(1.4) brightness(0.95)',
      vintage: 'sepia(0.6) contrast(1.1) brightness(1.05)'
    };

    videoElem.style.filter = filters[filterName] || 'none';
  }

  updateResolutionBadge() {
    const videoElem = document.getElementById('webcam-video');
    const resBadge = document.getElementById('webcam-res-badge');
    if (!videoElem || !resBadge) return;

    setTimeout(() => {
      if (videoElem.videoWidth && videoElem.videoHeight) {
        resBadge.textContent = `${videoElem.videoWidth}x${videoElem.videoHeight} (720p)`;
      }
    }, 1000);
  }

  startAudioVU() {
    if (!this.mediaStream) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 128;
      source.connect(this.analyser);

      const data = new Uint8Array(this.analyser.frequencyBinCount);
      const vuBar = document.getElementById('webcam-vu-bar');

      const draw = () => {
        if (!this.isCameraOpen || !this.analyser) return;
        this.analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;
        const pct = Math.min(100, Math.round((avg / 128) * 100));
        if (vuBar) vuBar.style.width = `${pct}%`;
        requestAnimationFrame(draw);
      };
      draw();
    } catch (e) {}
  }

  stopAudioVU() {
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { this.audioContext.close(); } catch (e) {}
    }
    const vuBar = document.getElementById('webcam-vu-bar');
    if (vuBar) vuBar.style.width = '0%';
  }

  // --- Discord Bots Video Broadcasting ---
  async toggleBroadcastAll() {
    const btn = document.getElementById('btn-camera-broadcast-all');
    const targetState = !this.isBroadcastingToBots;

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating Bots...';
    }

    try {
      const token = localStorage.getItem('exc_user_token') || localStorage.getItem('token') || '';
      const res = await fetch('/api/accounts/camera/all', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ enabled: targetState })
      });

      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to toggle camera on bots');

      this.isBroadcastingToBots = targetState;

      if (window.showToast) {
        showToast(targetState
          ? `📹 Discord Video / Camera turned ON across ${data.count} bots in voice channels!`
          : `📹 Discord Camera turned OFF across bots.`, 'success');
      }

      this.updateBroadcastUI();
      this.renderCameraBotCards();

      // If user turned on broadcast and webcam isn't open yet, auto-start webcam
      if (targetState && !this.isCameraOpen) {
        await this.startWebcam();
      }
    } catch (err) {
      if (window.showToast) showToast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
      this.updateBroadcastUI();
    }
  }

  async toggleBotCamera(accountId, targetState) {
    try {
      const token = localStorage.getItem('exc_user_token') || localStorage.getItem('token') || '';
      const res = await fetch(`/api/accounts/${accountId}/camera`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ enabled: targetState })
      });

      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to toggle bot camera');

      if (window.showToast) {
        showToast(`Bot camera turned ${targetState ? 'ON' : 'OFF'}!`, 'success');
      }
      this.renderCameraBotCards();
    } catch (err) {
      if (window.showToast) showToast(`Camera error: ${err.message}`, 'error');
    }
  }

  updateBroadcastUI() {
    const btn = document.getElementById('btn-camera-broadcast-all');
    const badge = document.getElementById('badge-camera-live');

    if (btn) {
      if (this.isBroadcastingToBots) {
        btn.innerHTML = '<i class="fa-solid fa-video-slash"></i> Stop Broadcasting to Discord';
        btn.className = 'btn btn-outline btn-danger-outline recording-pulse';
      } else {
        btn.innerHTML = '<i class="fa-solid fa-satellite-dish"></i> Broadcast Camera to All Bots (Discord Video)';
        btn.className = 'btn btn-primary';
      }
    }

    if (badge) {
      badge.style.display = this.isBroadcastingToBots ? 'inline-block' : 'none';
    }
  }

  renderCameraBotCards() {
    const container = document.getElementById('camera-bots-grid');
    if (!container || !window.state?.accounts) return;

    const onlineBots = window.state.accounts.filter(a => a.status === 'online');

    if (onlineBots.length === 0) {
      container.innerHTML = '<div style="color:#71717a; text-align:center; padding:16px; font-size:0.85rem;">No online bots found. Connect bots to voice to enable camera streaming.</div>';
      return;
    }

    container.innerHTML = onlineBots.map(bot => {
      const inVoice = !!bot.currentVoice?.channelId;
      const camActive = !!bot.currentVoice?.selfVideo;
      const avatarUrl = bot.user?.avatar || 'assets/logo.jpg';

      return `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; background: #0c0c10; border: 1px solid ${camActive ? 'rgba(34, 197, 94, 0.5)' : '#1c1c24'}; border-radius: 10px; gap: 10px; box-shadow: ${camActive ? '0 0 12px rgba(34, 197, 94, 0.2)' : 'none'};">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
            <img src="${avatarUrl}" alt="Avatar" style="width: 36px; height: 36px; border-radius: 50%; border: 2px solid ${camActive ? '#22c55e' : '#3f3f46'}; flex-shrink: 0;">
            <div style="min-width: 0;">
              <div style="font-weight: 700; color: #ffffff; font-size: 0.88rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${bot.label || bot.user?.username || bot.id}
                ${camActive ? '<span class="badge badge-success" style="font-size:0.65rem; margin-left:6px;"><i class="fa-solid fa-video"></i> CAM ON</span>' : ''}
              </div>
              <div style="font-size: 0.75rem; color: #a1a1aa;">
                ${inVoice ? `<i class="fa-solid fa-microphone-lines" style="color: #22c55e;"></i> In: ${bot.currentVoice.channelName || 'Voice'}` : '<i class="fa-solid fa-circle-exclamation" style="color: #eab308;"></i> Not in Voice'}
              </div>
            </div>
          </div>
          <div>
            <button class="btn btn-sm ${camActive ? 'btn-outline btn-danger-outline' : 'btn-primary'}" 
                    style="padding: 6px 12px; font-size: 0.78rem;" 
                    type="button" 
                    ${!inVoice ? 'disabled' : ''} 
                    onclick="window.cameraStudio.toggleBotCamera('${bot.id}', ${!camActive})">
              <i class="fa-solid ${camActive ? 'fa-video-slash' : 'fa-video'}"></i> ${camActive ? 'Turn Off' : 'Turn Cam On'}
            </button>
          </div>
        </div>
      `;
    }).join('');
  }
}

// Global instance
document.addEventListener('DOMContentLoaded', () => {
  window.cameraStudio = new CameraStudio();
});
