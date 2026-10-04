import {
  cleanDocumentText,
  extractGraphVocabulary,
  extractVocabularyFromSource,
  generateContextualSuggestions,
} from './vocabulary.utils.js';

describe('vocabulary.utils', () => {
  describe('cleanDocumentText', () => {
    it('removes code blocks, inline code, and image tags while preserving heading text', () => {
      const markdown = `
# System Architecture
Here is an image: ![Diagram](https://example.com/diag.png)
\`\`\`ts
const x = 10;
\`\`\`
Check out [Documentation](https://example.com) and \`inlineCode\`.
`;
      const cleaned = cleanDocumentText(markdown);
      expect(cleaned).toContain('# System Architecture');
      expect(cleaned).toContain('Documentation');
      expect(cleaned).not.toContain('const x = 10;');
      expect(cleaned).not.toContain('https://example.com/diag.png');
      expect(cleaned).not.toContain('inlineCode');
    });
  });

  describe('extractVocabularyFromSource', () => {
    it('extracts headings, bold concepts, acronyms, and title-case phrases', () => {
      const source = {
        nodeId: 'node-1',
        content: `
# Container Orchestration
We use **Horizontal Pod Autoscaling** in our K8S cluster.
The system implements a Directed Acyclic Graph (DAG) for task execution.
`,
      };

      const vocab = extractVocabularyFromSource(source);
      const terms = vocab.map((v) => v.term);

      expect(terms).toContain('Container Orchestration');
      expect(terms).toContain('Horizontal Pod Autoscaling');
      expect(terms).toContain('K8S');
      expect(terms).toContain('DAG');
      expect(terms).toContain('Directed Acyclic Graph');
    });

    it('returns empty array when content is empty or null', () => {
      expect(
        extractVocabularyFromSource({ nodeId: 'node-1', content: null }),
      ).toEqual([]);
      expect(
        extractVocabularyFromSource({ nodeId: 'node-1', content: '' }),
      ).toEqual([]);
    });
  });

  describe('extractGraphVocabulary', () => {
    it('merges node titles with document source vocabulary', () => {
      const nodes = [
        {
          id: 'node-k8s',
          data: { title: 'Kubernetes Nodes', category: 'Infrastructure' },
        },
      ];
      const sources = [
        {
          nodeId: 'node-k8s',
          content: '## Control Plane\nMaster nodes manage the etcd state.',
        },
      ];

      const vocab = extractGraphVocabulary(nodes, sources);
      const terms = vocab.map((v) => v.term);

      expect(terms).toContain('Kubernetes Nodes');
      expect(terms).toContain('Infrastructure');
      expect(terms).toContain('Control Plane');

      const controlPlane = vocab.find((v) => v.term === 'Control Plane');
      expect(controlPlane?.nodeIds).toContain('node-k8s');
    });
  });

  describe('generateContextualSuggestions', () => {
    const nodes = [
      { id: 'node-1', data: { title: 'Kubernetes' } },
      { id: 'node-2', data: { title: 'Istio Service Mesh' } },
    ];
    const vocabulary = [
      {
        term: 'Kubernetes',
        normalized: 'kubernetes',
        nodeIds: ['node-1'],
        weight: 10,
        sourceType: 'node_title' as const,
      },
      {
        term: 'Control Plane',
        normalized: 'control plane',
        nodeIds: ['node-1'],
        weight: 6,
        sourceType: 'heading' as const,
      },
      {
        term: 'Istio Service Mesh',
        normalized: 'istio service mesh',
        nodeIds: ['node-2'],
        weight: 10,
        sourceType: 'node_title' as const,
      },
      {
        term: 'Envoy Proxy',
        normalized: 'envoy proxy',
        nodeIds: ['node-2'],
        weight: 4,
        sourceType: 'keyphrase' as const,
      },
    ];
    const activeSynonyms = {
      k8s: ['kubernetes', 'container orchestration'],
    };

    it('generates contextual synthesis phrases when nodes are selected without query prefix', () => {
      const result = generateContextualSuggestions({
        vocabulary,
        nodes,
        selectedNodeIds: ['node-1', 'node-2'],
        queryPrefix: '',
        activeSynonyms,
        limit: 8,
      });

      expect(result.querySuggestions).toContain(
        'Kubernetes and Istio Service Mesh integration',
      );
      expect(result.querySuggestions).toContain(
        'Compare Kubernetes with Istio Service Mesh',
      );
      expect(result.querySuggestions).toContain('Control Plane in Kubernetes');
    });

    it('filters query suggestions and vocabulary by prefix match', () => {
      const result = generateContextualSuggestions({
        vocabulary,
        nodes,
        selectedNodeIds: ['node-1'],
        queryPrefix: 'control',
        activeSynonyms,
        limit: 5,
      });

      expect(
        result.querySuggestions.some((q) =>
          q.toLowerCase().includes('control'),
        ),
      ).toBe(true);
      expect(
        result.vocabularySuggestions.some((v) => v.term === 'Control Plane'),
      ).toBe(true);
    });

    it('returns matching acronym synonyms', () => {
      const result = generateContextualSuggestions({
        vocabulary,
        nodes,
        selectedNodeIds: [],
        queryPrefix: 'k8s',
        activeSynonyms,
        limit: 5,
      });

      expect(result.synonymSuggestions).toEqual([
        { term: 'k8s', expansions: ['kubernetes', 'container orchestration'] },
      ]);
    });
  });
});
