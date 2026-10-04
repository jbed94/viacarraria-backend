const STOP_WORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'just',
  'me',
  'more',
  'most',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
]);

const GENERIC_DISCARD_TERMS = new Set([
  'table of contents',
  'introduction',
  'overview',
  'summary',
  'conclusion',
  'chapter',
  'section',
  'page',
  'figure',
  'reference',
  'appendix',
  'notes',
  'index',
]);

export interface GraphVocabularyItem {
  term: string;
  normalized: string;
  nodeIds: string[];
  weight: number;
  sourceType: 'node_title' | 'heading' | 'bold' | 'acronym' | 'keyphrase';
}

export interface VocabularySourceInput {
  id?: string;
  nodeId: string;
  name?: string;
  content?: string | null;
}

export interface VocabularyNodeInput {
  id: string;
  data?: {
    title?: string;
    category?: string;
    description?: string;
  };
}

export interface SearchSuggestionsResult {
  querySuggestions: string[];
  vocabularySuggestions: Array<{
    term: string;
    nodeIds: string[];
    sourceType?: string;
  }>;
  synonymSuggestions: Array<{
    term: string;
    expansions: string[];
  }>;
}

/**
 * Strips code blocks, HTML tags, images, and links from raw markdown/text.
 */
export function cleanDocumentText(rawText: string): string {
  if (!rawText) return '';
  return rawText
    .replace(/```[\s\S]*?```/g, ' ') // Code fences
    .replace(/`[^`]+`/g, ' ') // Inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // Images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // Markdown links (keep label)
    .replace(/<[^>]+>/g, ' ') // HTML tags
    .replace(/\r\n|\r/g, '\n');
}

/**
 * Extracts high-salience concepts, headings, acronyms, and bold terms from a node's sources and metadata.
 */
export function extractVocabularyFromSource(
  source: VocabularySourceInput,
): GraphVocabularyItem[] {
  const itemsMap = new Map<string, GraphVocabularyItem>();

  const registerItem = (
    term: string,
    weight: number,
    sourceType: GraphVocabularyItem['sourceType'],
  ) => {
    const trimmed = term.trim();
    if (trimmed.length < 2 || trimmed.length > 60) return;
    const normalized = trimmed.toLowerCase();
    if (STOP_WORDS.has(normalized) || GENERIC_DISCARD_TERMS.has(normalized))
      return;

    const existing = itemsMap.get(normalized);
    if (existing) {
      existing.weight += weight;
      if (!existing.nodeIds.includes(source.nodeId)) {
        existing.nodeIds.push(source.nodeId);
      }
    } else {
      itemsMap.set(normalized, {
        term: trimmed,
        normalized,
        nodeIds: [source.nodeId],
        weight,
        sourceType,
      });
    }
  };

  if (!source.content) {
    return Array.from(itemsMap.values());
  }

  const cleaned = cleanDocumentText(source.content);
  const lines = cleaned.split('\n');

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // 1. Markdown headings (# Heading, ## Subheading)
    const headingMatch = trimmedLine.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch && headingMatch[1]) {
      const headingText = headingMatch[1].trim();
      registerItem(headingText, 6, 'heading');
      continue;
    }

    // 2. Bold text (**Concept** or __Concept__)
    const boldMatches = trimmedLine.matchAll(/\*\*([^*]+)\*\*|__([^_]+)__/g);
    for (const match of boldMatches) {
      const boldText = (match[1] || match[2])?.trim();
      if (boldText && boldText.length >= 3) {
        registerItem(boldText, 4, 'bold');
      }
    }

    // 3. Technical Acronyms (e.g. K8S, DAG, API, RAG, BM25, SQL)
    const acronymMatches = trimmedLine.matchAll(/\b([A-Z0-9]{2,6})\b/g);
    for (const match of acronymMatches) {
      const acronym = match[1]?.trim();
      if (
        acronym &&
        /[A-Z]/.test(acronym) &&
        !STOP_WORDS.has(acronym.toLowerCase())
      ) {
        registerItem(acronym, 3, 'acronym');
      }
    }

    // 4. Title Case Multi-Word Concepts (e.g. "Container Orchestration", "Vector Database")
    const titleCaseMatches = trimmedLine.matchAll(
      /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g,
    );
    for (const match of titleCaseMatches) {
      const phrase = match[1]?.trim();
      if (phrase && phrase.length >= 5) {
        registerItem(phrase, 2, 'keyphrase');
      }
    }
  }

  return Array.from(itemsMap.values());
}

/**
 * Merges pre-extracted source vocabulary items with node metadata.
 */
export function mergeVocabularyItems(
  nodes: VocabularyNodeInput[],
  sourceItemsList: GraphVocabularyItem[][],
): GraphVocabularyItem[] {
  const mergedMap = new Map<string, GraphVocabularyItem>();

  const registerOrMerge = (item: GraphVocabularyItem) => {
    const existing = mergedMap.get(item.normalized);
    if (existing) {
      existing.weight += item.weight;
      for (const nid of item.nodeIds) {
        if (!existing.nodeIds.includes(nid)) {
          existing.nodeIds.push(nid);
        }
      }
    } else {
      mergedMap.set(item.normalized, { ...item, nodeIds: [...item.nodeIds] });
    }
  };

  // 1. Ingest Node Titles and Categories
  for (const node of nodes) {
    if (node.data?.title?.trim()) {
      registerOrMerge({
        term: node.data.title.trim(),
        normalized: node.data.title.trim().toLowerCase(),
        nodeIds: [node.id],
        weight: 10,
        sourceType: 'node_title',
      });
    }
    if (node.data?.category?.trim()) {
      registerOrMerge({
        term: node.data.category.trim(),
        normalized: node.data.category.trim().toLowerCase(),
        nodeIds: [node.id],
        weight: 5,
        sourceType: 'keyphrase',
      });
    }
  }

  // 2. Ingest Pre-Extracted Source Vocabulary Items
  for (const sourceItems of sourceItemsList) {
    for (const item of sourceItems) {
      registerOrMerge(item);
    }
  }

  return Array.from(mergedMap.values()).sort((a, b) => b.weight - a.weight);
}

/**
 * Harvests and aggregates a comprehensive domain vocabulary for an entire graph,
 * merging node metadata with all parsed sources.
 */
export function extractGraphVocabulary(
  nodes: VocabularyNodeInput[],
  sources: VocabularySourceInput[],
): GraphVocabularyItem[] {
  const sourceItemsList = sources.map((source) =>
    extractVocabularyFromSource(source),
  );
  return mergeVocabularyItems(nodes, sourceItemsList);
}

/**
 * Generates contextual query suggestions, matching vocabulary concepts, and acronym expansions
 * tailored specifically to the user's selected nodes and current search input.
 */
export function generateContextualSuggestions(params: {
  vocabulary: GraphVocabularyItem[];
  nodes: VocabularyNodeInput[];
  selectedNodeIds: string[];
  queryPrefix: string;
  activeSynonyms: Record<string, string[]>;
  limit: number;
}): SearchSuggestionsResult {
  const {
    vocabulary,
    nodes,
    selectedNodeIds,
    queryPrefix,
    activeSynonyms,
    limit,
  } = params;

  const normalizedPrefix = queryPrefix.trim().toLowerCase();
  const selectedNodeSet = new Set(selectedNodeIds);
  const selectedNodes = nodes.filter((n) => selectedNodeSet.has(n.id));

  // 1. Filter Vocabulary Concepts
  const matchedVocab: GraphVocabularyItem[] = [];
  for (const item of vocabulary) {
    const isSelectedNode = item.nodeIds.some((id) => selectedNodeSet.has(id));
    const matchesPrefix =
      !normalizedPrefix || item.normalized.includes(normalizedPrefix);

    if (matchesPrefix) {
      // Score boost for selected nodes
      const effectiveWeight = item.weight * (isSelectedNode ? 2.5 : 1.0);
      matchedVocab.push({
        ...item,
        weight: effectiveWeight,
      });
    }
  }

  // Sort matched vocabulary by weight descending
  matchedVocab.sort((a, b) => b.weight - a.weight);

  // 2. Build Query Phrase Suggestions
  const queryPhrases = new Set<string>();

  // A. If nodes are selected: synthesize node-based contextual query phrases
  if (selectedNodes.length > 0) {
    const nodeTitles = selectedNodes
      .map((n) => n.data?.title?.trim())
      .filter((t): t is string => Boolean(t));

    // Synthesis query across 2 selected nodes (e.g. "Kubernetes and Service Mesh")
    if (nodeTitles.length >= 2) {
      const phrase = `${nodeTitles[0]} and ${nodeTitles[1]} integration`;
      if (
        !normalizedPrefix ||
        phrase.toLowerCase().includes(normalizedPrefix)
      ) {
        queryPhrases.add(phrase);
      }
      const comparePhrase = `Compare ${nodeTitles[0]} with ${nodeTitles[1]}`;
      if (
        !normalizedPrefix ||
        comparePhrase.toLowerCase().includes(normalizedPrefix)
      ) {
        queryPhrases.add(comparePhrase);
      }
    }

    // Top concept queries for each selected node
    for (const node of selectedNodes) {
      const title = node.data?.title?.trim();
      if (!title) continue;

      const nodeConcepts = matchedVocab
        .filter(
          (v) =>
            v.nodeIds.includes(node.id) &&
            v.normalized !== title.toLowerCase() &&
            v.term.length > 2,
        )
        .slice(0, 3);

      for (const concept of nodeConcepts) {
        const queryIdea = `${concept.term} in ${title}`;
        if (
          !normalizedPrefix ||
          queryIdea.toLowerCase().includes(normalizedPrefix)
        ) {
          queryPhrases.add(queryIdea);
        }
      }

      const overviewQuery = `${title} overview and architecture`;
      if (
        !normalizedPrefix ||
        overviewQuery.toLowerCase().includes(normalizedPrefix)
      ) {
        queryPhrases.add(overviewQuery);
      }
    }
  }

  // B. Fill with matched vocabulary terms as direct search phrases
  for (const item of matchedVocab) {
    if (queryPhrases.size >= limit * 1.5) break;
    queryPhrases.add(item.term);
  }

  // C. If user typed a prefix that isn't full words, provide clean search completion
  if (normalizedPrefix && !queryPhrases.has(queryPrefix.trim())) {
    for (const item of matchedVocab) {
      if (item.normalized.startsWith(normalizedPrefix)) {
        queryPhrases.add(item.term);
      }
    }
  }

  // 3. Match Synonyms & Technical Acronyms
  const synonymSuggestions: SearchSuggestionsResult['synonymSuggestions'] = [];
  for (const [key, expansions] of Object.entries(activeSynonyms)) {
    const keyLower = key.toLowerCase();
    const matchesKey =
      !normalizedPrefix ||
      keyLower.includes(normalizedPrefix) ||
      expansions.some((exp) => exp.toLowerCase().includes(normalizedPrefix));

    if (matchesKey) {
      synonymSuggestions.push({
        term: key,
        expansions,
      });
      if (synonymSuggestions.length >= 5) break;
    }
  }

  return {
    querySuggestions: Array.from(queryPhrases).slice(0, limit),
    vocabularySuggestions: matchedVocab.slice(0, limit).map((v) => ({
      term: v.term,
      nodeIds: v.nodeIds,
      sourceType: v.sourceType,
    })),
    synonymSuggestions,
  };
}
