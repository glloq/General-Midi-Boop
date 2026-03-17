// ============================================================================
// Fichier: public/js/utils/CommandHistory.js
// Description: Système d'historique Undo/Redo basé sur Command Pattern
// ============================================================================

/**
 * Classe de base pour toutes les commandes
 */
class Command {
    constructor() {
        this.timestamp = Date.now();
    }

    execute() {
        throw new Error('execute() must be implemented');
    }

    undo() {
        throw new Error('undo() must be implemented');
    }

    toString() {
        return this.constructor.name;
    }
}

/**
 * Commande: Ajouter une note
 */
class AddNoteCommand extends Command {
    constructor(pianoRoll, note) {
        super();
        this.pianoRoll = pianoRoll;
        this.note = { ...note }; // Deep copy
    }

    execute() {
        if (!this.pianoRoll.sequence) {
            this.pianoRoll.sequence = [];
        }
        this.pianoRoll.sequence.push(this.note);
        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }
        return true;
    }

    undo() {
        if (!this.pianoRoll.sequence) return false;
        const index = this.pianoRoll.sequence.findIndex(n =>
            n.t === this.note.t && n.n === this.note.n && n.c === this.note.c
        );
        if (index >= 0) {
            this.pianoRoll.sequence.splice(index, 1);
            if (typeof this.pianoRoll.redraw === 'function') {
                this.pianoRoll.redraw();
            }
            return true;
        }
        return false;
    }

    toString() {
        return `Ajouter note ${this.note.n}`;
    }
}

/**
 * Commande: Supprimer des notes
 */
class DeleteNotesCommand extends Command {
    constructor(pianoRoll, notes) {
        super();
        this.pianoRoll = pianoRoll;
        this.notes = notes.map(n => ({ ...n })); // Deep copy
    }

    execute() {
        if (!this.pianoRoll.sequence) return false;

        // Collect indices to remove, then splice in reverse order to avoid index shifting
        const indicesToRemove = [];
        this.notes.forEach(note => {
            const index = this.pianoRoll.sequence.findIndex(n =>
                n.t === note.t && n.n === note.n && n.c === note.c
            );
            if (index >= 0) {
                indicesToRemove.push(index);
            }
        });
        indicesToRemove.sort((a, b) => b - a);
        indicesToRemove.forEach(index => {
            this.pianoRoll.sequence.splice(index, 1);
        });

        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }
        return true;
    }

    undo() {
        if (!this.pianoRoll.sequence) {
            this.pianoRoll.sequence = [];
        }

        // Rajouter les notes
        this.notes.forEach(note => {
            this.pianoRoll.sequence.push({ ...note });
        });

        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }
        return true;
    }

    toString() {
        return `Supprimer ${this.notes.length} note(s)`;
    }
}

/**
 * Commande: Déplacer des notes
 */
class MoveNotesCommand extends Command {
    constructor(pianoRoll, notes, deltaT, deltaN) {
        super();
        this.pianoRoll = pianoRoll;
        // Store immutable original coordinates for reliable undo
        this.originalCoords = notes.map(n => ({ t: n.t, n: n.n, c: n.c }));
        this.deltaT = deltaT;
        this.deltaN = deltaN;
        this.applied = false;
    }

    execute() {
        if (!this.pianoRoll.sequence) return false;

        // Search using the coordinates BEFORE this move
        const searchCoords = this.applied
            ? this.originalCoords.map(c => ({ t: c.t, n: c.n, c: c.c }))
            : this.originalCoords;

        searchCoords.forEach(coord => {
            const searchT = this.applied ? coord.t : coord.t;
            const searchN = this.applied ? coord.n : coord.n;
            const seqNote = this.pianoRoll.sequence.find(n =>
                n.t === searchT && n.n === searchN && n.c === coord.c
            );
            if (seqNote) {
                seqNote.t = coord.t + this.deltaT;
                seqNote.n = coord.n + this.deltaN;
            }
        });

        this.applied = true;
        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }
        return true;
    }

    undo() {
        if (!this.pianoRoll.sequence) return false;

        // After execute, notes are at original + delta; search for those
        this.originalCoords.forEach(coord => {
            const movedT = coord.t + this.deltaT;
            const movedN = coord.n + this.deltaN;
            const seqNote = this.pianoRoll.sequence.find(n =>
                n.t === movedT && n.n === movedN && n.c === coord.c
            );
            if (seqNote) {
                seqNote.t = coord.t;
                seqNote.n = coord.n;
            }
        });

        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }
        return true;
    }

    toString() {
        return `Déplacer ${this.originalCoords.length} note(s)`;
    }
}

/**
 * Commande: Modifier le canal de notes
 */
class ChangeChannelCommand extends Command {
    constructor(pianoRoll, notes, newChannel) {
        super();
        this.pianoRoll = pianoRoll;
        this.notes = notes.map(n => ({ ...n })); // Deep copy avec ancien canal
        this.oldChannels = notes.map(n => n.c);
        this.newChannel = newChannel;
    }

    execute() {
        if (!this.pianoRoll.sequence) return false;

        this.notes.forEach((note, i) => {
            const seqNote = this.pianoRoll.sequence.find(n =>
                n.t === note.t && n.n === note.n && n.c === this.oldChannels[i]
            );
            if (seqNote) {
                seqNote.c = this.newChannel;
            }
        });

        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }
        return true;
    }

    undo() {
        if (!this.pianoRoll.sequence) return false;

        this.notes.forEach((note, i) => {
            const seqNote = this.pianoRoll.sequence.find(n =>
                n.t === note.t && n.n === note.n && n.c === this.newChannel
            );
            if (seqNote) {
                seqNote.c = this.oldChannels[i];
            }
        });

        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }
        return true;
    }

    toString() {
        return `Changer canal de ${this.notes.length} note(s)`;
    }
}

/**
 * Gestionnaire d'historique des commandes
 */
class CommandHistory {
    constructor(maxSize = 100) {
        this.undoStack = [];
        this.redoStack = [];
        this.maxSize = maxSize;
        this.enabled = true;

        // Callbacks
        this.onHistoryChange = null;
    }

    /**
     * Exécuter une commande et l'ajouter à l'historique
     */
    execute(command) {
        if (!this.enabled) return;

        const success = command.execute();

        if (success) {
            this.undoStack.push(command);
            this.redoStack = []; // Clear redo stack on new action

            // Limiter la taille
            if (this.undoStack.length > this.maxSize) {
                this.undoStack.shift();
            }

            this.notifyChange();
        }
    }

    /**
     * Annuler la dernière commande
     */
    undo() {
        if (!this.canUndo()) return false;

        const command = this.undoStack.pop();
        const success = command.undo();

        if (success) {
            this.redoStack.push(command);
            this.notifyChange();
            return true;
        }

        // Rollback si échec
        this.undoStack.push(command);
        return false;
    }

    /**
     * Refaire la dernière commande annulée
     */
    redo() {
        if (!this.canRedo()) return false;

        const command = this.redoStack.pop();
        const success = command.execute();

        if (success) {
            this.undoStack.push(command);
            this.notifyChange();
            return true;
        }

        // Rollback si échec
        this.redoStack.push(command);
        return false;
    }

    /**
     * Vérifier si on peut annuler
     */
    canUndo() {
        return this.undoStack.length > 0;
    }

    /**
     * Vérifier si on peut refaire
     */
    canRedo() {
        return this.redoStack.length > 0;
    }

    /**
     * Vider l'historique
     */
    clear() {
        this.undoStack = [];
        this.redoStack = [];
        this.notifyChange();
    }

    /**
     * Obtenir la description de la prochaine action Undo
     */
    getUndoDescription() {
        if (!this.canUndo()) return null;
        return this.undoStack[this.undoStack.length - 1].toString();
    }

    /**
     * Obtenir la description de la prochaine action Redo
     */
    getRedoDescription() {
        if (!this.canRedo()) return null;
        return this.redoStack[this.redoStack.length - 1].toString();
    }

    /**
     * Notifier les changements d'historique
     */
    notifyChange() {
        if (this.onHistoryChange) {
            this.onHistoryChange({
                canUndo: this.canUndo(),
                canRedo: this.canRedo(),
                undoDescription: this.getUndoDescription(),
                redoDescription: this.getRedoDescription(),
                undoCount: this.undoStack.length,
                redoCount: this.redoStack.length
            });
        }
    }
}

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CommandHistory,
        Command,
        AddNoteCommand,
        DeleteNotesCommand,
        MoveNotesCommand,
        ChangeChannelCommand
    };
}

if (typeof window !== 'undefined') {
    window.CommandHistory = CommandHistory;
    window.Command = Command;
    window.AddNoteCommand = AddNoteCommand;
    window.DeleteNotesCommand = DeleteNotesCommand;
    window.MoveNotesCommand = MoveNotesCommand;
    window.ChangeChannelCommand = ChangeChannelCommand;
}
