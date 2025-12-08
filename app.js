import { autoCorrelate, frequencyToNote } from './pitch.js';
import { ScoreRenderer } from './vexflow-renderer.js';

// --- State ---
let audioCtx;
let buffer;
let isPlaying = false;
let animationId;
let tracks = [];
let nextTrackId = 1;

// --- Elements ---
const audioInput = document.getElementById('audioInput');
const loadDemoBtn = document.getElementById('loadDemoBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const clearBtn = document.getElementById('clearBtn');
const tracksContainer = document.getElementById('tracksContainer');
const addTrackBtn = document.getElementById('addTrackBtn');
const sheetContainer = document.getElementById('sheetContainer');

// --- Track Class ---
class Track {
    constructor(id, savedState = null) {
        this.id = id;
        this.settings = savedState || {
            threshold: 0.03,
            filterMode: 'eq', // 'eq' or 'bandpass'
            eq: { bass: 0, mid: 0, high: 0 },
            bp: { freq: 1000, q: 1 }
        };
        
        this.nodes = {
            source: null,
            filters: {}, // bass, mid, high, bandpass
            analyser: null
        };

        this.analysis = {
            currentNote: null,
            noteStartTime: 0,
            lastFreq: -1
        };

        // Create UI
        this.elements = this.createUI();
        
        // Create Renderer
        this.renderer = new ScoreRenderer(this.elements.scoreId);
    }

    createUI() {
        const div = document.createElement('div');
        div.className = 'track-module';
        div.innerHTML = `
            <div class="track-header">
                <span class="track-title">Track ${this.id}</span>
                <button class="close-track-btn">Remove</button>
            </div>
            
            <div class="filter-controls">
                <div class="control-row">
                    <label>Gate Threshold</label>
                    <input type="range" class="thresh-slider" min="0" max="0.2" step="0.001" value="${this.settings.threshold}">
                </div>
                
                <div class="control-row mode-select">
                    <label>Mode:</label>
                    <select class="mode-select-input">
                        <option value="eq" ${this.settings.filterMode === 'eq' ? 'selected' : ''}>3-Band EQ</option>
                        <option value="bandpass" ${this.settings.filterMode === 'bandpass' ? 'selected' : ''}>Focus (Bandpass)</option>
                    </select>
                </div>

                <div class="eq-controls sliders ${this.settings.filterMode === 'eq' ? '' : 'hidden'}">
                    <div class="slider-group"><label>Low</label><input type="range" class="bass-slider" min="-30" max="10" value="${this.settings.eq.bass}"></div>
                    <div class="slider-group"><label>Mid</label><input type="range" class="mid-slider" min="-30" max="10" value="${this.settings.eq.mid}"></div>
                    <div class="slider-group"><label>High</label><input type="range" class="high-slider" min="-30" max="10" value="${this.settings.eq.high}"></div>
                </div>

                <div class="bp-controls sliders ${this.settings.filterMode === 'bandpass' ? '' : 'hidden'}">
                    <div class="slider-group wide"><label>Freq</label><input type="range" class="bp-freq-slider" min="50" max="5000" step="10" value="${this.settings.bp.freq}"></div>
                    <div class="slider-group"><label>Q</label><input type="range" class="bp-q-slider" min="0.1" max="10" step="0.1" value="${this.settings.bp.q}"></div>
                </div>
            </div>

            <div class="visualization-area" style="margin-top:10px;">
                <canvas width="300" height="40" class="track-canvas" style="width:100%; height:40px;"></canvas>
                <div class="note-display" style="top:auto; bottom:2px; right:2px; font-size:0.7rem;">--</div>
            </div>
        `;

        // Create Score Container
        const scoreDiv = document.createElement('div');
        scoreDiv.className = 'score-wrapper';
        const scoreId = `score_track_${this.id}_${Math.random().toString(36).substr(2, 5)}`;
        scoreDiv.id = scoreId;
        scoreDiv.innerHTML = `<span class="track-score-label">T${this.id}</span>`;
        sheetContainer.appendChild(scoreDiv);

        tracksContainer.appendChild(div);

        // Bind Events
        const removeBtn = div.querySelector('.close-track-btn');
        removeBtn.onclick = () => removeTrack(this.id);

        const threshSlider = div.querySelector('.thresh-slider');
        threshSlider.oninput = (e) => { this.settings.threshold = parseFloat(e.target.value); saveState(); };

        const modeSelect = div.querySelector('.mode-select-input');
        const eqDiv = div.querySelector('.eq-controls');
        const bpDiv = div.querySelector('.bp-controls');
        
        modeSelect.onchange = (e) => {
            this.settings.filterMode = e.target.value;
            if (this.settings.filterMode === 'eq') {
                eqDiv.classList.remove('hidden');
                bpDiv.classList.add('hidden');
            } else {
                eqDiv.classList.add('hidden');
                bpDiv.classList.remove('hidden');
            }
            this.applyRouting();
            saveState();
        };

        const bassSlider = div.querySelector('.bass-slider');
        bassSlider.oninput = (e) => { this.settings.eq.bass = parseFloat(e.target.value); this.updateFilters(); saveState(); };
        const midSlider = div.querySelector('.mid-slider');
        midSlider.oninput = (e) => { this.settings.eq.mid = parseFloat(e.target.value); this.updateFilters(); saveState(); };
        const highSlider = div.querySelector('.high-slider');
        highSlider.oninput = (e) => { this.settings.eq.high = parseFloat(e.target.value); this.updateFilters(); saveState(); };

        const bpFreqSlider = div.querySelector('.bp-freq-slider');
        bpFreqSlider.oninput = (e) => { this.settings.bp.freq = parseFloat(e.target.value); this.updateFilters(); saveState(); };
        const bpQSlider = div.querySelector('.bp-q-slider');
        bpQSlider.oninput = (e) => { this.settings.bp.q = parseFloat(e.target.value); this.updateFilters(); saveState(); };

        return {
            container: div,
            scoreContainer: scoreDiv,
            scoreId: scoreId,
            canvas: div.querySelector('.track-canvas'),
            noteDisplay: div.querySelector('.note-display')
        };
    }

    async setupAudio(sourceBuffer) {
        if (!audioCtx) return;

        // Create Source specifically for this track (we need independent playback for filters)
        // Note: Creating multiple buffer sources is fine, they sync if started together.
        // OR we can share one source and split?
        // Sharing one source is better for sync. But we need to support reconnecting filters.
        // Let's assume we get a fresh SourceNode passed in, OR we connect from a central Splitter?
        // Actually, WebAudio nodes can have multiple outputs.
        // So the main 'sourceNode' in the app can connect to this track's first filter.
        
        // Setup Filters
        this.nodes.filters.bass = audioCtx.createBiquadFilter();
        this.nodes.filters.bass.type = 'lowshelf';
        this.nodes.filters.bass.frequency.value = 250;

        this.nodes.filters.mid = audioCtx.createBiquadFilter();
        this.nodes.filters.mid.type = 'peaking';
        this.nodes.filters.mid.frequency.value = 1000;

        this.nodes.filters.high = audioCtx.createBiquadFilter();
        this.nodes.filters.high.type = 'highshelf';
        this.nodes.filters.high.frequency.value = 4000;

        this.nodes.filters.bandpass = audioCtx.createBiquadFilter();
        this.nodes.filters.bandpass.type = 'bandpass';

        this.nodes.analyser = audioCtx.createAnalyser();
        this.nodes.analyser.fftSize = 2048;

        // Apply initial values
        this.updateFilters();
    }

    // Connects the track's input (the main source) to its filter chain
    connectInput(sourceNode) {
        this.nodes.source = sourceNode;
        this.applyRouting();
        // Also connect analyser to destination so we can hear it?
        // If we have multiple tracks, we might get loud. 
        // Let's connect all tracks to destination so user hears the mix.
        this.nodes.analyser.connect(audioCtx.destination);
    }

    applyRouting() {
        if (!this.nodes.source) return;

        // Disconnect internal chain
        try { this.nodes.source.disconnect(this.nodes.filters.bass); } catch(e){}
        try { this.nodes.source.disconnect(this.nodes.filters.bandpass); } catch(e){}
        try { this.nodes.filters.high.disconnect(); } catch(e){}
        try { this.nodes.filters.bandpass.disconnect(); } catch(e){}

        if (this.settings.filterMode === 'eq') {
            this.nodes.source.connect(this.nodes.filters.bass);
            this.nodes.filters.bass.connect(this.nodes.filters.mid);
            this.nodes.filters.mid.connect(this.nodes.filters.high);
            this.nodes.filters.high.connect(this.nodes.analyser);
        } else {
            this.nodes.source.connect(this.nodes.filters.bandpass);
            this.nodes.filters.bandpass.connect(this.nodes.analyser);
        }
    }

    updateFilters() {
        if (!this.nodes.filters.bass) return;
        
        this.nodes.filters.bass.gain.value = this.settings.eq.bass;
        this.nodes.filters.mid.gain.value = this.settings.eq.mid;
        this.nodes.filters.high.gain.value = this.settings.eq.high;

        this.nodes.filters.bandpass.frequency.value = this.settings.bp.freq;
        this.nodes.filters.bandpass.Q.value = this.settings.bp.q;
    }

    processFrame(now) {
        if (!this.nodes.analyser) return;

        const bufferLength = this.nodes.analyser.frequencyBinCount;
        const dataArray = new Float32Array(bufferLength);
        const byteData = new Uint8Array(bufferLength);
        
        this.nodes.analyser.getFloatTimeDomainData(dataArray);
        this.nodes.analyser.getByteFrequencyData(byteData);

        // Visualize
        const ctx = this.elements.canvas.getContext('2d');
        const w = this.elements.canvas.width;
        const h = this.elements.canvas.height;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        
        const barWidth = (w / bufferLength) * 2.5;
        let barX = 0;
        for(let i = 0; i < bufferLength; i++) {
            const barHeight = (byteData[i] / 255) * h;
            ctx.fillStyle = `rgb(${byteData[i] + 50}, 100, 200)`;
            ctx.fillRect(barX, h - barHeight, barWidth, barHeight);
            barX += barWidth + 1;
        }

        // Pitch Detect
        const frequency = autoCorrelate(dataArray, audioCtx.sampleRate, this.settings.threshold);
        const noteData = frequencyToNote(frequency);

        if (noteData) {
            this.elements.noteDisplay.textContent = noteData.name;
            
            // Rhythm Logic
            if (this.analysis.currentNote && this.analysis.currentNote.name === noteData.name) {
                // Sustaining same note
            } else {
                // Note changed
                this.finalizeNote(now);
                // Start new note
                this.analysis.currentNote = noteData;
                this.analysis.noteStartTime = now;
            }
        } else {
            this.elements.noteDisplay.textContent = "--";
            // Silence/Noise
            if (this.analysis.currentNote) {
                this.finalizeNote(now);
                this.analysis.currentNote = null;
            }
        }
    }

    finalizeNote(now) {
        if (!this.analysis.currentNote) return;

        const durationMs = now - this.analysis.noteStartTime;
        if (durationMs < 100) return; // Ignore glitches < 100ms

        // Determine VexFlow duration
        let vDur = 'q';
        if (durationMs > 2500) vDur = 'w';
        else if (durationMs > 1200) vDur = 'h';
        else if (durationMs > 450) vDur = 'q';
        else if (durationMs > 220) vDur = '8';
        else vDur = '16';

        this.analysis.currentNote.duration = vDur;
        this.renderer.addNote(this.analysis.currentNote);
        
        // Auto scroll
        sheetContainer.scrollLeft = sheetContainer.scrollWidth;
    }

    reset() {
        this.renderer.reset();
        this.renderer.render();
        this.analysis.currentNote = null;
    }
    
    destroy() {
        this.elements.container.remove();
        this.elements.scoreContainer.remove();
        // disconnect nodes...
    }
}

// --- Main App Logic ---

async function initAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }
}

function addTrack(savedState = null) {
    const track = new Track(nextTrackId++, savedState);
    tracks.push(track);
    saveState();
    return track;
}

function removeTrack(id) {
    const idx = tracks.findIndex(t => t.id === id);
    if (idx > -1) {
        tracks[idx].destroy();
        tracks.splice(idx, 1);
        saveState();
    }
}

function saveState() {
    const data = tracks.map(t => t.settings);
    localStorage.setItem('score_transcriber_tracks', JSON.stringify(data));
}

function loadState() {
    const saved = localStorage.getItem('score_transcriber_tracks');
    if (saved) {
        const data = JSON.parse(saved);
        if (Array.isArray(data) && data.length > 0) {
            data.forEach(s => addTrack(s));
            return;
        }
    }
    // Default
    addTrack();
}

let mainSourceNode = null;

async function startPlayback() {
    if (!buffer) return;
    
    if (mainSourceNode) {
        try { mainSourceNode.stop(); } catch(e){}
    }

    mainSourceNode = audioCtx.createBufferSource();
    mainSourceNode.buffer = buffer;

    // Connect Source to ALL tracks
    tracks.forEach(t => {
        t.setupAudio(); 
        t.connectInput(mainSourceNode);
    });

    mainSourceNode.onended = () => {
        isPlaying = false;
        playBtn.disabled = false;
        pauseBtn.disabled = true;
        cancelAnimationFrame(animationId);
    };

    mainSourceNode.start(0);
    isPlaying = true;
    playBtn.disabled = true;
    pauseBtn.disabled = false;

    analyzeLoop();
}

function analyzeLoop() {
    if (!isPlaying) return;
    const now = Date.now();
    tracks.forEach(t => t.processFrame(now));
    animationId = requestAnimationFrame(analyzeLoop);
}

// --- Listeners ---

addTrackBtn.onclick = () => addTrack();

clearBtn.onclick = () => {
    tracks.forEach(t => t.reset());
};

playBtn.onclick = async () => {
    await initAudioContext();
    startPlayback();
};

pauseBtn.onclick = () => {
    if (mainSourceNode) mainSourceNode.stop();
    isPlaying = false;
    playBtn.disabled = false;
    pauseBtn.disabled = true;
};

async function loadFile(file) {
    playBtn.textContent = "Loading...";
    await initAudioContext();
    const ab = await file.arrayBuffer();
    try {
        buffer = await audioCtx.decodeAudioData(ab);
        playBtn.textContent = "▶ Play & Transcribe";
        playBtn.disabled = false;
    } catch(e) {
        alert("Error: " + e);
    }
}

audioInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
});

loadDemoBtn.addEventListener('click', async () => {
    playBtn.textContent = "Loading...";
    await initAudioContext();
    const res = await fetch('demo_piano.mp3');
    const ab = await res.arrayBuffer();
    buffer = await audioCtx.decodeAudioData(ab);
    playBtn.textContent = "▶ Play & Transcribe";
    playBtn.disabled = false;
});

// Init
loadState();