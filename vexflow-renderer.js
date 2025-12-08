import { Factory, Formatter } from "vexflow";

export class ScoreRenderer {
    constructor(elementId) {
        this.container = document.getElementById(elementId);
        this.notesBuffer = [];
        this.context = null;
        this.vf = null;
        this.width = 600; // Start with decent width
        this.height = 200;
    }

    reset() {
        this.notesBuffer = [];
        this.container.innerHTML = "";
    }

    addNote(noteData) {
        // Debounce/limit: don't add the exact same note consecutively too fast
        // to avoid "C C C C C" for a sustained note.
        // Simple logic: if last note is same, ignore (unless enough time passed - not handled here for simplicity)
        const lastNote = this.notesBuffer[this.notesBuffer.length - 1];
        if (lastNote && lastNote.name === noteData.name) {
            return; 
        }

        // Add to buffer
        // Vexflow keys format: "c/4"
        const key = `${noteData.note.toLowerCase()}/${noteData.octave}`;
        const duration = noteData.duration || "q";
        
        // Determine clef approximately (simple logic)
        let clef = "treble"; 
        
        // Push note
        this.notesBuffer.push({ keys: [key], duration: duration, clef: clef });
        
        // Limit buffer size to prevent memory issues, but allow more for long sequences
        if (this.notesBuffer.length > 50) {
            this.notesBuffer.shift();
        }

        this.render();
    }

    render() {
        if (!this.container) return;
        this.container.innerHTML = ""; // Clear SVG

        // Calculate total beats for width estimation (rough)
        // q=1, h=2, w=4, 8=0.5, 16=0.25
        const durMap = { 'w': 4, 'h': 2, 'q': 1, '8': 0.5, '16': 0.25 };
        let totalBeats = 0;
        this.notesBuffer.forEach(n => totalBeats += (durMap[n.duration] || 1));

        // Dynamic width
        const pixelPerBeat = 50;
        const requiredWidth = Math.max(this.container.clientWidth, totalBeats * pixelPerBeat + 100);

        this.vf = new Factory({
            renderer: { elementId: this.container.id, width: requiredWidth, height: this.height }
        });

        const score = this.vf.EasyScore();
        const system = this.vf.System();

        if (this.notesBuffer.length === 0) {
            // Draw empty stave
            system.addStave({
                voices: [score.voice(score.notes('b4/q/r, b4/q/r, b4/q/r, b4/q/r', { stem: 'up' }))]
            }).addClef('treble').addTimeSignature('4/4');
            this.vf.draw();
            return;
        }

        // Map buffer to VexFlow StaveNotes
        const notes = this.notesBuffer.map(n => {
           return this.vf.StaveNote({ keys: n.keys, duration: n.duration, clef: "treble" });
        });

        // Continuous stave
        const stave = this.vf.Stave({ x: 10, y: 50, width: requiredWidth - 20 });
        stave.addClef("treble");

        // Voice
        const voice = this.vf.Voice({ 
            num_beats: Math.max(1, totalBeats), 
            beat_value: 4 
        });
        
        voice.setStrict(false); // Allow arbitrary beats
        voice.addTickables(notes);

        new Formatter().joinVoices([voice]).format([voice], requiredWidth - 50);

        stave.setContext(this.vf.getContext()).draw();
        voice.draw(this.vf.getContext(), stave);
    }
}