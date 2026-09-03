import { BadRequestException } from '@nestjs/common';

import type { CanvasEdge, CanvasNode } from './types.js';

export function validateCanvas(
  nodes: unknown,
  edges: unknown,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new BadRequestException('Canvas nodes and edges must be arrays.');
  }
  const parsedNodes = nodes.map(parseNode);
  const parsedEdges = edges.map(parseEdge);
  const nodeIds = new Set(parsedNodes.map((node) => node.id));
  if (nodeIds.size !== parsedNodes.length) {
    throw new BadRequestException('Canvas node IDs must be unique.');
  }
  const edgeIds = new Set(parsedEdges.map((edge) => edge.id));
  if (edgeIds.size !== parsedEdges.length) {
    throw new BadRequestException('Canvas edge IDs must be unique.');
  }
  for (const edge of parsedEdges) {
    if (
      !nodeIds.has(edge.source) ||
      !nodeIds.has(edge.target) ||
      edge.source === edge.target
    ) {
      throw new BadRequestException(
        'Canvas edges must connect two different existing nodes.',
      );
    }
  }
  ensureAcyclic(parsedNodes, parsedEdges);
  return { nodes: parsedNodes, edges: parsedEdges };
}

function parseNode(value: unknown): CanvasNode {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isRecord(value.position) ||
    !isRecord(value.data)
  ) {
    throw new BadRequestException(
      'Every canvas node needs id, position, and data.',
    );
  }
  const { id, position, data } = value;
  if (
    !id.trim() ||
    typeof position.x !== 'number' ||
    typeof position.y !== 'number' ||
    typeof data.title !== 'string' ||
    !data.title.trim()
  ) {
    throw new BadRequestException('Canvas node values are invalid.');
  }
  return {
    id,
    position: { x: position.x, y: position.y },
    data: {
      title: data.title.trim(),
      ...(typeof data.category === 'string'
        ? { category: data.category.trim() }
        : {}),
      ...(typeof data.description === 'string'
        ? { description: data.description.trim() }
        : {}),
    },
  };
}

function parseEdge(value: unknown): CanvasEdge {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.source !== 'string' ||
    typeof value.target !== 'string' ||
    !value.id.trim()
  ) {
    throw new BadRequestException(
      'Every canvas edge needs id, source, and target.',
    );
  }
  return { id: value.id, source: value.source, target: value.target };
}

function ensureAcyclic(nodes: CanvasNode[], edges: CanvasEdge[]): void {
  const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      throw new BadRequestException(
        'Canvas edges must form a directed acyclic graph.',
      );
    }
    if (visited.has(nodeId)) {
      return;
    }
    visiting.add(nodeId);
    for (const child of adjacency.get(nodeId) ?? []) {
      visit(child);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) {
    visit(node.id);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
