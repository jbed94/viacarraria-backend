import { randomUUID } from 'node:crypto';

type GraphNode = {
  id: string;
  position: { x: number; y: number };
  data: { title: string; category?: string; description?: string };
};

type Graph = {
  id: string;
  nodes: GraphNode[];
  edges?: Array<{ id: string; source: string; target: string }>;
  sources?: Source[];
  userId?: string;
  isPublic?: boolean;
  permission?: 'OWNER' | 'VIEWER';
  canEdit?: boolean;
  accessCount?: number;
};

type GraphSummary = Graph & {
  title: string;
  isPublic: boolean;
  userId: string;
  permission: 'OWNER' | 'VIEWER';
  canEdit: boolean;
  accessCount: number;
};

type SearchResponse = {
  queryId: string;
  results: Array<{
    nodeId: string;
    chunks: Array<{
      nodeId: string;
      extendedContext?: Array<{ nodeId: string; kind?: string }>;
    }>;
  }>;
  matchedNodeIds: string[];
  remaining: number;
  extendedSearch?: boolean;
  extendedContextCount?: number;
};

type QueryHistory = {
  id: string;
  graphId: string;
  queryText: string;
};

type Source = {
  id: string;
  nodeId: string;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'ERROR';
};

type ApiCall<T> = {
  response: Response;
  body: T;
  cookie: string;
};

const apiUrl = process.env.E2E_API_URL ?? 'http://localhost:3000/api';

async function call<T>(
  path: string,
  init: RequestInit = {},
  cookie = '',
): Promise<ApiCall<T>> {
  const headers = new Headers(init.headers);
  headers.set('origin', 'http://localhost:4173');
  if (
    init.body &&
    !(init.body instanceof FormData) &&
    !headers.has('content-type')
  ) {
    headers.set('content-type', 'application/json');
  }
  if (cookie) {
    headers.set('cookie', cookie);
  }
  const response = await fetch(`${apiUrl}${path}`, { ...init, headers });
  const setCookie = response.headers.get('set-cookie');
  const nextCookie = setCookie?.split(';', 1)[0] ?? cookie;
  const body =
    response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  return { response, body, cookie: nextCookie };
}

describe('Compose API', () => {
  it('supports a guest session, scoped search, quota enforcement, and history', async () => {
    const session = await call<{
      user: { id: string; isAnonymous?: boolean; subscriptionTier?: string };
    }>('/auth/sign-in/anonymous', {
      method: 'POST',
      body: '{}',
    });
    expect(session.response.ok).toBe(true);
    expect(session.body.user.isAnonymous).toBe(true);
    expect(session.cookie).toContain('session_token=');
    expect(session.response.headers.get('x-ratelimit-limit')).toBe('10');

    const graphs = await call<GraphSummary[]>('/graphs', {}, session.cookie);
    expect(graphs.response.ok).toBe(true);
    const graphSummary = graphs.body.find(
      (graph) => graph.id === 'system-computer-science',
    );
    expect(graphSummary?.isPublic).toBe(true);
    expect(graphSummary?.permission).toBe('VIEWER');
    expect(graphSummary?.canEdit).toBe(false);
    expect(graphSummary?.accessCount).toBeGreaterThanOrEqual(1);
    expect(graphSummary).toBeDefined();

    const graph = await call<Graph>(
      `/graphs/${graphSummary?.id}`,
      {},
      session.cookie,
    );
    expect(graph.response.ok).toBe(true);
    const selectedNodeIds = ['cs-databases', 'cs-systems'].filter((nodeId) =>
      graph.body.nodes.some((node) => node.id === nodeId),
    );
    expect(selectedNodeIds).toHaveLength(2);

    const guestExtendedSearch = await call(
      '/search',
      {
        method: 'POST',
        body: JSON.stringify({
          graphId: graph.body.id,
          query: 'relational database indexes',
          selectedNodeIds,
          extendedSearch: true,
        }),
      },
      session.cookie,
    );
    expect(guestExtendedSearch.response.status).toBe(403);

    const search = await call<SearchResponse>(
      '/search',
      {
        method: 'POST',
        body: JSON.stringify({
          graphId: graph.body.id,
          query: 'Where are relational database indexes explained?',
          selectedNodeIds,
        }),
      },
      session.cookie,
    );
    expect(search.response.ok).toBe(true);
    expect(search.response.headers.get('x-ratelimit-limit')).toBe('30');
    expect(search.body.queryId).toEqual(expect.any(String));
    expect(search.body.remaining).toBe(2);
    expect(search.body.matchedNodeIds).toContain('cs-databases');
    expect(search.body.results.map((result) => result.nodeId)).toContain(
      'cs-databases',
    );

    const overLimit = await call(
      '/search',
      {
        method: 'POST',
        body: JSON.stringify({
          graphId: graph.body.id,
          query: 'database',
          selectedNodeIds: graph.body.nodes.map((node) => node.id),
        }),
      },
      session.cookie,
    );
    expect(overLimit.response.status).toBe(403);

    const secondSearch = await call<SearchResponse>(
      '/search',
      {
        method: 'POST',
        body: JSON.stringify({
          graphId: graph.body.id,
          query: 'relational database indexes',
          selectedNodeIds,
        }),
      },
      session.cookie,
    );
    expect(secondSearch.response.ok).toBe(true);
    expect(secondSearch.body.remaining).toBe(1);

    const thirdSearch = await call<SearchResponse>(
      '/search',
      {
        method: 'POST',
        body: JSON.stringify({
          graphId: graph.body.id,
          query: 'database query plans',
          selectedNodeIds,
        }),
      },
      session.cookie,
    );
    expect(thirdSearch.response.ok).toBe(true);
    expect(thirdSearch.body.remaining).toBe(0);

    const exhausted = await call(
      '/search',
      {
        method: 'POST',
        body: JSON.stringify({
          graphId: graph.body.id,
          query: 'database storage',
          selectedNodeIds,
        }),
      },
      session.cookie,
    );
    expect(exhausted.response.status).toBe(429);

    const history = await call<QueryHistory[]>('/queries', {}, session.cookie);
    expect(history.response.ok).toBe(true);
    expect(history.body.some((entry) => entry.id === search.body.queryId)).toBe(
      true,
    );
    expect(history.body[0]?.graphId).toBe(graph.body.id);

    const email = `e2e-${randomUUID()}@example.com`;
    const registration = await call<{
      user: { id: string; isAnonymous?: boolean; subscriptionTier?: string };
      token: string;
    }>(
      '/auth/sign-up/email',
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'Compose E2E User',
          username: 'Compose E2E User',
          email,
          password: 'ComposeE2ePassword1!',
        }),
      },
      session.cookie,
    );
    expect(registration.response.ok).toBe(true);
    expect(registration.body.user.isAnonymous).not.toBe(true);
    expect(registration.body.user.subscriptionTier).toBe('FREE');
    expect(registration.cookie).toContain('session_token=');

    const limits = await call<{
      tier: string;
      graphs: { used: number; limit: number | null; exceeded: boolean };
      queries: { used: number; limit: number | null; exceeded: boolean };
      nodesPerGraph: { limit: number | null };
      extendedContext: { limit: number | null };
    }>('/limits', {}, registration.cookie);
    expect(limits.response.ok).toBe(true);
    expect(limits.body.tier).toBe('FREE');
    expect(limits.body.graphs).toMatchObject({ used: 0, limit: 3 });
    expect(limits.body.queries.limit).toBe(20);
    expect(limits.body.nodesPerGraph.limit).toBe(10);
    expect(limits.body.extendedContext.limit).toBe(3);

    const freeCopy = await call(
      `/graphs/${graph.body.id}/copy`,
      {
        method: 'POST',
        body: JSON.stringify({ title: 'Free blocked curriculum copy' }),
      },
      registration.cookie,
    );
    expect(freeCopy.response.status).toBe(403);

    const migratedHistory = await call<QueryHistory[]>(
      '/queries',
      {},
      registration.cookie,
    );
    expect(
      migratedHistory.body.some((entry) => entry.id === search.body.queryId),
    ).toBe(true);

    const createdGraph = await call<Graph>(
      '/graphs',
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'Compose E2E Graph',
          description: 'Graph created by the Compose API journey.',
        }),
      },
      registration.cookie,
    );
    expect(createdGraph.response.ok).toBe(true);

    const additionalGraph = await call<Graph>(
      '/graphs',
      {
        method: 'POST',
        body: JSON.stringify({ title: 'Compose E2E Graph Two' }),
      },
      registration.cookie,
    );
    expect(additionalGraph.response.ok).toBe(true);
    const thirdGraph = await call<Graph>(
      '/graphs',
      {
        method: 'POST',
        body: JSON.stringify({ title: 'Compose E2E Graph Three' }),
      },
      registration.cookie,
    );
    expect(thirdGraph.response.ok).toBe(true);
    const graphLimit = await call(
      '/graphs',
      {
        method: 'POST',
        body: JSON.stringify({ title: 'Compose E2E Graph Four' }),
      },
      registration.cookie,
    );
    expect(graphLimit.response.status).toBe(403);

    const upgrade = await call<{ subscription: { tier: string } }>(
      '/billing/checkout',
      { method: 'POST', body: '{}' },
      registration.cookie,
    );
    expect(upgrade.response.ok).toBe(true);
    expect(upgrade.body.subscription.tier).toBe('PRO');

    const copiedGraph = await call<Graph>(
      `/graphs/${graph.body.id}/copy`,
      {
        method: 'POST',
        body: JSON.stringify({ title: 'Compose copied curriculum' }),
      },
      registration.cookie,
    );
    expect(copiedGraph.response.ok).toBe(true);
    expect(copiedGraph.body.userId).toBe(registration.body.user.id);
    expect(copiedGraph.body.isPublic).toBe(false);
    expect(copiedGraph.body.permission).toBe('OWNER');
    expect(copiedGraph.body.canEdit).toBe(true);
    expect(copiedGraph.body.nodes).toEqual(graph.body.nodes);
    expect(copiedGraph.body.sources).toHaveLength(28);

    const node = {
      id: 'e2e-node',
      position: { x: 0, y: 0 },
      data: {
        title: 'Compose Source Topic',
        category: 'Test',
        description: 'A topic used to validate source ingestion.',
      },
    };
    const adjacentNode = {
      id: 'e2e-adjacent-node',
      position: { x: 300, y: 0 },
      data: {
        title: 'Compose Extended Context Topic',
        category: 'Test',
        description:
          'A directly connected topic used to validate extended context.',
      },
    };
    const savedGraph = await call<Graph>(
      `/graphs/${createdGraph.body.id}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          nodes: [node, adjacentNode],
          edges: [
            {
              id: 'e2e-node-adjacent-node',
              source: node.id,
              target: adjacentNode.id,
            },
          ],
        }),
      },
      registration.cookie,
    );
    expect(savedGraph.response.ok).toBe(true);
    expect(savedGraph.body.nodes).toEqual([node, adjacentNode]);

    const document = new FormData();
    document.set('graphId', createdGraph.body.id);
    document.set('nodeId', node.id);
    document.set(
      'file',
      new Blob(
        [
          'Compose ingestion verifies a source becomes ready and searchable. ',
          'This unique constellation phrase belongs to the uploaded source.',
        ],
        { type: 'text/markdown' },
      ),
      'compose-e2e-source.md',
    );
    const uploaded = await call<Source>(
      '/sources/upload',
      { method: 'POST', body: document },
      registration.cookie,
    );
    expect(uploaded.response.ok).toBe(true);
    expect(uploaded.body.status).toBe('PENDING');

    const readySource = await waitForSource(
      uploaded.body.id,
      registration.cookie,
    );
    expect(readySource.status).toBe('READY');

    const extendedDocument = new FormData();
    extendedDocument.set('graphId', createdGraph.body.id);
    extendedDocument.set('nodeId', adjacentNode.id);
    extendedDocument.set(
      'file',
      new Blob(
        [
          'Adjacent source material expands the unique constellation phrase with dependent context.',
        ],
        { type: 'text/markdown' },
      ),
      'compose-e2e-extended-source.md',
    );
    const uploadedExtended = await call<Source>(
      '/sources/upload',
      { method: 'POST', body: extendedDocument },
      registration.cookie,
    );
    expect(uploadedExtended.response.ok).toBe(true);
    expect(
      (await waitForSource(uploadedExtended.body.id, registration.cookie))
        .status,
    ).toBe('READY');

    const sourceSearch = await call<SearchResponse>(
      '/search',
      {
        method: 'POST',
        body: JSON.stringify({
          graphId: createdGraph.body.id,
          query: 'unique constellation phrase',
          selectedNodeIds: [node.id],
        }),
      },
      registration.cookie,
    );
    expect(sourceSearch.response.ok).toBe(true);
    expect(sourceSearch.body.matchedNodeIds).toContain(node.id);

    const extendedSearch = await call<SearchResponse>(
      '/search',
      {
        method: 'POST',
        body: JSON.stringify({
          graphId: createdGraph.body.id,
          query: 'unique constellation phrase',
          selectedNodeIds: [node.id],
          extendedSearch: true,
        }),
      },
      registration.cookie,
    );
    expect(extendedSearch.response.ok).toBe(true);
    expect(extendedSearch.body.extendedSearch).toBe(true);
    expect(extendedSearch.body.extendedContextCount).toBeGreaterThan(0);
    const extendedChunks = extendedSearch.body.results.flatMap((result) =>
      result.chunks.flatMap((chunk) => chunk.extendedContext ?? []),
    );
    expect(extendedChunks).not.toHaveLength(0);
    expect(extendedChunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: adjacentNode.id,
          kind: 'EXTENDED',
        }),
      ]),
    );
  }, 30_000);
});

async function waitForSource(
  sourceId: string,
  cookie: string,
): Promise<Source> {
  const deadline = Date.now() + 30_000;
  let latest: Source | undefined;
  while (Date.now() < deadline) {
    const result = await call<Source>(`/sources/${sourceId}`, {}, cookie);
    latest = result.body;
    if (latest.status === 'READY' || latest.status === 'ERROR') {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Source did not finish processing: ${JSON.stringify(latest)}`,
  );
}
