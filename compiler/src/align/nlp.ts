/**
 * NLP utilities for sentence tokenization.
 *
 * MIT License
 * Copyright (c) 2023 Shane Friedman (original)
 * Copyright (c) 2026 Ryan Johnson (modifications)
 * From: https://gitlab.com/storyteller-platform/storyteller
 */

import model from 'wink-eng-lite-web-model';
import wink from 'wink-nlp';

const nlp = wink(model);

export function tokenizeSentences(text: string): string[] {
  const nlpDoc = nlp.readDoc(text);
  return (
    nlpDoc
      .sentences()
      .out()
      // Strip out any zero-length "sentences", usually the result of newlines
      .filter((s) => !!s)
  );
}
