import { autoCorrelate, frequencyToNote } from './pitch.js';
import { ScoreRenderer } from './vexflow-renderer.js';

// --- State ---
let audioCtx;
let sourceNode;
let analyser;
let buffer;
let isPlaying = false;
let animationId;
let filters = {};
const renderer = new ScoreRenderer('canvasWrapper');

// --- Elements ---
const audioInput = document.getElementById('audioInput');
const loadDemoBtn = document.getElementById('loadDemoBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const clearBtn = document.getElementById('clearBtn');
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
    filters.bass.gain.value = parseFloat(bassInput.value);
    filters.mid.gain.value = parseFloat(midInput.value);
    filters.high.gain.value = parseFloat(highInput.value);
}

// --- Analysis & Render Loop ---
let lastNoteTime = 0;
const NOTE_THRESHOLD_MS = 250; // Minimum time between new notes (approx 16th note at 60bpm)

function analyzeLoop() {
    if (!isPlaying) return;

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

        // Add to sheet music if enough time has passed and note is stable
        const now = Date.now();
        if (now - lastNoteTime > NOTE_THRESHOLD_MS) {
            renderer.addNote(noteData);
            lastNoteTime = now;

            // Auto scroll to right
            const container = document.getElementById('sheetContainer');
            container.scrollLeft = container.scrollWidth;
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

// EQ Listeners
bassInput.addEventListener('input', updateFilters);
midInput.addEventListener('input', updateFilters);
highInput.addEventListener('input', updateFilters);

// Initial render of empty stave
setTimeout(() => renderer.render(), 500);