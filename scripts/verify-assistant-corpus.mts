import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildCatalogVocabulary,
  resolveCatalogQueryTokens,
} from '../src/lib/catalogAssistantSpelling';

const indexDirectory = path.resolve('dist/static-data/search-index');
assert.ok(existsSync(indexDirectory), 'Ejecuta npm run build:firebase antes de verificar el vocabulario.');

const entries: Array<{ text: string; weight: number }> = [];
for (const fileName of readdirSync(indexDirectory).filter((name) => name.endsWith('.json'))) {
  const payload = JSON.parse(readFileSync(path.join(indexDirectory, fileName), 'utf8')) as {
    pages?: Array<{ text?: unknown }>;
  };
  for (const page of payload.pages || []) {
    if (typeof page.text === 'string') entries.push({ text: page.text, weight: 2 });
  }
}

const vocabulary = buildCatalogVocabulary(entries);
const expectCorrection = (input: string[], expected: string[]) => {
  assert.deepEqual(resolveCatalogQueryTokens(input, vocabulary).tokens, expected);
};

expectCorrection(['edrdon', 'safiro'], ['edredon', 'zafiro']);
expectCorrection(['almhoada'], ['almohada']);
expectCorrection(['prodcuto'], ['producto']);
assert.deepEqual(resolveCatalogQueryTokens(['xilofono'], vocabulary).corrections, []);

console.log(`Assistant corpus verification passed with ${vocabulary.size} indexed terms.`);
