import { autoCorrelate, frequencyToNote } from './pitch.js';
import { ScoreRenderer } from './vexflow-renderer.js';

// --- State ---
let audioCtx;
let sourceNode;
let analyser;
let preAnalyser; // Analyser before filters for detection
let buffer;
let isPlaying = false;
let animationId;
let filters = {};
let bandpassFilter;
let isAutoFilterMode = false; 
let filterMode = 'eq'; // 'eq' or 'bandpass'
const renderer = new ScoreRenderer('canvasWrapper');

// --- Elements ---
const audioInput = document.getElementById('audioInput');
const loadDemoBtn = document.getElementById('loadDemoBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const clearBtn = document.getElementById('clearBtn');
const autoFilterBtn = document.getElementById('autoFilterBtn');
const bassInput = document.getElementById('bassGain');
const midInput = document.getElementById('midGain');
const highInput = document.getElementById('highGain');
const noteDisplay = document.getElementById('currentNote');
const canvas = document.getElementById('frequencyCanvas');
const canvasCtx = canvas.getContext('2d');

// New Controls
const thresholdInput = document.getElementById('thresholdInput');
const filterModeSelect = document.getElementById('filterMode');
const eqControls = document.getElementById('eqControls');
const bandpassControls = document.getElementById('bandpassControls');
const bpFreqInput = document.getElementById('bpFreq');
const bpQInput = document.getElementById('bpQ');
const freqValDisplay = document.getElementById('freqVal');

// --- Initialization ---
async function initAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }
}

async function setupAudioChain(audioBuffer) {
    if (sourceNode) {
        try { sourceNode.disconnect(); sourceNode.stop(); } catch(e){}
    }

    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;

    // 1. Pre-analyser (for Auto Logic source)
    preAnalyser = audioCtx.createAnalyser();
    preAnalyser.fftSize = 2048;
    sourceNode.connect(preAnalyser);

    // 2. Create EQ Filters
    const bassFilter = audioCtx.createBiquadFilter();
    bassFilter.type = 'lowshelf';
    bassFilter.frequency.value = 250;

    const midFilter = audioCtx.createBiquadFilter();
    midFilter.type = 'peaking';
    midFilter.frequency.value = 1000;
    midFilter.Q.value = 1.0;

    const highFilter = audioCtx.createBiquadFilter();
    highFilter.type = 'highshelf';
    highFilter.frequency.value = 4000;

    // Chain EQ: Source -> Bass -> Mid -> High
    // We won't connect High to analyser yet, we do that dynamically

    // 3. Create Bandpass Filter
    bandpassFilter = audioCtx.createBiquadFilter();
    bandpassFilter.type = 'bandpass';
    bandpassFilter.frequency.value = parseFloat(bpFreqInput.value);
    bandpassFilter.Q.value = parseFloat(bpQInput.value);

    // 4. Analyser (Final output node before destination)
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.5;

    // Store filters
    filters = { bass: bassFilter, mid: midFilter, high: highFilter };
    
    // 5. Connect based on current mode
    applyRouting();

    // 6. Connect Analyser to Speakers
    analyser.connect(audioCtx.destination);

    // Reset sliders
    updateFilters();

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

function applyRouting() {
    if (!sourceNode || !filters.bass) return;

    // Disconnect everything first to be safe
    try { sourceNode.disconnect(filters.bass); } catch(e){}
    try { sourceNode.disconnect(bandpassFilter); } catch(e){}
    try { filters.high.disconnect(); } catch(e){}
    try { bandpassFilter.disconnect(); } catch(e){}

    // Reconnect pre-analyser (always connected)
    sourceNode.connect(preAnalyser);

    if (filterMode === 'eq') {
        // Source -> Bass -> Mid -> High -> Analyser
        sourceNode.connect(filters.bass);
        filters.bass.connect(filters.mid);
        filters.mid.connect(filters.high);
        filters.high.connect(analyser);
    } else {
        // Source -> Bandpass -> Analyser
        sourceNode.connect(bandpassFilter);
        bandpassFilter.connect(analyser);
    }
}

function updateFilters() {
    if(!filters.bass) return;
    
    // EQ Updates
    if (!isAutoFilterMode) {
        filters.bass.gain.value = parseFloat(bassInput.value);
        filters.mid.gain.value = parseFloat(midInput.value);
        filters.high.gain.value = parseFloat(highInput.value);
    }

    // Bandpass Updates
    if (bandpassFilter) {
        bandpassFilter.frequency.value = parseFloat(bpFreqInput.value);
        bandpassFilter.Q.value = parseFloat(bpQInput.value);
        freqValDisplay.textContent = bpFreqInput.value;
    }
}

// Helper to smooth values
function lerp(start, end, amt) {
    return (1 - amt) * start + amt * end;
}

// --- Analysis & Render Loop ---
let lastNoteTime = 0;
const NOTE_THRESHOLD_MS = 250; // Minimum time between new notes (approx 16th note at 60bpm)

function analyzeLoop() {
    if (!isPlaying) return;

    // --- Auto Filter Logic ---
    if (isAutoFilterMode && preAnalyser && filters.bass) {
        const preBufferLength = preAnalyser.frequencyBinCount;
        const preData = new Uint8Array(preBufferLength);
        preAnalyser.getByteFrequencyData(preData);

        // Calculate energy in bands
        // Bin size = 44100 / 2048 = ~21.5 Hz
        // Bass: 0 - 250Hz -> bins 0 - 11
        // Mid: 250 - 4000Hz -> bins 12 - 185
        // High: 4000Hz+ -> bins 186 - 1023
        
        let bassEnergy = 0;
        let midEnergy = 0;
        let highEnergy = 0;

        for (let i = 0; i < 12; i++) bassEnergy += preData[i];
        for (let i = 12; i < 186; i++) midEnergy += preData[i];
        for (let i = 186; i < preBufferLength; i++) highEnergy += preData[i];

        // Normalize (Average energy per bin)
        bassEnergy /= 12;
        midEnergy /= (186 - 12);
        highEnergy /= (preBufferLength - 186);

        // Determine targets based on dominance
        // We boost the dominant and cut the others slightly
        let targetBass = -10;
        let targetMid = -10;
        let targetHigh = -10;

        if (bassEnergy > midEnergy && bassEnergy > highEnergy) {
            targetBass = 5;
        } else if (midEnergy > bassEnergy && midEnergy > highEnergy) {
            targetMid = 5;
        } else {
            targetHigh = 5;
        }

        // Apply with smoothing (lerp)
        const smoothFactor = 0.1;
        filters.bass.gain.value = lerp(filters.bass.gain.value, targetBass, smoothFactor);
        filters.mid.gain.value = lerp(filters.mid.gain.value, targetMid, smoothFactor);
        filters.high.gain.value = lerp(filters.high.gain.value, targetHigh, smoothFactor);

        // Update UI sliders to reflect what's happening
        bassInput.value = filters.bass.gain.value;
        midInput.value = filters.mid.gain.value;
        highInput.value = filters.high.gain.value;
    }

    // 1. Visualizer (Spectrum)
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    const byteData = new Uint8Array(bufferLength);
    
    // Get time domain for pitch detection (needs waveform)
    analyser.getFloatTimeDomainData(dataArray);
    
    // Get freq domain for visualization (needs spectrum)
    analyser.getByteFrequencyData(byteData);

    canvasCtx.fillStyle = '#000';
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
    
    const barWidth = (canvas.width / bufferLength) * 2.5;
    let barX = 0;

    // Draw Frequency Bars
    for(let i = 0; i < bufferLength; i++) {
        const barHeight = (byteData[i] / 255) * canvas.height;
        
        // Color based on height/intensity
        canvasCtx.fillStyle = `rgb(${byteData[i] + 50}, 100, 200)`;
        canvasCtx.fillRect(barX, canvas.height - barHeight, barWidth, barHeight);

        barX += barWidth + 1;
    }

    // Overlay Detection Threshold Line (Approximation for Visual Feedback)
    const threshVal = parseFloat(thresholdInput.value);
    // Visualize threshold just as a static line
    // Since threshold is RMS amplitude (0-1) and this is FFT, it's not 1:1, 
    // but useful to show the user "higher is less sensitive"
    const displayThresh = Math.min(1, threshVal * 5); // scale for display
    const threshY = canvas.height - (displayThresh * canvas.height); 
    
    canvasCtx.strokeStyle = 'rgba(255, 50, 50, 0.7)';
    canvasCtx.beginPath();
    canvasCtx.moveTo(0, threshY);
    canvasCtx.lineTo(canvas.width, threshY);
    canvasCtx.stroke();

    // 2. Pitch Detection
    const frequency = autoCorrelate(dataArray, audioCtx.sampleRate, threshVal);
    const noteData = frequencyToNote(frequency);

    if (noteData) {
        noteDisplay.textContent = `${noteData.name} (${Math.round(noteData.frequency)}Hz)`;

        // Only add note if confidence/volume is decent (simple gate)
        // using existing pitch logic
        const now = Date.now();
        if (now - lastNoteTime > NOTE_THRESHOLD_MS) {
            try {
                renderer.addNote(noteData);
                lastNoteTime = now;

                // Auto scroll to right
                const container = document.getElementById('sheetContainer');
                container.scrollLeft = container.scrollWidth;
            } catch (e) {
                console.error("Sheet music rendering error:", e);
            }
        }
    } else {
        noteDisplay.textContent = "--";
    }

    animationId = requestAnimationFrame(analyzeLoop);
}

// --- Event Listeners ---

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
        // Draw empty stave
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

// Auto Filter Listener
autoFilterBtn.addEventListener('change', (e) => {
    isAutoFilterMode = e.target.checked;
    bassInput.disabled = isAutoFilterMode;
    midInput.disabled = isAutoFilterMode;
    highInput.disabled = isAutoFilterMode;
    if(!isAutoFilterMode) updateFilters();
});

// Filter Mode Switch
filterModeSelect.addEventListener('change', (e) => {
    filterMode = e.target.value;
    if (filterMode === 'eq') {
        eqControls.classList.remove('hidden');
        bandpassControls.classList.add('hidden');
    } else {
        eqControls.classList.add('hidden');
        bandpassControls.classList.remove('hidden');
    }
    applyRouting();
});

// EQ Listeners
bassInput.addEventListener('input', updateFilters);
midInput.addEventListener('input', updateFilters);
highInput.addEventListener('input', updateFilters);

// Bandpass Listeners
bpFreqInput.addEventListener('input', updateFilters);
bpQInput.addEventListener('input', updateFilters);

// Initial render of empty stave
setTimeout(() => renderer.render(), 500);