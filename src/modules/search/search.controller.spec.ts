jest.mock('better-auth', () => ({ betterAuth: jest.fn() }));
jest.mock('better-auth/plugins', () => ({ anonymous: jest.fn() }));
jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn() }));
jest.mock('../../auth.js', () => ({
  auth: {
    api: {
      getSession: jest.fn(),
    },
  },
  authDatabase: {
    query: jest.fn(),
    end: jest.fn(),
  },
}));

import { BadRequestException } from '@nestjs/common';
import { SearchController } from './search.controller.js';
import type { SearchService } from './search.service.js';

describe('SearchController - Suggestions Endpoint', () => {
  let controller: SearchController;
  let mockSearchService: Partial<SearchService>;

  beforeEach(() => {
    mockSearchService = {
      getSuggestions: jest.fn().mockResolvedValue({
        querySuggestions: ['Kubernetes Nodes overview'],
        vocabularySuggestions: [{ term: 'Control Plane', nodeIds: ['node-1'] }],
        synonymSuggestions: [{ term: 'k8s', expansions: ['kubernetes'] }],
      }),
      getVocabulary: jest.fn().mockResolvedValue([
        {
          term: 'Control Plane',
          normalized: 'control plane',
          nodeIds: ['node-1'],
          weight: 10,
          sourceType: 'bold',
        },
      ]),
    };

    controller = new SearchController(mockSearchService as SearchService);
  });

  it('throws BadRequestException if graphId is missing', async () => {
    await expect(
      controller.getSuggestions({ identity: { userId: 'user-1' } } as any, ''),
    ).rejects.toThrow(BadRequestException);
  });

  it('delegates to searchService.getSuggestions with parsed parameters', async () => {
    const result = await controller.getSuggestions(
      { identity: { userId: 'user-1' } } as any,
      'graph-123',
      'node-1, node-2',
      'kube',
      '10',
    );

    expect(mockSearchService.getSuggestions).toHaveBeenCalledWith(
      { userId: 'user-1' },
      'graph-123',
      ['node-1', 'node-2'],
      'kube',
      10,
    );
    expect(result.querySuggestions).toContain('Kubernetes Nodes overview');
  });

  it('delegates to searchService.getVocabulary with parsed nodeIds', async () => {
    const result = await controller.getVocabulary(
      { identity: { userId: 'user-1' } } as any,
      'graph-123',
      'node-1, node-2',
    );

    expect(mockSearchService.getVocabulary).toHaveBeenCalledWith(
      { userId: 'user-1' },
      'graph-123',
      ['node-1', 'node-2'],
    );
    expect(result).toEqual([
      expect.objectContaining({ term: 'Control Plane' }),
    ]);
  });
});
