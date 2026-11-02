/**
 * EXC 3D Canvas Model & Aesthetic Background GIF Engine
 * High-performance mathematical 3D perspective projection + interactive background layer
 */

(function () {
  'use strict';

  // Default configuration
  const DEFAULT_CONFIG = {
    bgMode: 'hybrid', // 'hybrid' | 'gif' | '3d' | 'dark'
    gifPreset: 'cyberpunk', // 'cyberpunk' | 'nebula' | 'matrix' | 'lofi' | 'custom'
    customGifUrl: '',
    gifOpacity: 0.35,
    gifBlur: 2,
    modelType: 'icosahedron', // 'icosahedron' | 'tesseract' | 'constellation' | 'gyroscope' | 'off'
    modelColor: '#a855f7', // Hex color
    rotationSpeed: 1.0,
    wireframeGlow: true,
    audioReactive: true,
    particleDensity: 40
  };

  // Aesthetic GIF Presets (High-speed reliable CDNs)
  const GIF_PRESETS = {
    cyberpunk: {
      name: 'Cyberpunk Neon City',
      url: 'https://media.giphy.com/media/26tn33aiTi1jkl6H6/giphy.gif',
      desc: 'Futuristic purple-blue rain & neon skyscrapers'
    },
    nebula: {
      name: 'Deep Cosmos Nebula',
      url: 'https://media.giphy.com/media/3o7bu3XilJ5BOiSGic/giphy.gif',
      desc: 'Floating cosmic vortex & stellar dust clouds'
    },
    matrix: {
      name: 'Synthwave Matrix Grid',
      url: 'https://media.giphy.com/media/3oKIPnAiaMCws8nOsE/giphy.gif',
      desc: 'Glowing wireframe horizon & retro cyber grid'
    },
    lofi: {
      name: 'Lo-Fi Rain & Violet Glow',
      url: 'https://media.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif',
      desc: 'Chill ambient neon reflections & soothing drops'
    }
  };

  class Canvas3DEngine {
    constructor() {
      this.config = this.loadConfig();
      this.canvas = null;
      this.ctx = null;
      this.bgLayer = null;
      this.animId = null;

      // Mouse & Physics state
      this.mouseX = 0;
      this.mouseY = 0;
      this.targetRotX = 0;
      this.targetRotY = 0;
      this.rotX = 0.3;
      this.rotY = 0.5;
      this.rotZ = 0;
      this.rot4D = 0;
      this.pulseScale = 1.0;
      this.targetPulseScale = 1.0;

      // Particle constellation state
      this.particles = [];
      this.initParticles();

      // Bind methods
      this.loop = this.loop.bind(this);
      this.onResize = this.onResize.bind(this);
      this.onMouseMove = this.onMouseMove.bind(this);
      this.onTouchMove = this.onTouchMove.bind(this);
    }

    loadConfig() {
      try {
        const saved = localStorage.getItem('exc_theme_config');
        if (saved) {
          return { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
        }
      } catch (e) {
        console.warn('[3D Engine] Failed to parse config:', e);
      }
      return { ...DEFAULT_CONFIG };
    }

    saveConfig() {
      try {
        localStorage.setItem('exc_theme_config', JSON.stringify(this.config));
      } catch (e) {}
    }

    init() {
      this.canvas = document.getElementById('bg-canvas-3d');
      this.bgLayer = document.getElementById('bg-gif-layer');

      if (!this.canvas) {
        console.warn('[3D Engine] Canvas #bg-canvas-3d element not found.');
        return;
      }

      this.ctx = this.canvas.getContext('2d');
      this.onResize();

      window.addEventListener('resize', this.onResize, { passive: true });
      window.addEventListener('mousemove', this.onMouseMove, { passive: true });
      window.addEventListener('touchmove', this.onTouchMove, { passive: true });

      // Apply initial styling & start loop
      this.applyTheme();
      this.start();
    }

    onResize() {
      if (!this.canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.canvas.width = this.width * dpr;
      this.canvas.height = this.height * dpr;
      this.canvas.style.width = this.width + 'px';
      this.canvas.style.height = this.height + 'px';
      this.ctx.scale(dpr, dpr);
    }

    onMouseMove(e) {
      const nx = (e.clientX / this.width) * 2 - 1;
      const ny = (e.clientY / this.height) * 2 - 1;
      this.targetRotY = nx * 0.9;
      this.targetRotX = -ny * 0.9;
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    }

    onTouchMove(e) {
      if (e.touches.length > 0) {
        const t = e.touches[0];
        const nx = (t.clientX / this.width) * 2 - 1;
        const ny = (t.clientY / this.height) * 2 - 1;
        this.targetRotY = nx * 0.9;
        this.targetRotX = -ny * 0.9;
      }
    }

    initParticles() {
      const count = this.config.particleDensity || 40;
      this.particles = [];
      for (let i = 0; i < count; i++) {
        this.particles.push({
          x: (Math.random() - 0.5) * 600,
          y: (Math.random() - 0.5) * 600,
          z: (Math.random() - 0.5) * 600,
          vx: (Math.random() - 0.5) * 0.8,
          vy: (Math.random() - 0.5) * 0.8,
          vz: (Math.random() - 0.5) * 0.8,
          size: Math.random() * 2.2 + 1.2
        });
      }
    }

    applyTheme() {
      const { bgMode, gifPreset, customGifUrl, gifOpacity, gifBlur, modelColor } = this.config;

      // 1. Configure Background GIF Layer
      if (this.bgLayer) {
        if (bgMode === 'gif' || bgMode === 'hybrid') {
          let url = '';
          if (gifPreset === 'custom' && customGifUrl) {
            url = customGifUrl;
          } else if (GIF_PRESETS[gifPreset]) {
            url = GIF_PRESETS[gifPreset].url;
          } else {
            url = GIF_PRESETS.cyberpunk.url;
          }
          this.bgLayer.style.backgroundImage = `url("${url}")`;
          this.bgLayer.style.opacity = gifOpacity;
          this.bgLayer.style.filter = `blur(${gifBlur}px)`;
          this.bgLayer.style.display = 'block';
        } else {
          this.bgLayer.style.display = 'none';
        }
      }

      // 2. Configure 3D Canvas Layer
      if (this.canvas) {
        if (bgMode === '3d' || bgMode === 'hybrid') {
          this.canvas.style.display = 'block';
        } else {
          this.canvas.style.display = 'none';
        }
      }

      // 3. Update CSS Variable for dynamic accent glow
      document.documentElement.style.setProperty('--theme-accent-3d', modelColor);
    }

    start() {
      if (this.animId) cancelAnimationFrame(this.animId);
      this.animId = requestAnimationFrame(this.loop);
    }

    stop() {
      if (this.animId) {
        cancelAnimationFrame(this.animId);
        this.animId = null;
      }
    }

    triggerAudioPulse(strength = 1.25) {
      this.targetPulseScale = strength;
    }

    loop() {
      this.animId = requestAnimationFrame(this.loop);

      if (this.config.bgMode === 'dark' || this.config.bgMode === 'gif' || this.config.modelType === 'off') {
        if (this.ctx) this.ctx.clearRect(0, 0, this.width, this.height);
        return;
      }

      const speed = this.config.rotationSpeed || 1.0;
      this.rotX += (this.targetRotX - this.rotX) * 0.05 + 0.003 * speed;
      this.rotY += (this.targetRotY - this.rotY) * 0.05 + 0.006 * speed;
      this.rotZ += 0.002 * speed;
      this.rot4D += 0.008 * speed;

      // Pulse interpolation
      this.pulseScale += (this.targetPulseScale - this.pulseScale) * 0.1;
      this.targetPulseScale += (1.0 - this.targetPulseScale) * 0.05;

      this.ctx.clearRect(0, 0, this.width, this.height);

      const cx = this.width / 2;
      const cy = this.height / 2;
      const color = this.config.modelColor || '#a855f7';

      switch (this.config.modelType) {
        case 'tesseract':
          this.renderTesseract(cx, cy, color);
          break;
        case 'constellation':
          this.renderConstellation(cx, cy, color);
          break;
        case 'gyroscope':
          this.renderGyroscope(cx, cy, color);
          break;
        case 'icosahedron':
        default:
          this.renderIcosahedron(cx, cy, color);
          break;
      }
    }

    // --- 3D Projection Helpers ---
    project(p, focal = 500, cx, cy) {
      // Perspective projection: f / (f + z)
      const f = focal / (focal + p.z);
      return {
        x: p.x * f + cx,
        y: p.y * f + cy,
        scale: f,
        z: p.z
      };
    }

    rotatePoint(p, rx, ry, rz) {
      let { x, y, z } = p;

      // Rotate around X
      const cosX = Math.cos(rx);
      const sinX = Math.sin(rx);
      const y1 = y * cosX - z * sinX;
      const z1 = y * sinX + z * cosX;

      // Rotate around Y
      const cosY = Math.cos(ry);
      const sinY = Math.sin(ry);
      const x2 = x * cosY + z1 * sinY;
      const z2 = -x * sinY + z1 * cosY;

      // Rotate around Z
      const cosZ = Math.cos(rz);
      const sinZ = Math.sin(rz);
      const x3 = x2 * cosZ - y1 * sinZ;
      const y3 = x2 * sinZ + y1 * cosZ;

      return { x: x3, y: y3, z: z2 };
    }

    // --- MODEL 1: CYBER ICOSAHEDRON (20-Faced Geodesic Crystal) ---
    renderIcosahedron(cx, cy, color) {
      const phi = (1 + Math.sqrt(5)) / 2;
      const baseRadius = 160 * this.pulseScale;

      const rawVertices = [
        { x: -1, y:  phi, z: 0 }, { x:  1, y:  phi, z: 0 },
        { x: -1, y: -phi, z: 0 }, { x:  1, y: -phi, z: 0 },
        { x: 0, y: -1, z:  phi }, { x: 0, y:  1, z:  phi },
        { x: 0, y: -1, z: -phi }, { x: 0, y:  1, z: -phi },
        { x:  phi, y: 0, z: -1 }, { x:  phi, y: 0, z:  1 },
        { x: -phi, y: 0, z: -1 }, { x: -phi, y: 0, z:  1 }
      ];

      // Normalize and scale
      const vertices = rawVertices.map(v => {
        const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        return {
          x: (v.x / len) * baseRadius,
          y: (v.y / len) * baseRadius,
          z: (v.z / len) * baseRadius
        };
      });

      // Transform & project outer vertices
      const proj = vertices.map(v => {
        const rot = this.rotatePoint(v, this.rotX, this.rotY, this.rotZ);
        return this.project(rot, 600, cx, cy);
      });

      // 30 standard edges for icosahedron
      const edges = [
        [0, 11], [0, 5], [0, 1], [0, 7], [0, 10],
        [1, 5], [1, 7], [1, 8], [1, 9],
        [2, 11], [2, 10], [2, 4], [2, 6], [2, 3],
        [3, 4], [3, 6], [3, 8], [3, 9],
        [4, 5], [4, 9], [4, 11],
        [5, 9], [5, 11],
        [6, 7], [6, 8], [6, 10],
        [7, 8], [7, 10],
        [8, 9],
        [10, 11]
      ];

      const ctx = this.ctx;

      // Draw wireframe edges with glowing depth gradient
      ctx.save();
      ctx.lineWidth = 1.4;
      for (const [i, j] of edges) {
        const p1 = proj[i];
        const p2 = proj[j];
        const avgZ = (p1.z + p2.z) / 2;
        const alpha = Math.max(0.12, Math.min(0.85, 0.45 + avgZ / 350));

        ctx.strokeStyle = this.hexToRgba(color, alpha);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }

      // Draw glowing vertex nodes
      for (const p of proj) {
        const alpha = Math.max(0.2, Math.min(1.0, 0.5 + p.z / 300));
        ctx.fillStyle = this.hexToRgba(color, alpha);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(2, 3.5 * p.scale), 0, Math.PI * 2);
        ctx.fill();

        if (this.config.wireframeGlow) {
          ctx.strokeStyle = this.hexToRgba('#ffffff', alpha * 0.7);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // Inner Counter-Rotating Core (Octahedron crystal)
      const coreRadius = 75 * this.pulseScale;
      const coreRaw = [
        { x:  coreRadius, y: 0, z: 0 }, { x: -coreRadius, y: 0, z: 0 },
        { x: 0, y:  coreRadius, z: 0 }, { x: 0, y: -coreRadius, z: 0 },
        { x: 0, y: 0, z:  coreRadius }, { x: 0, y: 0, z: -coreRadius }
      ];

      const coreProj = coreRaw.map(v => {
        const rot = this.rotatePoint(v, -this.rotX * 1.5, -this.rotY * 1.5, this.rotZ * 1.2);
        return this.project(rot, 600, cx, cy);
      });

      const coreEdges = [
        [0, 2], [0, 3], [0, 4], [0, 5],
        [1, 2], [1, 3], [1, 4], [1, 5],
        [2, 4], [2, 5], [3, 4], [3, 5]
      ];

      ctx.lineWidth = 1.0;
      for (const [i, j] of coreEdges) {
        const p1 = coreProj[i];
        const p2 = coreProj[j];
        ctx.strokeStyle = this.hexToRgba('#38bdf8', 0.55);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }

      ctx.restore();
    }

    // --- MODEL 2: QUANTUM TESSERACT (4D Hypercube) ---
    renderTesseract(cx, cy, color) {
      const ctx = this.ctx;
      const scale4D = 140 * this.pulseScale;
      const angle = this.rot4D;

      // 16 4D Vertices: (x, y, z, w) in {-1, 1}^4
      const points4D = [];
      for (let i = 0; i < 16; i++) {
        points4D.push({
          x: (i & 1 ? 1 : -1),
          y: (i & 2 ? 1 : -1),
          z: (i & 4 ? 1 : -1),
          w: (i & 8 ? 1 : -1)
        });
      }

      // Rotate in 4D (X-W plane and Y-Z plane) and project to 3D
      const points3D = points4D.map(p => {
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);

        // 4D Rotation in X-W
        const xRot = p.x * cosA - p.w * sinA;
        const wRot = p.x * sinA + p.w * cosA;

        // 4D perspective to 3D: distance d = 2.4
        const d = 2.4;
        const wFactor = 1 / (d - wRot * 0.5);

        return {
          x: xRot * wFactor * scale4D,
          y: p.y * wFactor * scale4D,
          z: p.z * wFactor * scale4D
        };
      });

      // Project 3D points to 2D
      const proj = points3D.map(v => {
        const rot = this.rotatePoint(v, this.rotX, this.rotY, this.rotZ);
        return this.project(rot, 600, cx, cy);
      });

      // 32 edges of the tesseract (edges connect vertices differing by 1 bit)
      ctx.save();
      ctx.lineWidth = 1.3;
      for (let i = 0; i < 16; i++) {
        for (let bit = 1; bit <= 8; bit <<= 1) {
          if ((i & bit) === 0) {
            const j = i | bit;
            const p1 = proj[i];
            const p2 = proj[j];
            const avgZ = (p1.z + p2.z) / 2;
            const alpha = Math.max(0.12, Math.min(0.85, 0.45 + avgZ / 300));

            ctx.strokeStyle = (bit === 8)
              ? this.hexToRgba('#38bdf8', alpha * 0.9)
              : this.hexToRgba(color, alpha);

            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          }
        }
      }

      // Draw vertex nodes
      for (const p of proj) {
        const alpha = Math.max(0.2, Math.min(1.0, 0.5 + p.z / 250));
        ctx.fillStyle = this.hexToRgba(color, alpha);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(2, 3.2 * p.scale), 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }

    // --- MODEL 3: NEURAL CONSTELLATION GRID ---
    renderConstellation(cx, cy, color) {
      const ctx = this.ctx;
      const count = this.particles.length;

      // Update particle positions
      for (let i = 0; i < count; i++) {
        const pt = this.particles[i];
        pt.x += pt.vx;
        pt.y += pt.vy;
        pt.z += pt.vz;

        // Bounce back into bounding box
        if (Math.abs(pt.x) > 300) pt.vx *= -1;
        if (Math.abs(pt.y) > 300) pt.vy *= -1;
        if (Math.abs(pt.z) > 300) pt.vz *= -1;
      }

      // Project particles to 2D
      const proj = this.particles.map(pt => {
        const rot = this.rotatePoint(pt, this.rotX * 0.5, this.rotY * 0.5, this.rotZ * 0.3);
        return this.project(rot, 600, cx, cy);
      });

      ctx.save();

      // Draw connecting filaments between close points
      const maxDist = 135 * this.pulseScale;
      ctx.lineWidth = 1.0;
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          const dx = this.particles[i].x - this.particles[j].x;
          const dy = this.particles[i].y - this.particles[j].y;
          const dz = this.particles[i].z - this.particles[j].z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

          if (dist < maxDist) {
            const alpha = (1 - dist / maxDist) * 0.55;
            ctx.strokeStyle = this.hexToRgba(color, alpha);
            ctx.beginPath();
            ctx.moveTo(proj[i].x, proj[i].y);
            ctx.lineTo(proj[j].x, proj[j].y);
            ctx.stroke();
          }
        }
      }

      // Draw nodes
      for (let i = 0; i < count; i++) {
        const p = proj[i];
        const alpha = Math.max(0.2, Math.min(1.0, 0.5 + p.z / 300));
        ctx.fillStyle = this.hexToRgba(color, alpha);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1.5, this.particles[i].size * p.scale), 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }

    // --- MODEL 4: ORBITAL GYROSCOPE REACTOR ---
    renderGyroscope(cx, cy, color) {
      const ctx = this.ctx;
      const radiusOuter = 180 * this.pulseScale;
      const radiusMid = 135 * this.pulseScale;
      const radiusInner = 90 * this.pulseScale;

      ctx.save();

      // Render 3 Concentric 3D Rings
      this.draw3DRing(cx, cy, radiusOuter, this.rotX, this.rotY, this.rotZ, color, 1.8);
      this.draw3DRing(cx, cy, radiusMid, this.rotY * 1.3, this.rotZ * 1.3, this.rotX * 1.3, '#38bdf8', 1.4);
      this.draw3DRing(cx, cy, radiusInner, this.rotZ * 1.6, this.rotX * 1.6, this.rotY * 1.6, '#fbbf24', 1.2);

      // Core pulsating sun
      const coreZ = 0;
      const coreProj = this.project({ x: 0, y: 0, z: coreZ }, 600, cx, cy);
      const rad = 22 * this.pulseScale;
      const grad = ctx.createRadialGradient(coreProj.x, coreProj.y, 2, coreProj.x, coreProj.y, rad);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, color);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(coreProj.x, coreProj.y, rad, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    draw3DRing(cx, cy, radius, rx, ry, rz, color, width) {
      const segments = 48;
      const pts = [];

      for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const pt = {
          x: Math.cos(theta) * radius,
          y: Math.sin(theta) * radius,
          z: 0
        };
        const rot = this.rotatePoint(pt, rx, ry, rz);
        pts.push(this.project(rot, 600, cx, cy));
      }

      const ctx = this.ctx;
      ctx.lineWidth = width;
      for (let i = 0; i < segments; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const alpha = Math.max(0.15, Math.min(0.9, 0.5 + (p1.z + p2.z) / 400));
        ctx.strokeStyle = this.hexToRgba(color, alpha);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }

    hexToRgba(hex, alpha = 1) {
      let c = hex.replace('#', '');
      if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
      const r = parseInt(c.substring(0, 2), 16) || 168;
      const g = parseInt(c.substring(2, 4), 16) || 85;
      const b = parseInt(c.substring(4, 6), 16) || 247;
      return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
    }

    // Public setter methods for UI control panel
    setModelType(type) {
      this.config.modelType = type;
      this.saveConfig();
    }

    setModelColor(hex) {
      this.config.modelColor = hex;
      this.saveConfig();
      this.applyTheme();
    }

    setBgMode(mode) {
      this.config.bgMode = mode;
      this.saveConfig();
      this.applyTheme();
    }

    setGifPreset(preset) {
      this.config.gifPreset = preset;
      this.saveConfig();
      this.applyTheme();
    }

    setCustomGifUrl(url) {
      this.config.customGifUrl = url;
      this.config.gifPreset = 'custom';
      this.saveConfig();
      this.applyTheme();
    }

    setGifOpacity(val) {
      this.config.gifOpacity = parseFloat(val);
      this.saveConfig();
      this.applyTheme();
    }

    setGifBlur(val) {
      this.config.gifBlur = parseInt(val, 10);
      this.saveConfig();
      this.applyTheme();
    }

    setRotationSpeed(val) {
      this.config.rotationSpeed = parseFloat(val);
      this.saveConfig();
    }
  }

  // Instantiate and expose globally
  window.canvas3dEngine = new Canvas3DEngine();

  // Initialize once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.canvas3dEngine.init());
  } else {
    window.canvas3dEngine.init();
  }
})();
