import { Factory, Formatter } from "vexflow";

export class ScoreRenderer {
    constructor(elementId) {
        this.container = document.getElementById(elementId);
        this.tracks = {}; // { trackId: { notes: [], name: '...' } }
        this.context = null;
        this.vf = null;
        this.width = 600;
        this.height = 200; // Will be dynamic
    }

    reset() {
        for(let id in this.tracks) {
            this.tracks[id].notes = [];
        }
        this.container.innerHTML = "";
    }

    registerTrack(id, name) {
        if (!this.tracks[id]) {
            this.tracks[id] = { notes: [], name: name || `Part ${id}` };
        } else {
            this.tracks[id].name = name;
        }
    }

    removeTrack(id) {
        delete this.tracks[id];
        this.render();
    }

    addNote(noteData, trackId) {
        if (!this.tracks[trackId]) return;

        const buffer = this.tracks[trackId].notes;
        const lastNote = buffer[buffer.length - 1];
        
        if (lastNote && lastNote.name === noteData.name) {
            return; 
        }

        const key = `${noteData.note.toLowerCase()}/${noteData.octave}`;
        let clef = "treble";
        if (noteData.octave < 3) clef = "bass"; // Better clef split

        buffer.push({ keys: [key], duration: "q", clef: clef, noteData: noteData });
        
        if (buffer.length > 32) {
            buffer.shift();
        }

        this.render();
    }

    render() {
        this.container.innerHTML = "";
        
        const trackIds = Object.keys(this.tracks);
        if (trackIds.length === 0) return;

        // Calculate max notes to determine width
        let maxNotes = 0;
        trackIds.forEach(id => {
            if(this.tracks[id].notes.length > maxNotes) maxNotes = this.tracks[id].notes.length;
        });

        const requiredWidth = Math.max(this.container.clientWidth, maxNotes * 40 + 100);
        const staveHeight = 120;
        const totalHeight = trackIds.length * staveHeight + 50;

        this.vf = new Factory({
            renderer: { elementId: this.container.id, width: requiredWidth, height: totalHeight }
        });

        const context = this.vf.getContext();
        let yPos = 20;

        trackIds.forEach((id, index) => {
            const track = this.tracks[id];
            
            // Draw Stave
            const stave = this.vf.Stave({ x: 10, y: yPos, width: requiredWidth - 20 });
            
            // Determine clef based on majority of notes or default to treble
            // Simple logic: just force treble for now unless majority are low, but dynamic clef is tricky in single stave
            stave.addClef("treble");
            stave.setText(track.name, 'default', { shift_y: -10 });
            
            stave.setContext(context).draw();

            if (track.notes.length > 0) {
                const notes = track.notes.map(n => {
                    return this.vf.StaveNote({ keys: n.keys, duration: n.duration, clef: "treble" });
                });

                const voice = this.vf.Voice({ 
                    num_beats: Math.max(1, track.notes.length), 
                    beat_value: 4 
                });
                
                voice.setStrict(false);
                voice.addTickables(notes);

                new Formatter().joinVoices([voice]).format([voice], requiredWidth - 50);
                voice.draw(context, stave);
            }

            yPos += staveHeight;
        });
    }
}