// src/repositories/FileRepository.js
// Repository wrapper over MidiDatabase (P0-2.1, ADR-002 option B).
// Exposes a business-named API; delegates to the existing sub-DB.

export default class FileRepository {
  constructor(database) {
    this.database = database;
  }

  findById(fileId) {
    return this.database.getFile(fileId);
  }

  findInfoById(fileId) {
    return this.database.getFileInfo(fileId);
  }

  findByFolder(folder = '/') {
    return this.database.getFiles(folder);
  }

  save(file) {
    return this.database.insertFile(file);
  }

  update(fileId, updates) {
    return this.database.updateFile(fileId, updates);
  }

  delete(fileId) {
    return this.database.deleteFile(fileId);
  }

  getChannels(fileId) {
    return this.database.getFileChannels(fileId);
  }

  search(query) {
    return this.database.searchFiles(query);
  }

  filter(filters) {
    return this.database.filterFiles(filters);
  }

  countNeedingReanalysis() {
    return this.database.countFilesNeedingReanalysis();
  }

  getDistinctInstruments() {
    return this.database.getDistinctInstruments();
  }

  getDistinctCategories() {
    return this.database.getDistinctCategories();
  }

  // Wrap a synchronous function in a SQLite transaction. Returns the
  // better-sqlite3 wrapper so callers can invoke it with their own arguments
  // (ADR-002 §Conventions — composite writes belong in the Repository layer).
  transaction(fn) {
    return this.database.transaction(fn);
  }
}
