// EXC Hardware ID (HWID) Fingerprint Generator
// Uniquely binds a device to 1 set of credentials

async function getDeviceHwid() {
  // 1. Persistent Unique Device ID (kept in localStorage)
  let localUuid = localStorage.getItem('exc_hwid_device_token');
  if (!localUuid) {
    try {
      if (window.crypto && window.crypto.getRandomValues) {
        localUuid = 'dev_' + ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
          (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
        );
      } else {
        localUuid = 'dev_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
      }
      localStorage.setItem('exc_hwid_device_token', localUuid);
    } catch (e) {
      localUuid = 'dev_' + Math.random().toString(36).substring(2);
    }
  }

  // 2. Canvas Fingerprint
  let canvasHash = '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 60;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('EXC-HWID-2026', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('EXC-HWID-2026', 4, 17);
      canvasHash = canvas.toDataURL();
    }
  } catch (e) {}

  // 3. WebGL GPU / Renderer Fingerprint
  let webglInfo = '';
  try {
    const glCanvas = document.createElement('canvas');
    const gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        webglInfo = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) + '|' + gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
      }
    }
  } catch (e) {}

  // 4. Hardware and Environment Parameters
  const screenSpec = `${window.screen?.width}x${window.screen?.height}x${window.screen?.colorDepth}@${window.devicePixelRatio || 1}`;
  const cpuCores = navigator.hardwareConcurrency || 4;
  const platform = navigator.platform || navigator.userAgentData?.platform || 'Unknown';
  const language = navigator.language || 'en';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  // 5. Combine and Hash into HWID String
  const rawString = [
    localUuid,
    platform,
    screenSpec,
    cpuCores,
    language,
    timeZone,
    webglInfo,
    canvasHash.substring(0, 80)
  ].join(':::');

  let hexHash = '';
  try {
    if (window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function') {
      const encoder = new TextEncoder();
      const data = encoder.encode(rawString);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      hexHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) {}

  if (!hexHash || hexHash.length < 32) {
    // Pure JS fallback hash for insecure HTTP contexts
    let h1 = 0x811c9dc5, h2 = 0x537f;
    for (let i = 0; i < rawString.length; i++) {
      const c = rawString.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2, 33) ^ c;
    }
    const part1 = (h1 >>> 0).toString(16).padStart(8, '0');
    const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
    const part3 = (Math.imul(h1, 31) >>> 0).toString(16).padStart(8, '0');
    const part4 = (Math.imul(h2, 37) >>> 0).toString(16).padStart(8, '0');
    hexHash = (part1 + part2 + part3 + part4).repeat(2);
  }

  return `HWID-${hexHash.substring(0, 32).toUpperCase()}`;
}

function getDeviceInfo() {
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  let browser = 'Desktop Browser';
  if (/Edg/i.test(navigator.userAgent)) browser = 'Edge';
  else if (/Chrome/i.test(navigator.userAgent)) browser = 'Chrome';
  else if (/Safari/i.test(navigator.userAgent)) browser = 'Safari';
  else if (/Firefox/i.test(navigator.userAgent)) browser = 'Firefox';

  return {
    platform: isMobile ? 'Mobile (' + (navigator.platform || 'Phone') + ')' : 'PC / Desktop (' + (navigator.platform || 'OS') + ')',
    browser,
    screen: `${window.screen?.width}x${window.screen?.height}`,
    isMobile
  };
}

window.getDeviceHwid = getDeviceHwid;
window.getDeviceInfo = getDeviceInfo;