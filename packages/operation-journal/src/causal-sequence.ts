import type { DatabaseSync } from "node:sqlite";

export type CausalSequenceAllocator = () => number;

export function ensureCausalSequenceTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS morrow_causal_sequence (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0)
    ) STRICT;
    INSERT OR IGNORE INTO morrow_causal_sequence(singleton, last_sequence) VALUES (1, 0);
  `);
}

export function nextDurableCausalSequence(database: DatabaseSync): number {
  const row = database.prepare(`
    UPDATE morrow_causal_sequence
    SET last_sequence = last_sequence + 1
    WHERE singleton = 1
    RETURNING last_sequence
  `).get() as { last_sequence?: unknown } | undefined;
  const sequence = row?.last_sequence;
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) {
    throw new Error("Morrow causal sequence is unavailable");
  }
  return Number(sequence);
}

export function exactCausalSequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}
