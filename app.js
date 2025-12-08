import { autoCorrelate, frequencyToNote } from './pitch.js';
import { ScoreRenderer } from './vexflow-renderer.js';

// --- State ---
let audioCtx;
let sourceNode;
let buffer;
let isPlaying = false;
let animationId;
let playbackSpeed = 1.0;

// Track Management
let tracks = []; // Array of track objects
// { id, name, settings, nodes, dom }

const renderer = new ScoreRenderer('canvasWrapper');

// --- Elements ---
const audioInput = document.getElementById('audioInput');
const loadDemoBtn = document.getElementById('loadDemoBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const clearBtn = document.getElementById('clearBtn');
const addTrackBtn = document.getElementById('addTrackBtn');
const tracksContainer = document.getElementById('tracksContainer');
const playbackSpeedInput = document.getElementById('playbackSpeed');
const speedDisplay = document.getElementById('speedDisplay');
const canvas = document.getElementById('frequencyCanvas');
const canvasCtx = canvas.getContext('2d');

// --- Initialization ---

// Restore settings or create default
function loadSettings() {
    const saved = localStorage.getItem('audio-to-score-state');
    if (saved) {
        const data = JSON.parse(saved);
        playbackSpeed = data.playbackSpeed || 1.0;
        playbackSpeedInput.value = playbackSpeed;
        speedDisplay.textContent = playbackSpeed;
        
        if (data.tracks && data.tracks.length > 0) {
            data.tracks.forEach(t => createTrack(t));
        } else {
            createTrack(); // Default one track
        }
    } else {
        createTrack(); // Default
    }
}

function saveSettings() {
    const data = {
        playbackSpeed: playbackSpeed,
        tracks: tracks.map(t => ({
            id: t.id,
            name: t.name,
            settings: t.settings
        }))
    };
    localStorage.setItem('audio-to-score-state', JSON.stringify(data));
}

async function initAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }
}

function createUUID() {
    return 'track_' + Math.random().toString(36).substr(2, 9);
}

// Create a new Track Controller
function createTrack(savedData = null) {
    const id = savedData ? savedData.id : createUUID();
    const settings = savedData ? savedData.settings : {
        name: "Instrument " + (tracks.length + 1),
        threshold: 0.03,
        mode: 'eq',
        eq: { low: 0, mid: 0, high: 0 },
        bp: { freq: 1000, q: 1.0 },
        auto: false
    };

    const trackEl = document.createElement('div');
    trackEl.className = 'mixer-area track-module';
    trackEl.id = id;
    trackEl.innerHTML = `
        <div class="track-header">
            <input type="text" class="track-name-input" value="${settings.name}" />
            <button class="btn btn-sm remove-track-btn" ${tracks.length === 0 ? 'disabled' : ''}>×</button>
        </div>
        <p class="small-text">Isolation Filters</p>
        
        <div class="filter-controls">
            <div class="control-row">
                <label>Detection Threshold</label>
                <input type="range" class="threshold-input" min="0" max="0.2" step="0.001" value="${settings.threshold}">
            </div>
            
            <div class="control-row mode-select">
                <label>Filter Mode:</label>
                <select class="filter-mode-select">
                    <option value="eq" ${settings.mode === 'eq' ? 'selected' : ''}>3-Band EQ</option>
                    <option value="bandpass" ${settings.mode === 'bandpass' ? 'selected' : ''}>Bandpass Focus</option>
                </select>
            </div>

            <!-- EQ Controls -->
            <div class="sliders eq-controls ${settings.mode === 'eq' ? '' : 'hidden'}">
                <div class="slider-group">
                    <label>Low</label>
                    <input type="range" class="bass-gain" min="-30" max="10" value="${settings.eq.low}">
                </div>
                <div class="slider-group">
                    <label>Mid</label>
                    <input type="range" class="mid-gain" min="-30" max="10" value="${settings.eq.mid}">
                </div>
                <div class="slider-group">
                    <label>High</label>
                    <input type="range" class="high-gain" min="-30" max="10" value="${settings.eq.high}">
                </div>
            </div>

            <!-- Bandpass Controls -->
            <div class="sliders bandpass-controls ${settings.mode === 'bandpass' ? '' : 'hidden'}">
                <div class="slider-group wide">
                    <label>Freq (<span class="freq-val">${settings.bp.freq}</span>Hz)</label>
                    <input type="range" class="bp-freq" min="50" max="5000" step="10" value="${settings.bp.freq}">
                </div>
                <div class="slider-group">
                    <label>Width (Q)</label>
                    <input type="range" class="bp-q" min="0.1" max="10" step="0.1" value="${settings.bp.q}">
                </div>
            </div>
        </div>
    `;

    tracksContainer.appendChild(trackEl);

    // Bind DOM events for this track
    const dom = {
        name: trackEl.querySelector('.track-name-input'),
        removeBtn: trackEl.querySelector('.remove-track-btn'),
        threshold: trackEl.querySelector('.threshold-input'),
        modeSelect: trackEl.querySelector('.filter-mode-select'),
        eqControls: trackEl.querySelector('.eq-controls'),
        bpControls: trackEl.querySelector('.bandpass-controls'),
        bass: trackEl.querySelector('.bass-gain'),
        mid: trackEl.querySelector('.mid-gain'),
        high: trackEl.querySelector('.high-gain'),
        bpFreq: trackEl.querySelector('.bp-freq'),
        bpQ: trackEl.querySelector('.bp-q'),
        freqDisplay: trackEl.querySelector('.freq-val')
    };

    const trackObj = {
        id,
        settings,
        dom,
        nodes: null, // Initialized on play
        lastNoteTime: 0
    };

    tracks.push(trackObj);
    renderer.registerTrack(id, settings.name);
    renderer.render();

    // Event Listeners for UI changes
    dom.name.addEventListener('change', (e) => {
        trackObj.settings.name = e.target.value;
        renderer.registerTrack(id, e.target.value);
        renderer.render();
        saveSettings();
    });

    dom.removeBtn.addEventListener('click', () => {
        if(tracks.length <= 1) return; // Keep at least one
        tracksContainer.removeChild(trackEl);
        tracks = tracks.filter(t => t.id !== id);
        renderer.removeTrack(id);
        saveSettings();
    });

    dom.modeSelect.addEventListener('change', (e) => {
        trackObj.settings.mode = e.target.value;
        if (e.target.value === 'eq') {
            dom.eqControls.classList.remove('hidden');
            dom.bpControls.classList.add('hidden');
        } else {
            dom.eqControls.classList.add('hidden');
            dom.bpControls.classList.remove('hidden');
        }
        updateTrackAudioRouting(trackObj);
        saveSettings();
    });

    // Update settings objects and realtime audio params
    const updateSettings = () => {
        trackObj.settings.threshold = parseFloat(dom.threshold.value);
        trackObj.settings.eq.low = parseFloat(dom.bass.value);
        trackObj.settings.eq.mid = parseFloat(dom.mid.value);
        trackObj.settings.eq.high = parseFloat(dom.high.value);
        trackObj.settings.bp.freq = parseFloat(dom.bpFreq.value);
        trackObj.settings.bp.q = parseFloat(dom.bpQ.value);
        dom.freqDisplay.textContent = dom.bpFreq.value;
        
        applyFilterValues(trackObj);
        saveSettings();
    };

    [dom.threshold, dom.bass, dom.mid, dom.high, dom.bpFreq, dom.bpQ].forEach(input => {
        input.addEventListener('input', updateSettings);
    });

    // If playing, we need to hot-initialize this track's audio
    if (isPlaying && sourceNode) {
        initTrackAudio(trackObj, sourceNode);
    }
}

// Initialize WebAudio nodes for a specific track
function initTrackAudio(track, source) {
    // Clean up old if exists
    if (track.nodes) {
        try { track.nodes.analyser.disconnect(); } catch(e){}
    }

    const nodes = {};

    // Filters
    nodes.bass = audioCtx.createBiquadFilter();
    nodes.bass.type = 'lowshelf';
    nodes.bass.frequency.value = 250;

    nodes.mid = audioCtx.createBiquadFilter();
    nodes.mid.type = 'peaking';
    nodes.mid.frequency.value = 1000;

    nodes.high = audioCtx.createBiquadFilter();
    nodes.high.type = 'highshelf';
    nodes.high.frequency.value = 4000;

    nodes.bandpass = audioCtx.createBiquadFilter();
    nodes.bandpass.type = 'bandpass';

    // Analyser
    nodes.analyser = audioCtx.createAnalyser();
    nodes.analyser.fftSize = 2048;
    nodes.analyser.smoothingTimeConstant = 0.5;

    track.nodes = nodes;
    
    // Initial Value Apply
    applyFilterValues(track);
    updateTrackAudioRouting(track);
}

function applyFilterValues(track) {
    if (!track.nodes) return;
    const { settings, nodes } = track;

    nodes.bass.gain.value = settings.eq.low;
    nodes.mid.gain.value = settings.eq.mid;
    nodes.high.gain.value = settings.eq.high;

    nodes.bandpass.frequency.value = settings.bp.freq;
    nodes.bandpass.Q.value = settings.bp.q;
}

function updateTrackAudioRouting(track) {
    if (!track.nodes || !sourceNode) return;
    const { nodes, settings } = track;

    // Disconnect internal chains
    try { sourceNode.disconnect(nodes.bass); } catch(e){}
    try { sourceNode.disconnect(nodes.bandpass); } catch(e){}
    try { nodes.high.disconnect(); } catch(e){}
    try { nodes.bandpass.disconnect(); } catch(e){}

    if (settings.mode === 'eq') {
        sourceNode.connect(nodes.bass);
        nodes.bass.connect(nodes.mid);
        nodes.mid.connect(nodes.high);
        nodes.high.connect(nodes.analyser);
    } else {
        sourceNode.connect(nodes.bandpass);
        nodes.bandpass.connect(nodes.analyser);
    }

    // Connect analyser to speakers so we can hear the mix of all tracks
    // (Or maybe we want to normalize gain? For now simple connection)
    // NOTE: Connecting multiple tracks to destination increases volume. 
    // We might want a gain node for master.
    try { nodes.analyser.connect(audioCtx.destination); } catch(e){}
}


async function setupAudioChain(audioBuffer) {
    if (sourceNode) {
        try { sourceNode.disconnect(); sourceNode.stop(); } catch(e){}
    }

    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.playbackRate.value = playbackSpeed;

    // Initialize audio for all tracks
    tracks.forEach(track => {
        initTrackAudio(track, sourceNode);
    });

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

// --- Analysis Loop ---
const NOTE_THRESHOLD_MS = 200; // slightly faster for multi-track

function analyzeLoop() {
    if (!isPlaying) return;

    // We need to visualize something. Let's visualize the FIRST track for now, 
    // or a sum. Visualizing the first active track is simplest for UI.
    if (tracks.length > 0 && tracks[0].nodes) {
        drawVisualizer(tracks[0].nodes.analyser, tracks[0].settings.threshold);
    }

    // Analyze Pitch for ALL tracks
    tracks.forEach(track => {
        if (!track.nodes) return;

        const analyser = track.nodes.analyser;
        const dataArray = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatTimeDomainData(dataArray);

        // Compensate for playback speed!
        // If speed is 0.5, pitch drops an octave (freq * 0.5).
        // We detect the dropped pitch.
        // To get original note, we must divide detected freq by speed.
        // e.g. Detected 220Hz at 0.5x speed -> Original was 440Hz.
        
        let frequency = autoCorrelate(dataArray, audioCtx.sampleRate, track.settings.threshold);
        
        if (frequency !== -1) {
            // Apply speed compensation
            frequency = frequency / playbackSpeed;
            
            const noteData = frequencyToNote(frequency);
            
            if (noteData) {
                const now = Date.now();
                // Simple debouncing per track
                if (now - track.lastNoteTime > (NOTE_THRESHOLD_MS / playbackSpeed)) { // Adjust threshold for speed too
                     track.lastNoteTime = now;
                     renderer.addNote(noteData, track.id);
                     
                     // Scroll
                     const container = document.getElementById('sheetContainer');
                     // Only auto scroll if near end? 
                     container.scrollLeft = container.scrollWidth;
                }
            }
        }
    });

    animationId = requestAnimationFrame(analyzeLoop);
}

function drawVisualizer(analyser, threshold) {
    const bufferLength = analyser.frequencyBinCount;
    const byteData = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(byteData);

    canvasCtx.fillStyle = '#000';
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
    
    const barWidth = (canvas.width / bufferLength) * 2.5;
    let barX = 0;

    for(let i = 0; i < bufferLength; i++) {
        const barHeight = (byteData[i] / 255) * canvas.height;
        canvasCtx.fillStyle = `rgb(${byteData[i] + 50}, 100, 200)`;
        canvasCtx.fillRect(barX, canvas.height - barHeight, barWidth, barHeight);
        barX += barWidth + 1;
    }

    // Threshold line
    const displayThresh = Math.min(1, threshold * 5); 
    const threshY = canvas.height - (displayThresh * canvas.height); 
    canvasCtx.strokeStyle = 'rgba(255, 50, 50, 0.7)';
    canvasCtx.beginPath();
    canvasCtx.moveTo(0, threshY);
    canvasCtx.lineTo(canvas.width, threshY);
    canvasCtx.stroke();
}


// --- Global Event Listeners ---

playbackSpeedInput.addEventListener('input', (e) => {
    playbackSpeed = parseFloat(e.target.value);
    speedDisplay.textContent = playbackSpeed.toFixed(1);
    if (sourceNode) {
        sourceNode.playbackRate.value = playbackSpeed;
    }
    saveSettings();
});

addTrackBtn.addEventListener('click', () => {
    createTrack();
    saveSettings();
});

async function loadFile(file) {
    playBtn.textContent = "Loading...";
    playBtn.disabled = true;

    await initAudioContext();
    const arrayBuffer = await file.arrayBuffer();

    try {
        buffer = await audioCtx.decodeAudioData(arrayBuffer);
        playBtn.textContent = "▶ Play & Transcribe";
        playBtn.disabled = false;
        renderer.reset();
        renderer.render();
    } catch(e) {
        alert("Error decoding audio file. " + e);
        playBtn.textContent = "Error";
    }
}

audioInput.addEventListener('change', (e) => {
    if (e.target.files[0]) {
        loadFile(e.target.files[0]);
    }
});

loadDemoBtn.addEventListener('click', async () => {
    playBtn.textContent = "Loading Demo...";
    await initAudioContext();
    const response = await fetch('demo_piano.mp3');
    const arrayBuffer = await response.arrayBuffer();
    buffer = await audioCtx.decodeAudioData(arrayBuffer);
    playBtn.textContent = "▶ Play & Transcribe";
    playBtn.disabled = false;
    renderer.reset();
    renderer.render();
});

playBtn.addEventListener('click', async () => {
    if (!buffer) return;
    await initAudioContext();
    setupAudioChain(buffer);
});

pauseBtn.addEventListener('click', () => {
    if (sourceNode) {
        sourceNode.stop();
        isPlaying = false;
        playBtn.disabled = false;
        pauseBtn.disabled = true;
    }
});

clearBtn.addEventListener('click', () => {
    renderer.reset();
    renderer.render();
});

// Init
loadSettings();
setTimeout(() => renderer.render(), 500);