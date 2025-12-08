import { Factory } from "vexflow";

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
        
        // Determine clef approximately
        let clef = "treble";
        if (noteData.octave < 4) clef = "bass";

        this.notesBuffer.push({ keys: [key], duration: "q", clef: clef });
        
        // Limit buffer to fit on screen roughly (last 16 notes)
        if (this.notesBuffer.length > 32) {
            this.notesBuffer.shift();
        }

        this.render();
    }

    render() {
        this.container.innerHTML = ""; // Clear SVG

        // Dynamic width based on note count
        const requiredWidth = Math.max(this.container.clientWidth, this.notesBuffer.length * 40 + 50);

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

        // Construct VexFlow notes
        // We will split into chunks of 4 for bars roughly, just for visualization
        // This is a naive transcription (all quarter notes)

        let notesStr = "";
        const notes = this.notesBuffer.map(n => {
           return this.vf.StaveNote({ keys: n.keys, duration: n.duration, clef: "treble" }); // Force treble for simplicity of single stave, visually adjust later
        });

        // Auto-beaming
        // const voice = score.voice(notes);
        // this.vf.Beam.generateBeams(voice.getTickables());

        // To make it look like a continuous stream, we just add one long stave
        const stave = this.vf.Stave({ x: 10, y: 50, width: requiredWidth - 20 });
        stave.addClef("treble");

        const voice = this.vf.Voice().addTickables(notes);

        // Formatting
        new this.vf.Formatter().joinVoices([voice]).format([voice], requiredWidth - 50);

        stave.setContext(this.vf.getContext()).draw();
        voice.draw(this.vf.getContext(), stave);
    }
}