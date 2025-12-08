import { autoCorrelate, frequencyToNote } from './pitch.js';
import { ScoreRenderer } from './vexflow-renderer.js';

// --- State ---
let audioCtx;
let sourceNode;
let audioBuffer;
let isPlaying = false;
let animationId;
let playbackSpeed = 1.0;

// Track Management
let tracks = [];
const tracksContainer = document.getElementById('tracksContainer');
const trackTemplate = document.getElementById('trackTemplate');

// --- Global Elements ---
const audioInput = document.getElementById('audioInput');
const loadDemoBtn = document.getElementById('loadDemoBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');
const addTrackBtn = document.getElementById('addTrackBtn');
const speedInput = document.getElementById('speedInput');
const speedVal = document.getElementById('speedVal');

// --- Track Class ---
class Track {
    constructor(id, savedSettings = null) {
        this.id = id;
        this.settings = savedSettings || {
            filterMode: 'eq',
            threshold: 0.03,
            eq: { bass: 0, mid: 0, high: 0 },
            bp: { freq: 1000, q: 1.0 }
        };
        
        // State
        this.currentNote = null;
        this.noteStartTime = 0;
        this.renderer = null;

        // Audio Nodes
        this.analyser = null;
        this.filters = {};
        
        this.element = this.renderDOM();
        this.initRenderer();
        this.bindEvents();
    }

    renderDOM() {
        const clone = trackTemplate.content.cloneNode(true);
        const card = clone.querySelector('.track-card');
        card.id = `track-${this.id}`;
        card.querySelector('.track-title').textContent = `Isolation Part ${this.id}`;
        
        // Set values
        card.querySelector('.threshold-input').value = this.settings.threshold;
        card.querySelector('.filter-mode').value = this.settings.filterMode;
        card.querySelector('.bass-gain').value = this.settings.eq.bass;
        card.querySelector('.mid-gain').value = this.settings.eq.mid;
        card.querySelector('.high-gain').value = this.settings.eq.high;
        card.querySelector('.bp-freq').value = this.settings.bp.freq;
        card.querySelector('.bp-q').value = this.settings.bp.q;
        card.querySelector('.freq-val').textContent = this.settings.bp.freq;

        this.updateVisibility(card);
        tracksContainer.appendChild(card);
        return card;
    }

    initRenderer() {
        const wrapper = this.element.querySelector('.canvas-wrapper');
        const id = `score-${this.id}-${Date.now()}`;
        wrapper.id = id;
        this.renderer = new ScoreRenderer(id);
        this.renderer.render(); // Draw empty
    }

    bindEvents() {
        const e = this.element;
        // Mode Switch
        e.querySelector('.filter-mode').addEventListener('change', (evt) => {
            this.settings.filterMode = evt.target.value;
            this.updateVisibility(this.element);
            this.updateAudioNodes();
            saveState();
        });

        // Sliders
        const update = () => {
            this.settings.threshold = parseFloat(e.querySelector('.threshold-input').value);
            this.settings.eq.bass = parseFloat(e.querySelector('.bass-gain').value);
            this.settings.eq.mid = parseFloat(e.querySelector('.mid-gain').value);
            this.settings.eq.high = parseFloat(e.querySelector('.high-gain').value);
            this.settings.bp.freq = parseFloat(e.querySelector('.bp-freq').value);
            this.settings.bp.q = parseFloat(e.querySelector('.bp-q').value);
            e.querySelector('.freq-val').textContent = this.settings.bp.freq;
            
            this.updateAudioNodes();
            saveState();
        };

        e.querySelectorAll('input').forEach(i => i.addEventListener('input', update));
        
        // Actions
        e.querySelector('.btn-clear').addEventListener('click', () => {
            this.renderer.reset();
            this.renderer.render();
        });

        e.querySelector('.btn-remove').addEventListener('click', () => {
            this.destroy();
        });
    }

    updateVisibility(card) {
        if (this.settings.filterMode === 'eq') {
            card.querySelector('.eq-controls').classList.remove('hidden');
            card.querySelector('.bandpass-controls').classList.add('hidden');
        } else {
            card.querySelector('.eq-controls').classList.add('hidden');
            card.querySelector('.bandpass-controls').classList.remove('hidden');
        }
    }

    // Connect audio processing for this track
    connectToSource(source) {
        if (!audioCtx) return;
        
        // Disconnect previous if any
        try { if(this.analyser) this.analyser.disconnect(); } catch(e){}

        // Create Chain
        this.analyser = audioCtx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.5;

        // Route: Source -> Filter -> Analyser
        let lastNode = source;

        if (this.settings.filterMode === 'eq') {
            const bass = audioCtx.createBiquadFilter();
            bass.type = 'lowshelf'; bass.frequency.value = 250; bass.gain.value = this.settings.eq.bass;
            
            const mid = audioCtx.createBiquadFilter();
            mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 1.0; mid.gain.value = this.settings.eq.mid;

            const high = audioCtx.createBiquadFilter();
            high.type = 'highshelf'; high.frequency.value = 4000; high.gain.value = this.settings.eq.high;

            lastNode.connect(bass);
            bass.connect(mid);
            mid.connect(high);
            lastNode = high;
            
            this.filters = { bass, mid, high };
        } else {
            const bp = audioCtx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = this.settings.bp.freq;
            bp.Q.value = this.settings.bp.q;
            
            lastNode.connect(bp);
            lastNode = bp;
            this.filters = { bp };
        }

        lastNode.connect(this.analyser);
        // We do NOT connect to destination (speakers) for every track to avoid loud summing
        // Only Track 1 (Main) or a specific mixer logic should go to speakers?
        // For now: Only the first track goes to speakers, or we add a "Monitor" checkbox.
        // Let's connect ALL to destination but lower volume? Or just Main Source to destination?
        // Default: The main source is connected to destination in `setupAudioChain`.
        // These tracks are just for analysis.
    }

    updateAudioNodes() {
        if (!this.filters.bass && !this.filters.bp) return;

        if (this.settings.filterMode === 'eq' && this.filters.bass) {
            this.filters.bass.gain.value = this.settings.eq.bass;
            this.filters.mid.gain.value = this.settings.eq.mid;
            this.filters.high.gain.value = this.settings.eq.high;
        } else if (this.settings.filterMode === 'bandpass' && this.filters.bp) {
            this.filters.bp.frequency.value = this.settings.bp.freq;
            this.filters.bp.Q.value = this.settings.bp.q;
        }
        // If mode changed entirely, we need to reconnect, handled by `setupAudioChain` calling `connectToSource` again
        // But if playing, we might need hot-swap. 
        if (isPlaying && sourceNode) {
             // Re-trigger connection logic if structure changed
             // This is complex, simplest is to just update values if nodes exist.
             // If mode switched, we rely on the mode switch handler which should ideally reconnect.
             // For simplicity, mode switch effects next play or we can implement hot-swap:
             // We'll leave hot-swap for now to avoid popping.
        }
    }

    process(currentTime) {
        if (!this.analyser) return;

        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Float32Array(bufferLength);
        const byteData = new Uint8Array(bufferLength);
        
        this.analyser.getFloatTimeDomainData(dataArray);
        this.analyser.getByteFrequencyData(byteData);

        // 1. Visualize
        const canvas = this.element.querySelector('.freq-canvas');
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        const barWidth = (canvas.width / bufferLength) * 2.5;
        let barX = 0;
        for(let i = 0; i < bufferLength; i++) {
            const h = (byteData[i] / 255) * canvas.height;
            ctx.fillStyle = `hsl(${i/2}, 70%, 50%)`;
            ctx.fillRect(barX, canvas.height - h, barWidth, h);
            barX += barWidth + 1;
        }
        
        // Threshold Line
        const threshY = canvas.height - (Math.min(1, this.settings.threshold * 5) * canvas.height);
        ctx.strokeStyle = 'red';
        ctx.beginPath(); ctx.moveTo(0, threshY); ctx.lineTo(canvas.width, threshY); ctx.stroke();

        // 2. Pitch Detect
        // When slowed down, the pitch drops. We detect the dropped pitch.
        // Real Pitch = Detected Pitch / Speed.
        // Wait: If I play C4 (261Hz) at 0.5 speed, it sounds like C3 (130Hz).
        // The analyzer sees 130Hz.
        // If the user wants to transcribe the ORIGINAL song, we must compensate: 130 / 0.5 = 260.
        let frequency = autoCorrelate(dataArray, audioCtx.sampleRate, this.settings.threshold);
        
        if (frequency !== -1) {
            // Compensate for playback speed
            frequency = frequency / playbackSpeed;
        }

        const noteData = frequencyToNote(frequency);
        const noteDisplay = this.element.querySelector('.current-note');

        if (noteData) {
            noteDisplay.textContent = `${noteData.name}`; // (${Math.round(noteData.frequency)}Hz)`;
            
            // Duration Logic
            if (!this.currentNote) {
                // New Note Started
                this.currentNote = noteData;
                this.noteStartTime = currentTime;
            } else {
                // Check if note changed
                if (noteData.name !== this.currentNote.name) {
                    // Previous note ended
                    this.finalizeNote(currentTime);
                    // New note start
                    this.currentNote = noteData;
                    this.noteStartTime = currentTime;
                }
            }
        } else {
            noteDisplay.textContent = "--";
            if (this.currentNote) {
                // Note ended (went to silence)
                this.finalizeNote(currentTime);
                this.currentNote = null;
            }
        }
    }

    finalizeNote(endTime) {
        if (!this.currentNote) return;

        // Calculate duration in seconds
        // IMPORTANT: The `currentTime` is wall-clock time.
        // The audio played for (endTime - start) wall seconds.
        // But the audio content progress was (endTime - start) * speed.
        // Wait. If I listen for 1 second at 0.5x speed, I heard 0.5 seconds of the original audio.
        // Musical duration is relative to the song's tempo. 
        // If the song is 120bpm, a quarter note is 0.5s (original).
        // At 0.5x speed, that quarter note takes 1.0s to play.
        // So `measured_wall_duration * speed` = `original_duration`.
        
        const wallDuration = endTime - this.noteStartTime;
        const originalDuration = wallDuration * playbackSpeed; 

        // Quantize
        // Let's assume 100 BPM roughly (600ms per beat) as a baseline if we don't know tempo
        // q = 0.6s
        // We can just use ratios.
        // > 1.5s -> whole
        // > 0.8s -> half
        // > 0.4s -> quarter
        // > 0.2s -> eighth
        // else 16th
        
        // Let's make it slightly more generous
        let sym = '16';
        if (originalDuration > 1.8) sym = 'w';
        else if (originalDuration > 0.9) sym = 'h';
        else if (originalDuration > 0.4) sym = 'q';
        else if (originalDuration > 0.2) sym = '8';
        
        if (originalDuration > 0.1) { // Ignore extremely short blips
            this.renderer.addNote({
                ...this.currentNote,
                duration: sym
            });
            // Auto scroll
            const container = this.element.querySelector('.sheet-music-container');
            container.scrollLeft = container.scrollWidth;
        }
    }

    destroy() {
        if (this.analyser) this.analyser.disconnect();
        this.element.remove();
        tracks = tracks.filter(t => t.id !== this.id);
        saveState();
    }
}

// --- Persistence ---
function saveState() {
    const state = tracks.map(t => ({ id: t.id, settings: t.settings }));
    localStorage.setItem('ogg_transcriber_state', JSON.stringify(state));
}

function loadState() {
    const raw = localStorage.getItem('ogg_transcriber_state');
    if (raw) {
        try {
            const state = JSON.parse(raw);
            state.forEach(s => {
                const t = new Track(s.id, s.settings);
                tracks.push(t);
            });
        } catch(e) { console.error(e); }
    }
    
    // Default track if none
    if (tracks.length === 0) {
        const t = new Track(1);
        tracks.push(t);
    }
}

// --- Main Audio Logic ---

async function initAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }
}

async function setupAudioChain() {
    if (sourceNode) {
        try { sourceNode.stop(); sourceNode.disconnect(); } catch(e){}
    }

    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.playbackRate.value = playbackSpeed;

    // Connect Source to Destination (Hear it)
    // Create a master gain to prevent clipping if we want
    sourceNode.connect(audioCtx.destination);

    // Connect Source to Tracks (Analyze it)
    tracks.forEach(t => t.connectToSource(sourceNode));

    sourceNode.onended = () => {
        isPlaying = false;
        playBtn.disabled = false;
        pauseBtn.disabled = true;
        cancelAnimationFrame(animationId);
    };

    sourceNode.start(0);
    isPlaying = true;
    playBtn.disabled = true;
    pauseBtn.disabled = false;

    analyzeLoop();
}

function analyzeLoop() {
    if (!isPlaying) return;

    const now = audioCtx.currentTime; // High precision time

    tracks.forEach(t => t.process(now));

    animationId = requestAnimationFrame(analyzeLoop);
}

// --- Listeners ---

addTrackBtn.addEventListener('click', () => {
    const id = tracks.length > 0 ? Math.max(...tracks.map(t => t.id)) + 1 : 1;
    const t = new Track(id);
    tracks.push(t);
    saveState();
    if(isPlaying) t.connectToSource(sourceNode);
});

audioInput.addEventListener('change', async (e) => {
    if (e.target.files[0]) {
        playBtn.textContent = "Loading...";
        await initAudioContext();
        try {
            const ab = await e.target.files[0].arrayBuffer();
            audioBuffer = await audioCtx.decodeAudioData(ab);
            playBtn.textContent = "▶ Play";
            playBtn.disabled = false;
        } catch(e) {
            alert("Error: " + e);
        }
    }
});

loadDemoBtn.addEventListener('click', async () => {
    playBtn.textContent = "Loading Demo...";
    await initAudioContext();
    const response = await fetch('demo_piano.mp3');
    const ab = await response.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(ab);
    playBtn.textContent = "▶ Play";
    playBtn.disabled = false;
});

playBtn.addEventListener('click', async () => {
    if(!audioBuffer) return;
    await initAudioContext();
    setupAudioChain();
});

pauseBtn.addEventListener('click', () => {
    if (sourceNode) {
        sourceNode.stop();
        isPlaying = false;
        playBtn.disabled = false;
        pauseBtn.disabled = true;
    }
});

resetBtn.addEventListener('click', () => {
    tracks.forEach(t => {
        t.renderer.reset();
        t.renderer.render();
    });
});

speedInput.addEventListener('input', (e) => {
    playbackSpeed = parseFloat(e.target.value);
    speedVal.textContent = playbackSpeed.toFixed(1);
    if (sourceNode && isPlaying) {
        sourceNode.playbackRate.value = playbackSpeed;
    }
});

// Init
loadState();