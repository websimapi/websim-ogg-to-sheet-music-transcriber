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
let isAutoFilterMode = false; // State for auto mode
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
        sourceNode.disconnect();
        sourceNode.stop();
    }

    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;

    // Create pre-analyser for Auto Mode detection
    preAnalyser = audioCtx.createAnalyser();
    preAnalyser.fftSize = 2048;
    sourceNode.connect(preAnalyser);

    // Create filters (Eq)
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

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;

    // Connect chain: Source -> Bass -> Mid -> High -> Analyser -> Destination
    sourceNode.connect(bassFilter);
    bassFilter.connect(midFilter);
    midFilter.connect(highFilter);
    highFilter.connect(analyser);
    highFilter.connect(audioCtx.destination); // Connect last filter to speakers

    filters = { bass: bassFilter, mid: midFilter, high: highFilter };
    
    // Reset sliders or update filters based on current UI
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

function updateFilters() {
    if(!filters.bass) return;
    
    // In auto mode, we don't read from sliders, we write to them (visually) 
    // but the actual values are set in the loop. 
    // However, if manual, we read sliders.
    if (!isAutoFilterMode) {
        filters.bass.gain.value = parseFloat(bassInput.value);
        filters.mid.gain.value = parseFloat(midInput.value);
        filters.high.gain.value = parseFloat(highInput.value);
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

    // 1. Visualizer (Oscilloscope)
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    analyser.getFloatTimeDomainData(dataArray);

    canvasCtx.fillStyle = 'rgb(0, 0, 0)';
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = 'rgb(92, 107, 192)'; // Primary color
    canvasCtx.beginPath();

    const sliceWidth = canvas.width * 1.0 / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] * 200.0; // amplify for visual
        const y = canvas.height / 2 + v;

        if (i === 0) canvasCtx.moveTo(x, y);
        else canvasCtx.lineTo(x, y);
        x += sliceWidth;
    }
    canvasCtx.lineTo(canvas.width, canvas.height / 2);
    canvasCtx.stroke();

    // 2. Pitch Detection
    const frequency = autoCorrelate(dataArray, audioCtx.sampleRate);
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
    if (isAutoFilterMode) {
        bassInput.disabled = true;
        midInput.disabled = true;
        highInput.disabled = true;
    } else {
        bassInput.disabled = false;
        midInput.disabled = false;
        highInput.disabled = false;
        // Snap filters back to slider values immediately
        updateFilters();
    }
});

// EQ Listeners
bassInput.addEventListener('input', updateFilters);
midInput.addEventListener('input', updateFilters);
highInput.addEventListener('input', updateFilters);

// Initial render of empty stave
setTimeout(() => renderer.render(), 500);