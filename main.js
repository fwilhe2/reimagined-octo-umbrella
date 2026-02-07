(() => {
  // Canvas & UI
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const levelEl = document.getElementById('level');
  const livesEl = document.getElementById('lives');
  const targetWordEl = document.getElementById('targetWord');
  const typedPreviewEl = document.getElementById('typedPreview');
  const overlay = document.getElementById('overlay');
  const overlayStart = document.getElementById('overlayStart');
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const restartBtn = document.getElementById('restartBtn');

  // DPR and resize
  const DPR = Math.max(1, window.devicePixelRatio || 1);
  function resize() {
    canvas.width = Math.floor(window.innerWidth * DPR);
    canvas.height = Math.floor(window.innerHeight * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  // Word list (will be filtered by difficulty)
  const WORDS = [
    "zombie","brain","attack","headshot","survive","danger","shamble","run","strike",
    "reload","panic","hero","night","horror","escape","bleed","shoot","shot","kill",
    "target","trigger","castle","grieve","threat","fright","chaos","screech",
    "dawn","twilight","roam","wander","lurch","decay","infect","spawn","infected","bite",
    "vapor","shatter","ember","cinder","phantom","stumble","gore","fade","blink","flare"
  ];

  // Difficulty profiles
  const DIFFICULTIES = {
    easy: {
      spawnIntervalBase: 1200,      // ms baseline between spawns
      spawnIntervalMult: 1.9,      // multiplier -> effective ~2280ms
      speedMult: 0.60,             // enemies move slower
      lives: 6,
      laneCount: 3,
      maxWordLen: 6,
      spawnBurstChance: 0.05,
      levelScoreDivisor: 800,      // slower level ups
      initialZombies: 2,
      pauseChance: 0.0,           // temporarily disabled for testing
      pauseMinDur: 800,            // min pause duration (ms)
      pauseMaxDur: 1800            // max pause duration (ms)
    },
    normal: {
      spawnIntervalBase: 1000,
      spawnIntervalMult: 1.0,
      speedMult: 1.0,
      lives: 4,
      laneCount: 5,
      maxWordLen: 10,
      spawnBurstChance: 0.12,
      levelScoreDivisor: 400,
      initialZombies: 3,
      pauseChance: 0.15,
      pauseMinDur: 600,
      pauseMaxDur: 1200
    },
    hard: {
      spawnIntervalBase: 800,
      spawnIntervalMult: 0.9,
      speedMult: 1.3,
      lives: 3,
      laneCount: 5,
      maxWordLen: 12,
      spawnBurstChance: 0.25,
      levelScoreDivisor: 250,
      initialZombies: 4,
      pauseChance: 0.08,
      pauseMinDur: 400,
      pauseMaxDur: 800
    }
  };

  // Active config (will be set from overlay)
  let config = DIFFICULTIES.easy;

  // Game state
  let running = false;
  let paused = false;
  let lastFrame = performance.now();
  let lastSpawn = 0;
  let score = 0;
  let level = 1;
  let lives = config.lives;
  let spawnInterval = config.spawnIntervalBase * config.spawnIntervalMult;

  // 3D camera parameters
  const camera = {
    focal: 900,
    cx: () => canvas.clientWidth / 2,
    cy: () => canvas.clientHeight * 0.45,
  };

  // Entities
  class Zombie {
    constructor(word, x, z, speed) {
      this.word = word;
      this.x = x; // world x
      this.z = z; // world z (distance from camera)
      this.speed = speed; // z speed (units per ms)
      this.typed = 0;
      this.dead = false;
      this.selected = false;
      this.pausedUntil = 0; // pause timer (ms)
    }
    project() {
      const z = Math.max(10, this.z);
      const scale = camera.focal / z;
      const sx = camera.cx() + this.x * scale;
      const sy = camera.cy() + 120 * scale;
      return { sx, sy, scale, z };
    }
    update(dt, now) {
      // check if paused
      if (now < this.pausedUntil) return;
      this.z -= this.speed * dt;
    }
  }

  let zombies = [];
  let particles = [];

  // Particle class
  class Particle {
    constructor(x,y,color,vx,vy,life=50) {
      this.x = x; this.y = y; this.vx = vx; this.vy = vy; this.color = color;
      this.age = 0; this.life = life;
    }
    update() { this.age++; this.x += this.vx; this.y += this.vy; this.vy += 0.08; }
    draw(ctx) {
      const a = 1 - this.age / this.life;
      ctx.fillStyle = `rgba(${this.color},${a})`;
      ctx.beginPath(); ctx.arc(this.x, this.y, Math.max(0, 2.5 * a), 0, Math.PI*2); ctx.fill();
    }
    get dead() { return this.age >= this.life; }
  }

  // Audio helpers
  let audioCtx = null;
  function ensureAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
  function playBeep(freq = 440, dur=0.06, type='sine') {
    try {
      ensureAudio();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur + 0.02);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur + 0.03);
    } catch (e) { /* audio may be blocked on some browsers without user gesture */ }
  }
  function playKill() { playBeep(220 + Math.random() * 300, 0.06, 'sawtooth'); }

  // Spawn logic (uses config.laneCount and speed mult)
  function spawnZombie() {
    const laneCount = config.laneCount;
    const laneWidth = 140;
    const idx = Math.floor(Math.random() * laneCount) - Math.floor(laneCount/2);
    const x = idx * laneWidth + rand(-40, 40);
    const z = rand(1400, 2600);
    // more dramatic speed variation
    const baseSpeed = rand(0.35, 1.1);
    const speed = baseSpeed * config.speedMult;
    // choose shorter words on easy by maxWordLen
    const wordCandidates = WORDS.filter(w => w.length <= config.maxWordLen);
    const word = wordCandidates[Math.floor(Math.random() * wordCandidates.length)];
    const zombie = new Zombie(word, x, z, speed);
    // randomly schedule initial pause
    if (Math.random() < config.pauseChance) {
      zombie.pausedUntil = performance.now() + rand(config.pauseMinDur, config.pauseMaxDur);
    }
    zombies.push(zombie);
  }

  function rand(a,b){return a + Math.random()*(b-a);}

  function takeDamage() {
    lives--;
    playBeep(120, 0.06, 'sine');
    if (lives <= 0) endGame();
  }

  // Input & targeting
  let selected = null;

  function autoTargetByChar(ch) {
    // prefer visible enemies where next char matches; choose closest (smallest z)
    const candidates = zombies.filter(z => !z.dead && z.word[z.typed] === ch && z.z > 10);
    if (candidates.length === 0) return null;
    candidates.sort((a,b) => a.z - b.z);
    return candidates[0];
  }

  window.addEventListener('keydown', (ev) => {
    if (!running || paused) return;
    const k = ev.key;
    if (k.length !== 1) return;
    const ch = k.toLowerCase();

    // Choose target: if current doesn't match, auto-target
    if (!selected || selected.dead || selected.word[selected.typed] !== ch) {
      const candidate = autoTargetByChar(ch);
      if (candidate) {
        if (selected) selected.selected = false;
        selected = candidate; selected.selected = true;
      }
    }
    if (selected && !selected.dead) {
      const expected = selected.word[selected.typed];
      if (expected === ch) {
        selected.typed++;
        playBeep(700 + Math.random()*300, 0.02, 'square');
        if (selected.typed >= selected.word.length) killZombie(selected);
      } else {
        playBeep(110, 0.04, 'sine');
      }
    }
  });

  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    // pick nearest (smallest z) whose projected circle contains click
    let chosen = null; let bestZ = Infinity;
    for (const z of zombies) {
      if (z.dead) continue;
      const p = z.project();
      const size = Math.max(8, 120 * p.scale);
      const dx = p.sx - mx, dy = p.sy - my;
      const d = Math.sqrt(dx*dx + dy*dy);
      if (d < size * 0.6 && z.z < bestZ) { chosen = z; bestZ = z.z; }
    }
    if (chosen) {
      if (selected) selected.selected = false;
      selected = chosen; selected.selected = true;
      updateHUD();
    } else {
      // click into space = "shoot" center; damage nearest under crosshair
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      let victim = null; bestZ = Infinity;
      for (const z of zombies) {
        if (z.dead) continue;
        const p = z.project();
        const size = Math.max(8, 120 * p.scale);
        const dx = p.sx - cx, dy = p.sy - cy;
        const d = Math.sqrt(dx*dx + dy*dy);
        if (d < size * 0.55 && z.z < bestZ) { victim = z; bestZ = z.z; }
      }
      if (victim) {
        if (victim.typed < victim.word.length) {
          victim.typed++;
          playBeep(880, 0.03, 'triangle');
          if (victim.typed >= victim.word.length) killZombie(victim);
        }
      }
    }
  });

  function killZombie(z) {
    z.dead = true;
    score += Math.floor(12 * z.word.length * (1 + level*0.06));
    const p = z.project();
    const color = "232,90,79";
    for (let i=0;i<14;i++) {
      particles.push(new Particle(p.sx + rand(-8,8), p.sy + rand(-8,8), color, rand(-2.2,2.2), rand(-3.6, -0.6), 36 + Math.random()*28));
    }
    playKill();
    if (z === selected) selected = null;
    updateHUD();
  }

  function updateHUD() {
    scoreEl.textContent = `Score: ${score}`;
    levelEl.textContent = `Level: ${level}`;
    livesEl.textContent = `Lives: ${lives}`;
    if (selected && !selected.dead) {
      const word = selected.word;
      const typed = word.slice(0, selected.typed);
      const remaining = word.slice(selected.typed);
      targetWordEl.innerHTML = `Target: <span class="typed">${typed}</span><span class="next-char">${remaining[0] || ''}</span><span class="remaining">${remaining.slice(1)}</span>`;
      const progress = Math.round((selected.typed / word.length) * 100);
      typedPreviewEl.innerHTML = `Progress: ${progress}%`;
    } else {
      targetWordEl.textContent = `Target: —`;
      typedPreviewEl.textContent = `Progress: `;
    }
  }

  function endGame() {
    running = false; paused = false;
    overlay.querySelector('.center').innerHTML = `
      <h1>Game Over</h1>
      <p>Your score: <strong>${score}</strong></p>
      <p>Press Restart to play again.</p>
      <button id="overlayRestart">Restart</button>
    `;
    overlay.classList.remove('hidden');
    document.getElementById('overlayRestart').addEventListener('click', () => {
      resetGame(); overlay.classList.add('hidden'); startGame();
    });
  }

  function resetGame() {
    zombies = []; particles = []; lastSpawn = 0; score = 0; level = 1;
    lives = config.lives;
    spawnInterval = config.spawnIntervalBase * config.spawnIntervalMult;
    selected = null; updateHUD();
  }

  // main loop
  function loop(now) {
    if (!running) return;
    const dt = Math.min(45, now - lastFrame);
    lastFrame = now;

    if (!paused) {
      // spawn
      if (now - lastSpawn > spawnInterval) {
        spawnZombie();
        lastSpawn = now;
        if (Math.random() < config.spawnBurstChance) spawnZombie();
      }

      // update zombies
      for (const z of zombies) if (!z.dead) z.update(dt, now);

      // zombies reached camera
      for (const z of zombies) {
        if (!z.dead && z.z < 60) {
          z.dead = true;
          takeDamage();
        }
      }

      // cleanup
      zombies = zombies.filter(z => !(z.dead && z.z < -300));
      particles = particles.filter(p => !p.dead);

      // level progression (slower on easier)
      const newLevel = 1 + Math.floor(score / config.levelScoreDivisor);
      if (newLevel !== level) {
        level = newLevel;
        // ramp spawn interval slightly
        spawnInterval = Math.max(300, config.spawnIntervalBase * config.spawnIntervalMult - (level - 1) * 60);
      }
    }

    // draw
    drawScene();
    updateHUD();
    requestAnimationFrame(loop);
  }

  // draw scene & helpers (same as before)
  function drawScene() {
    ctx.clearRect(0,0,canvas.clientWidth, canvas.clientHeight);

    // sky
    const g = ctx.createLinearGradient(0,0,0,canvas.clientHeight);
    g.addColorStop(0, "#071021");
    g.addColorStop(1, "#0b1620");
    ctx.fillStyle = g;
    ctx.fillRect(0,0,canvas.clientWidth, canvas.clientHeight);

    // horizon
    const horizonY = camera.cy();
    ctx.fillStyle = "rgba(220,160,120,0.03)";
    ctx.fillRect(0, horizonY-6, canvas.clientWidth, 18);

    drawGround();

    // draw zombies far -> near
    const drawList = zombies.slice().sort((a,b) => b.z - a.z);
    for (const z of drawList) {
      if (z.dead) continue;
      const p = z.project();
      if (p.z < 8) continue;
      ctx.save();
      const scale = p.scale;
      const sx = p.sx, sy = p.sy;
      const size = Math.max(10, 120 * scale);

      // shadow
      ctx.beginPath();
      ctx.ellipse(sx, sy + size*0.5, size*0.6, size*0.25, 0, 0, Math.PI*2);
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fill();

      ctx.translate(sx, sy);
      const bob = Math.sin((z.z + performance.now()*0.03)/200) * 3 * scale;
      ctx.translate(0, bob);

      // head
      ctx.beginPath();
      ctx.fillStyle = "#6aa06a";
      ctx.arc(0, -size*0.18, size*0.28, 0, Math.PI*2);
      ctx.fill();

      // eyes & mouth
      ctx.fillStyle = "#111";
      ctx.fillRect(-size*0.08, -size*0.22, size*0.06, size*0.12);
      ctx.fillRect(size*0.04, -size*0.22, size*0.06, size*0.12);
      ctx.fillStyle = "#2b2b2b";
      ctx.fillRect(-size*0.16, -size*0.04, size*0.32, size*0.08);

      if (z.selected) {
        ctx.lineWidth = Math.max(2, 4 * scale);
        ctx.strokeStyle = "rgba(232,90,79,0.95)";
        ctx.beginPath();
        ctx.arc(0, -size*0.18, size*0.36, 0, Math.PI*2);
        ctx.stroke();
      }

      // show pause indicator if paused
      if (now < z.pausedUntil) {
        ctx.fillStyle = "rgba(255,200,87,0.9)";
        ctx.font = `bold ${Math.max(10, 14 * scale)}px serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("⏸", 0, -size*0.38);
      }

      // word label
      const fontSize = Math.max(14, 20 * scale);
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const typedPart = z.word.slice(0, z.typed);
      const restPart = z.word.slice(z.typed);

      // draw darker background behind text for better readability
      const metrics = ctx.measureText(z.word);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(-metrics.width/2 - 6, size*0.18 -  4, metrics.width + 12, fontSize + 8);

      // typed part in green
      ctx.fillStyle = "#4ade80";
      ctx.fillText(typedPart, -metrics.width/2, size*0.18);
      
      // remaining in bright white
      ctx.fillStyle = "#f0f4f8";
      ctx.fillText(restPart, -metrics.width/2 + ctx.measureText(typedPart).width, size*0.18);

      ctx.restore();
    }

    // particles
    for (const p of particles) p.draw(ctx);

    drawCrosshair();

    if (selected && !selected.dead) {
      const p = selected.project();
      ctx.beginPath();
      ctx.strokeStyle = "rgba(232,90,79,0.9)";
      ctx.lineWidth = 2;
      ctx.arc(p.sx, p.sy - 12 * p.scale, Math.max(8, 18 * p.scale), 0, Math.PI*2);
      ctx.stroke();
    }
  }

  function drawCrosshair() {
    const cx = canvas.clientWidth / 2;
    const cy = canvas.clientHeight / 2;
    ctx.strokeStyle = "#e85a4f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 18, cy);
    ctx.lineTo(cx + 18, cy);
    ctx.moveTo(cx, cy - 18);
    ctx.lineTo(cx, cy + 18);
    ctx.stroke();
    ctx.beginPath();
    ctx.fillStyle = "rgba(232,90,79,0.95)";
    ctx.arc(cx, cy, 3, 0, Math.PI*2);
    ctx.fill();
  }

  function drawGround() {
    const cx = camera.cx();
    const cy = camera.cy();
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.03)";
    ctx.lineWidth = 2;
    const lanes = config.laneCount;
    const laneGap = 140;
    for (let i = -Math.floor(lanes/2) - 1; i <= Math.floor(lanes/2) + 1; i++) {
      ctx.beginPath();
      const xBottom = cx + i * laneGap;
      ctx.moveTo(xBottom, canvas.clientHeight);
      ctx.lineTo(cx + i * 20, cy + 10);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    const dashCount = 12;
    for (let j=0;j<dashCount;j++) {
      const t = j / dashCount;
      const z = 200 + t * 1500;
      const scale = camera.focal / z;
      const sx = cx + 0 * scale;
      const sy = cy + 120 * scale + t* (canvas.clientHeight - cy - 120*scale);
      ctx.beginPath();
      ctx.moveTo(sx - 20*scale, sy);
      ctx.lineTo(sx + 20*scale, sy);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Controls
  function startGame() {
    if (!running) {
      running = true; paused = false; lastFrame = performance.now(); lastSpawn = performance.now();
      for (let i=0;i<config.initialZombies;i++) spawnZombie();
      requestAnimationFrame(loop);
    }
  }
  function pauseGame() { paused = !paused; pauseBtn.textContent = paused ? "Unpause" : "Pause"; }
  function restartGame() { resetGame(); overlay.classList.add('hidden'); startGame(); }

  overlayStart.addEventListener('click', () => {
    // read difficulty choice
    const diff = document.querySelector('input[name="difficulty"]:checked')?.value || 'easy';
    config = DIFFICULTIES[diff] || DIFFICULTIES.easy;
    // apply selected config
    spawnInterval = config.spawnIntervalBase * config.spawnIntervalMult;
    lives = config.lives;
    resetGame();
    overlay.classList.add('hidden');
    startGame();
  });

  startBtn.addEventListener('click', () => { if (!running) { overlay.classList.add('hidden'); startGame(); } });
  pauseBtn.addEventListener('click', () => { if (running) pauseGame(); });
  restartBtn.addEventListener('click', () => { restartGame(); });

  // utility helpers
  function cleanup() {
    zombies = zombies.filter(z => !(z.dead && z.z < -300));
    particles = particles.filter(p => !p.dead);
  }

  // initial HUD
  updateHUD();

  // mobile: unlock audio on touch
  window.addEventListener('touchstart', () => { try { ensureAudio(); } catch(e){} }, {passive:true});
})();