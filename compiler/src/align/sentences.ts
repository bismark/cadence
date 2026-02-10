/**
 * Sentence extraction and tagging for XHTML documents.
 * Adapted from Storyteller for parse5 DOM.
 *
 * MIT License
 * Copyright (c) 2023 Shane Friedman (original algorithm)
 * Copyright (c) 2026 Ryan Johnson (parse5 adaptation)
 * https://gitlab.com/storyteller-platform/storyteller
 */

import * as parse5 from 'parse5';
import { html } from 'parse5';
import { tokenizeSentences } from './nlp.js';
import { BLOCKS } from './semantics.js';

type Node = parse5.DefaultTreeAdapterMap['node'];
type ChildNode = parse5.DefaultTreeAdapterMap['childNode'];
type Element = parse5.DefaultTreeAdapterMap['element'];
type TextNode = parse5.DefaultTreeAdapterMap['textNode'];
type Document = parse5.DefaultTreeAdapterMap['document'];

/**
 * Type guard for Element nodes
 */
function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

/**
 * Type guard for TextNode
 */
function isTextNode(node: Node): node is TextNode {
  return 'value' in node && !('tagName' in node);
}

/**
 * Get text content from a node and its children
 */
function getTextContent(node: Node): string {
  if (isTextNode(node)) {
    return node.value;
  }
  if (isElement(node)) {
    return node.childNodes.map(getTextContent).join('');
  }
  return '';
}

/**
 * Find the body element in a parsed document
 */
function findBody(document: Document): Element | null {
  for (const node of document.childNodes) {
    if (isElement(node) && node.tagName === 'html') {
      for (const child of node.childNodes) {
        if (isElement(child) && child.tagName === 'body') {
          return child;
        }
      }
    }
  }
  return null;
}

/**
 * Extract sentences from an array of child nodes.
 * Handles block vs inline elements correctly.
 */
function extractSentencesFromNodes(nodes: Node[]): string[] {
  const sentences: string[] = [];
  let stagedText = '';

  for (const child of nodes) {
    if (isTextNode(child)) {
      stagedText += child.value;
      continue;
    }

    if (isElement(child)) {
      const tagName = child.tagName.toLowerCase();

      if (!BLOCKS.includes(tagName)) {
        // Inline element - accumulate its text
        stagedText += getTextContent(child);
        continue;
      }

      // Block element - flush staged text and recurse
      if (stagedText.trim()) {
        sentences.push(...tokenizeSentences(stagedText));
      }
      stagedText = '';

      // Recurse into block element
      sentences.push(...extractSentencesFromNodes(child.childNodes));
    }
  }

  // Flush any remaining text
  if (stagedText.trim()) {
    sentences.push(...tokenizeSentences(stagedText));
  }

  return sentences;
}

/**
 * Extract all sentences from an XHTML string.
 *
 * @param xhtml The XHTML content as a string
 * @returns Array of sentences in document order
 */
export function extractSentences(xhtml: string): string[] {
  const document = parse5.parse(xhtml);
  const body = findBody(document);

  if (!body) {
    return [];
  }

  return extractSentencesFromNodes(body.childNodes);
}

/**
 * Extract sentences from a parsed document body.
 */
export function extractSentencesFromBody(body: Element): string[] {
  return extractSentencesFromNodes(body.childNodes);
}

// ============================================================================
// Sentence Tagging - Inject <span> elements around sentences
// ============================================================================

interface TaggingState {
  sentenceIndex: number;
  sentenceProgress: number; // How far into current sentence we are
}

/**
 * Create a new span element wrapping content
 */
function createSpanElement(id: string, childNodes: ChildNode[]): Element {
  return {
    nodeName: 'span',
    tagName: 'span',
    attrs: [{ name: 'data-span-id', value: id }],
    namespaceURI: html.NS.HTML,
    childNodes,
    parentNode: null as any,
  };
}

/**
 * Create a text node
 */
function createTextNode(value: string): TextNode {
  return {
    nodeName: '#text',
    value,
    parentNode: null as any,
  };
}

/**
 * Clone an element (shallow - children handled separately)
 */
function cloneElement(el: Element): Element {
  return {
    nodeName: el.nodeName,
    tagName: el.tagName,
    attrs: el.attrs ? [...el.attrs.map((a) => ({ ...a }))] : [],
    namespaceURI: el.namespaceURI,
    childNodes: [],
    parentNode: null as any,
  };
}

/**
 * Tag sentences in a list of nodes, returning new tagged nodes.
 */
function tagNodesWithSentences(
  chapterId: string,
  nodes: ChildNode[],
  sentences: string[],
  state: TaggingState,
  taggedSentences: Set<number>,
  sentenceIndicesToTag: Set<number> | null,
): { nodes: ChildNode[]; state: TaggingState } {
  const result: ChildNode[] = [];

  for (const node of nodes) {
    if (state.sentenceIndex >= sentences.length) {
      // No more sentences to tag - pass through remaining nodes
      result.push(node);
      continue;
    }

    if (isTextNode(node)) {
      const tagged = tagTextNode(
        chapterId,
        node,
        sentences,
        state,
        taggedSentences,
        sentenceIndicesToTag,
      );
      result.push(...tagged.nodes);
      state = tagged.state;
    } else if (isElement(node)) {
      const tagName = node.tagName.toLowerCase();

      if (BLOCKS.includes(tagName)) {
        // Block element - recurse with fresh inline context
        const newElement = cloneElement(node);
        const tagged = tagNodesWithSentences(
          chapterId,
          node.childNodes,
          sentences,
          state,
          taggedSentences,
          sentenceIndicesToTag,
        );
        newElement.childNodes = tagged.nodes;
        result.push(newElement);
        state = tagged.state;
      } else {
        // Inline element - need to handle carefully
        // For now, recurse into it
        const newElement = cloneElement(node);
        const tagged = tagNodesWithSentences(
          chapterId,
          node.childNodes,
          sentences,
          state,
          taggedSentences,
          sentenceIndicesToTag,
        );
        newElement.childNodes = tagged.nodes;
        result.push(newElement);
        state = tagged.state;
      }
    } else {
      // Other node types (comments, etc) - pass through
      result.push(node);
    }
  }

  return { nodes: result, state };
}

/**
 * Tag sentences within a text node, potentially splitting it.
 */
function tagTextNode(
  chapterId: string,
  node: TextNode,
  sentences: string[],
  state: TaggingState,
  taggedSentences: Set<number>,
  sentenceIndicesToTag: Set<number> | null,
): { nodes: ChildNode[]; state: TaggingState } {
  const result: ChildNode[] = [];
  const text = node.value;
  let textPos = 0;

  while (textPos < text.length && state.sentenceIndex < sentences.length) {
    const sentence = sentences[state.sentenceIndex];
    const remainingSentence = sentence.slice(state.sentenceProgress);
    const remainingText = text.slice(textPos);

    // Find where the sentence continues in this text
    const sentenceStart = remainingText.indexOf(remainingSentence[0]);

    if (sentenceStart === -1) {
      // Sentence doesn't continue here - output remaining text untagged.
      // Mark node as fully consumed to avoid appending the same trailing
      // substring again in the post-loop remainingText flush.
      if (remainingText) {
        result.push(createTextNode(remainingText));
      }
      textPos = text.length;
      break;
    }

    // Output any text before the sentence
    if (sentenceStart > 0) {
      result.push(createTextNode(remainingText.slice(0, sentenceStart)));
    }

    // Check how much of the sentence is in this text node
    const availableText = remainingText.slice(sentenceStart);

    if (availableText.length >= remainingSentence.length) {
      // Full remaining sentence is here
      const sentenceText = remainingSentence;
      const shouldTagSentence =
        sentenceIndicesToTag === null || sentenceIndicesToTag.has(state.sentenceIndex);

      if (shouldTagSentence) {
        const spanId = `${chapterId}-sentence${state.sentenceIndex}`;

        if (!taggedSentences.has(state.sentenceIndex)) {
          // Wrap in span
          const span = createSpanElement(spanId, [createTextNode(sentenceText)]);
          result.push(span);
          taggedSentences.add(state.sentenceIndex);
        } else {
          // Already tagged earlier (sentence split across nodes)
          result.push(createTextNode(sentenceText));
        }
      } else {
        result.push(createTextNode(sentenceText));
      }

      textPos += sentenceStart + sentenceText.length;
      state = {
        sentenceIndex: state.sentenceIndex + 1,
        sentenceProgress: 0,
      };
    } else {
      // Only partial sentence here
      const shouldTagSentence =
        sentenceIndicesToTag === null || sentenceIndicesToTag.has(state.sentenceIndex);

      if (shouldTagSentence) {
        const spanId = `${chapterId}-sentence${state.sentenceIndex}`;

        if (!taggedSentences.has(state.sentenceIndex)) {
          const span = createSpanElement(spanId, [createTextNode(availableText)]);
          result.push(span);
          taggedSentences.add(state.sentenceIndex);
        } else {
          result.push(createTextNode(availableText));
        }
      } else {
        result.push(createTextNode(availableText));
      }

      state = {
        sentenceIndex: state.sentenceIndex,
        sentenceProgress: state.sentenceProgress + availableText.length,
      };
      textPos += sentenceStart + availableText.length;
      break; // Move to next node
    }
  }

  // Output any remaining text after all sentences
  const remainingText = text.slice(textPos);
  if (remainingText && textPos > 0) {
    result.push(createTextNode(remainingText));
  } else if (textPos === 0 && result.length === 0) {
    // No sentences matched - return original
    result.push(node);
  }

  return { nodes: result, state };
}

/**
 * Tag all sentences in an XHTML document with span elements.
 *
 * @param xhtml The XHTML content as a string
 * @param chapterId The chapter ID to use in span IDs
 * @returns Object containing tagged XHTML and list of sentences
 */
export function tagSentencesInXhtml(
  xhtml: string,
  chapterId: string,
  sentenceIndicesToTag?: Set<number>,
): { html: string; sentences: string[] } {
  const document = parse5.parse(xhtml);
  const body = findBody(document);

  if (!body) {
    return { html: xhtml, sentences: [] };
  }

  // First extract sentences
  const sentences = extractSentencesFromNodes(body.childNodes);

  if (sentences.length === 0) {
    return { html: xhtml, sentences: [] };
  }

  // Tag the sentences
  const state: TaggingState = { sentenceIndex: 0, sentenceProgress: 0 };
  const taggedSentences = new Set<number>();

  const tagged = tagNodesWithSentences(
    chapterId,
    body.childNodes,
    sentences,
    state,
    taggedSentences,
    sentenceIndicesToTag ?? null,
  );

  body.childNodes = tagged.nodes;

  // Serialize back to HTML
  const html = parse5.serialize(document);

  return { html, sentences };
}
