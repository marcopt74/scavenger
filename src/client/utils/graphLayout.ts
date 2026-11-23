import type {
  KnowledgeGraphModuleNode,
  RepoCoreFlow,
  RepoFileIndexEntry,
  RepoModuleLayer,
} from '../../shared/types';

export const ARCH_LAYER_ORDER: readonly RepoModuleLayer[] = [
  'entry',
  'api',
  'core',
  'guard',
  'data',
  'ui',
  'shared',
  'config',
  'test',
] as const;

export interface LayerMeta {
  layer: RepoModuleLayer;
  label: string;
  shortLabel: string;
  description: string;
  accentColor: string;
}

export const ARCH_LAYER_META: Record<RepoModuleLayer, LayerMeta> = {
  entry: {
    layer: 'entry',
    label: 'Entry Points',
    shortLabel: 'entry',
    description: 'CLI, server bootstrap, and application entry surfaces',
    accentColor: '#3b82f6',
  },
  api: {
    layer: 'api',
    label: 'API & Transport',
    shortLabel: 'api',
    description: 'HTTP routes, controllers, SSE streams, and client API adapters',
    accentColor: '#06b6d4',
  },
  core: {
    layer: 'core',
    label: 'Core Engine',
    shortLabel: 'core',
    description: 'Domain orchestration, reasoning, indexing, and session logic',
    accentColor: '#8b5cf6',
  },
  guard: {
    layer: 'guard',
    label: 'Security & Guards',
    shortLabel: 'guard',
    description: 'Read-only sandboxing, path traversal checks, and git allowlists',
    accentColor: '#f59e0b',
  },
  data: {
    layer: 'data',
    label: 'State & Persistence',
    shortLabel: 'data',
    description: 'Storage engines, caches, and persistent state stores',
    accentColor: '#10b981',
  },
  ui: {
    layer: 'ui',
    label: 'UI & Presentation',
    shortLabel: 'ui',
    description: 'Interactive components, modals, renderers, and visual studios',
    accentColor: '#ec4899',
  },
  shared: {
    layer: 'shared',
    label: 'Shared Contracts',
    shortLabel: 'shared',
    description: 'Cross-boundary TypeScript interfaces, schemas, and utilities',
    accentColor: '#6366f1',
  },
  config: {
    layer: 'config',
    label: 'Configuration',
    shortLabel: 'config',
    description: 'Environment, build, and runtime configuration',
    accentColor: '#64748b',
  },
  test: {
    layer: 'test',
    label: 'Verification & Tests',
    shortLabel: 'test',
    description: 'Automated unit, integration, and regression suites',
    accentColor: '#14b8a6',
  },
};

export interface PositionedGraphNode {
  id: string;
  module: KnowledgeGraphModuleNode;
  layer: RepoModuleLayer;
  rankIndex: number;
  columnIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface PositionedGraphEdge {
  id: string;
  from: string;
  to: string;
  d: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  isBackEdge: boolean;
}

export interface LayerBand {
  layer: RepoModuleLayer;
  label: string;
  description: string;
  rankIndex: number;
  y: number;
  height: number;
  moduleCount: number;
}

export interface ArchitectureGraphLayout {
  width: number;
  height: number;
  nodes: PositionedGraphNode[];
  edges: PositionedGraphEdge[];
  layerBands: LayerBand[];
}

export interface BlastRadiusResult {
  selectedModuleId: string;
  directUpstream: string[];
  transitiveUpstream: string[];
  directDownstream: string[];
  transitiveDownstream: string[];
  affectedFilesCount: number;
  upstreamRatio: number;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface FlowHighlightResult {
  flowId: string;
  moduleIds: string[];
  edgeIds: string[];
  stepByModuleId: Record<string, number>;
}

const NODE_WIDTH = 224;
const NODE_HEIGHT = 96;
const COL_GAP = 36;
const SUBROW_GAP = 28;
const LAYER_BAND_GAP = 44;
const LAYER_BAND_PAD_Y = 20;
const LEFT_LANE_WIDTH = 168;
const RIGHT_PADDING = 48;
const TOP_PADDING = 36;
const BOTTOM_PADDING = 44;
const MAX_COLUMNS_PER_ROW = 5;

function buildNormalizedAdjacency(modules: KnowledgeGraphModuleNode[]): {
  moduleMap: Map<string, KnowledgeGraphModuleNode>;
  dependsOnMap: Map<string, Set<string>>;
  dependedOnByMap: Map<string, Set<string>>;
} {
  const moduleMap = new Map<string, KnowledgeGraphModuleNode>();
  const dependsOnMap = new Map<string, Set<string>>();
  const dependedOnByMap = new Map<string, Set<string>>();

  for (const mod of modules) {
    moduleMap.set(mod.id, mod);
    dependsOnMap.set(mod.id, new Set<string>());
    dependedOnByMap.set(mod.id, new Set<string>());
  }

  for (const mod of modules) {
    for (const targetId of mod.dependsOnModules ?? []) {
      if (targetId !== mod.id && moduleMap.has(targetId)) {
        dependsOnMap.get(mod.id)!.add(targetId);
        dependedOnByMap.get(targetId)!.add(mod.id);
      }
    }
    for (const callerId of mod.dependedOnByModules ?? []) {
      if (callerId !== mod.id && moduleMap.has(callerId)) {
        dependedOnByMap.get(mod.id)!.add(callerId);
        dependsOnMap.get(callerId)!.add(mod.id);
      }
    }
  }

  return { moduleMap, dependsOnMap, dependedOnByMap };
}

function buildCubicBezierEdgePath(
  source: PositionedGraphNode,
  target: PositionedGraphNode
): {
  d: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  isBackEdge: boolean;
} {
  const isSameRow = Math.abs(target.centerY - source.centerY) < 8;

  if (isSameRow) {
    const goingRight = target.centerX >= source.centerX;
    const fromX = goingRight ? source.x + source.width : source.x;
    const fromY = source.centerY;
    const toX = goingRight ? target.x : target.x + target.width;
    const toY = target.centerY;
    const dx = Math.abs(toX - fromX);
    const arcY = Math.min(42, Math.max(20, dx * 0.14));
    const cp1x = fromX + (goingRight ? 1 : -1) * Math.max(24, dx * 0.35);
    const cp1y = fromY - arcY;
    const cp2x = toX - (goingRight ? 1 : -1) * Math.max(24, dx * 0.35);
    const cp2y = toY - arcY;

    return {
      d: `M ${Math.round(fromX)} ${Math.round(fromY)} C ${Math.round(cp1x)} ${Math.round(cp1y)}, ${Math.round(cp2x)} ${Math.round(cp2y)}, ${Math.round(toX)} ${Math.round(toY)}`,
      fromX,
      fromY,
      toX,
      toY,
      isBackEdge: false,
    };
  }

  const goingDown = target.centerY > source.centerY;
  const fromX = source.centerX;
  const fromY = goingDown ? source.y + source.height : source.y;
  const toX = target.centerX;
  const toY = goingDown ? target.y : target.y + target.height;

  const dy = Math.abs(toY - fromY);
  const controlOffset = Math.max(32, Math.round(dy * 0.46));
  const cp1x = fromX;
  const cp1y = goingDown ? fromY + controlOffset : fromY - controlOffset;
  const cp2x = toX;
  const cp2y = goingDown ? toY - controlOffset : toY + controlOffset;

  return {
    d: `M ${Math.round(fromX)} ${Math.round(fromY)} C ${Math.round(cp1x)} ${Math.round(cp1y)}, ${Math.round(cp2x)} ${Math.round(cp2y)}, ${Math.round(toX)} ${Math.round(toY)}`,
    fromX,
    fromY,
    toX,
    toY,
    isBackEdge: !goingDown,
  };
}

/**
 * Computes a deterministic layered DAG layout grouped by architectural layer.
 */
export function computeArchitectureGraphLayout(
  modules: KnowledgeGraphModuleNode[],
  _coreFlows?: RepoCoreFlow[]
): ArchitectureGraphLayout {
  if (!modules || modules.length === 0) {
    return {
      width: 960,
      height: 480,
      nodes: [],
      edges: [],
      layerBands: [],
    };
  }

  const { dependsOnMap, dependedOnByMap } = buildNormalizedAdjacency(modules);

  // Group modules into semantic architectural ranks
  const groupedByLayer = new Map<RepoModuleLayer, KnowledgeGraphModuleNode[]>();
  for (const layer of ARCH_LAYER_ORDER) {
    groupedByLayer.set(layer, []);
  }

  for (const mod of modules) {
    const layer = ARCH_LAYER_ORDER.includes(mod.layer) ? mod.layer : 'core';
    groupedByLayer.get(layer)!.push(mod);
  }

  const activeLayers = ARCH_LAYER_ORDER.filter(
    (layer) => (groupedByLayer.get(layer)?.length ?? 0) > 0
  );

  // Determine maximum horizontal span needed across all layers
  let maxColsInAnyLayer = 1;
  for (const layer of activeLayers) {
    const count = groupedByLayer.get(layer)!.length;
    const cols = Math.min(MAX_COLUMNS_PER_ROW, count);
    if (cols > maxColsInAnyLayer) {
      maxColsInAnyLayer = cols;
    }
  }

  const contentAreaWidth = Math.max(
    720,
    maxColsInAnyLayer * NODE_WIDTH + Math.max(0, maxColsInAnyLayer - 1) * COL_GAP
  );
  const canvasWidth = LEFT_LANE_WIDTH + contentAreaWidth + RIGHT_PADDING;

  const nodes: PositionedGraphNode[] = [];
  const nodeById = new Map<string, PositionedGraphNode>();
  const layerBands: LayerBand[] = [];

  let currentY = TOP_PADDING;

  activeLayers.forEach((layer, rankIndex) => {
    const layerModules = [...(groupedByLayer.get(layer) ?? [])];

    // Sort deterministically within the rank:
    // modules with higher connectivity or barycenter alignment, tie-broken by id
    layerModules.sort((a, b) => {
      const aDegree =
        (dependedOnByMap.get(a.id)?.size ?? 0) * 2 + (dependsOnMap.get(a.id)?.size ?? 0);
      const bDegree =
        (dependedOnByMap.get(b.id)?.size ?? 0) * 2 + (dependsOnMap.get(b.id)?.size ?? 0);
      if (bDegree !== aDegree) return bDegree - aDegree;
      return a.id.localeCompare(b.id);
    });

    const subRowCount = Math.ceil(layerModules.length / MAX_COLUMNS_PER_ROW);
    const bandHeight =
      LAYER_BAND_PAD_Y * 2 +
      subRowCount * NODE_HEIGHT +
      Math.max(0, subRowCount - 1) * SUBROW_GAP;

    const meta = ARCH_LAYER_META[layer];
    layerBands.push({
      layer,
      label: meta.label,
      description: meta.description,
      rankIndex,
      y: currentY,
      height: bandHeight,
      moduleCount: layerModules.length,
    });

    for (let subRow = 0; subRow < subRowCount; subRow += 1) {
      const startIdx = subRow * MAX_COLUMNS_PER_ROW;
      const rowSlice = layerModules.slice(startIdx, startIdx + MAX_COLUMNS_PER_ROW);
      const rowWidth =
        rowSlice.length * NODE_WIDTH + Math.max(0, rowSlice.length - 1) * COL_GAP;
      const rowStartX =
        LEFT_LANE_WIDTH + Math.round((contentAreaWidth - rowWidth) / 2);
      const rowY =
        currentY + LAYER_BAND_PAD_Y + subRow * (NODE_HEIGHT + SUBROW_GAP);

      rowSlice.forEach((mod, idxInRow) => {
        const x = rowStartX + idxInRow * (NODE_WIDTH + COL_GAP);
        const y = rowY;
        const positioned: PositionedGraphNode = {
          id: mod.id,
          module: mod,
          layer,
          rankIndex,
          columnIndex: startIdx + idxInRow,
          x,
          y,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          centerX: x + NODE_WIDTH / 2,
          centerY: y + NODE_HEIGHT / 2,
        };
        nodes.push(positioned);
        nodeById.set(mod.id, positioned);
      });
    }

    currentY += bandHeight + LAYER_BAND_GAP;
  });

  const canvasHeight = Math.max(
    420,
    currentY - LAYER_BAND_GAP + BOTTOM_PADDING
  );

  // Build directed edges from normalized dependencies
  const edges: PositionedGraphEdge[] = [];
  const seenEdgeIds = new Set<string>();

  for (const sourceNode of nodes) {
    const targets = Array.from(dependsOnMap.get(sourceNode.id) ?? []).sort((a, b) =>
      a.localeCompare(b)
    );
    for (const targetId of targets) {
      const targetNode = nodeById.get(targetId);
      if (!targetNode || targetNode.id === sourceNode.id) continue;

      const edgeId = `${sourceNode.id}->${targetNode.id}`;
      if (seenEdgeIds.has(edgeId)) continue;
      seenEdgeIds.add(edgeId);

      const geom = buildCubicBezierEdgePath(sourceNode, targetNode);
      edges.push({
        id: edgeId,
        from: sourceNode.id,
        to: targetNode.id,
        d: geom.d,
        fromX: geom.fromX,
        fromY: geom.fromY,
        toX: geom.toX,
        toY: geom.toY,
        isBackEdge: geom.isBackEdge,
      });
    }
  }

  return {
    width: canvasWidth,
    height: canvasHeight,
    nodes,
    edges,
    layerBands,
  };
}

/**
 * Computes the upstream callers (who breaks if this module changes)
 * and downstream dependencies (what this module imports) via BFS.
 */
export function computeBlastRadius(
  modules: KnowledgeGraphModuleNode[],
  selectedModuleId: string
): BlastRadiusResult {
  const { moduleMap, dependsOnMap, dependedOnByMap } =
    buildNormalizedAdjacency(modules);

  if (!moduleMap.has(selectedModuleId)) {
    return {
      selectedModuleId,
      directUpstream: [],
      transitiveUpstream: [],
      directDownstream: [],
      transitiveDownstream: [],
      affectedFilesCount: 0,
      upstreamRatio: 0,
      riskLevel: 'low',
    };
  }

  const directUpstream = Array.from(
    dependedOnByMap.get(selectedModuleId) ?? []
  ).sort((a, b) => a.localeCompare(b));

  const directUpstreamSet = new Set<string>(directUpstream);
  const visitedUpstream = new Set<string>([selectedModuleId, ...directUpstream]);
  const transitiveUpstream: string[] = [];
  const upstreamQueue = [...directUpstream];

  while (upstreamQueue.length > 0) {
    const currentId = upstreamQueue.shift()!;
    const callers = Array.from(dependedOnByMap.get(currentId) ?? []).sort((a, b) =>
      a.localeCompare(b)
    );
    for (const callerId of callers) {
      if (!visitedUpstream.has(callerId)) {
        visitedUpstream.add(callerId);
        if (!directUpstreamSet.has(callerId)) {
          transitiveUpstream.push(callerId);
        }
        upstreamQueue.push(callerId);
      }
    }
  }

  const directDownstream = Array.from(
    dependsOnMap.get(selectedModuleId) ?? []
  ).sort((a, b) => a.localeCompare(b));

  const directDownstreamSet = new Set<string>(directDownstream);
  const visitedDownstream = new Set<string>([
    selectedModuleId,
    ...directDownstream,
  ]);
  const transitiveDownstream: string[] = [];
  const downstreamQueue = [...directDownstream];

  while (downstreamQueue.length > 0) {
    const currentId = downstreamQueue.shift()!;
    const deps = Array.from(dependsOnMap.get(currentId) ?? []).sort((a, b) =>
      a.localeCompare(b)
    );
    for (const depId of deps) {
      if (!visitedDownstream.has(depId)) {
        visitedDownstream.add(depId);
        if (!directDownstreamSet.has(depId)) {
          transitiveDownstream.push(depId);
        }
        downstreamQueue.push(depId);
      }
    }
  }

  // Count unique affected files across selectedModuleId + all upstream dependents
  const impactedModuleIds = [
    selectedModuleId,
    ...directUpstream,
    ...transitiveUpstream,
  ];
  const uniqueFiles = new Set<string>();
  let fallbackFileSum = 0;

  for (const modId of impactedModuleIds) {
    const mod = moduleMap.get(modId);
    if (!mod) continue;
    if (Array.isArray(mod.files) && mod.files.length > 0) {
      for (const filePath of mod.files) {
        uniqueFiles.add(filePath);
      }
    } else if (mod.observedFileCount > 0) {
      fallbackFileSum += mod.observedFileCount;
    }
  }

  const affectedFilesCount = uniqueFiles.size + fallbackFileSum;

  const totalOtherModules = Math.max(1, modules.length - 1);
  const totalUpstreamCount = directUpstream.length + transitiveUpstream.length;
  const upstreamRatio = Number(
    (totalUpstreamCount / totalOtherModules).toFixed(3)
  );

  let riskLevel: 'low' | 'medium' | 'high' = 'low';
  if (totalUpstreamCount === 0) {
    riskLevel = 'low';
  } else if (upstreamRatio >= 0.45 || totalUpstreamCount >= 4) {
    riskLevel = 'high';
  } else if (upstreamRatio >= 0.18 || totalUpstreamCount >= 2) {
    riskLevel = 'medium';
  }

  return {
    selectedModuleId,
    directUpstream,
    transitiveUpstream,
    directDownstream,
    transitiveDownstream,
    affectedFilesCount,
    upstreamRatio,
    riskLevel,
  };
}

/**
 * Resolves which module owns a repository file path.
 */
export function resolveModuleIdForFile(
  filePath: string,
  modules: KnowledgeGraphModuleNode[],
  files?: RepoFileIndexEntry[]
): string | undefined {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');

  if (files && files.length > 0) {
    const indexed = files.find(
      (f) => f.path.replace(/\\/g, '/').replace(/^\.\//, '') === normalized
    );
    if (indexed && modules.some((m) => m.id === indexed.moduleId)) {
      return indexed.moduleId;
    }
  }

  for (const mod of modules) {
    if (
      mod.files?.some(
        (f) => f.replace(/\\/g, '/').replace(/^\.\//, '') === normalized
      )
    ) {
      return mod.id;
    }
  }

  // Fallback to longest matching module path prefix
  let bestMatch: KnowledgeGraphModuleNode | undefined;
  let bestLen = -1;
  for (const mod of modules) {
    const modPath = mod.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (
      modPath &&
      (normalized === modPath || normalized.startsWith(`${modPath}/`)) &&
      modPath.length > bestLen
    ) {
      bestMatch = mod;
      bestLen = modPath.length;
    }
  }

  return bestMatch?.id;
}

/**
 * Matches a RepoCoreFlow's file sequence onto an ordered set of moduleIds and directed edgeIds.
 */
export function computeFlowHighlight(
  flow: RepoCoreFlow,
  modules: KnowledgeGraphModuleNode[],
  files?: RepoFileIndexEntry[]
): FlowHighlightResult {
  const { dependsOnMap } = buildNormalizedAdjacency(modules);

  const orderedSequence: string[] = [];
  const uniqueModuleIds: string[] = [];
  const stepByModuleId: Record<string, number> = {};

  for (const filePath of flow.files ?? []) {
    const modId = resolveModuleIdForFile(filePath, modules, files);
    if (!modId) continue;

    if (
      orderedSequence.length === 0 ||
      orderedSequence[orderedSequence.length - 1] !== modId
    ) {
      orderedSequence.push(modId);
    }

    if (!uniqueModuleIds.includes(modId)) {
      uniqueModuleIds.push(modId);
      stepByModuleId[modId] = uniqueModuleIds.length;
    }
  }

  const edgeIdSet = new Set<string>();
  for (let i = 0; i < orderedSequence.length - 1; i += 1) {
    const fromId = orderedSequence[i];
    const toId = orderedSequence[i + 1];
    if (fromId === toId) continue;

    edgeIdSet.add(`${fromId}->${toId}`);
    // Also highlight reverse import edge if the underlying module import goes the other direction
    if (dependsOnMap.get(toId)?.has(fromId)) {
      edgeIdSet.add(`${toId}->${fromId}`);
    }
  }

  // Also include any direct dependency edges between consecutive flow modules
  for (const fromId of uniqueModuleIds) {
    const deps = dependsOnMap.get(fromId);
    if (!deps) continue;
    for (const toId of uniqueModuleIds) {
      if (fromId !== toId && deps.has(toId)) {
        edgeIdSet.add(`${fromId}->${toId}`);
      }
    }
  }

  return {
    flowId: flow.id,
    moduleIds: uniqueModuleIds,
    edgeIds: Array.from(edgeIdSet),
    stepByModuleId,
  };
}

/**
 * Filters modules by a search query matching module name, id, path, role, layer, symbols, or file paths.
 */
export function filterArchitectureModules(
  modules: KnowledgeGraphModuleNode[],
  query: string,
  files?: RepoFileIndexEntry[]
): Set<string> {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return new Set(modules.map((m) => m.id));
  }

  const matchingIds = new Set<string>();

  for (const mod of modules) {
    const haystacks = [
      mod.id,
      mod.name,
      mod.path,
      mod.role,
      mod.layer,
      ...(mod.keySymbols ?? []),
      ...(mod.files ?? []),
    ];

    if (haystacks.some((item) => item && item.toLowerCase().includes(trimmed))) {
      matchingIds.add(mod.id);
    }
  }

  if (files && files.length > 0) {
    for (const file of files) {
      if (matchingIds.has(file.moduleId)) continue;
      if (
        file.path.toLowerCase().includes(trimmed) ||
        file.exports?.some((exp) => exp.name.toLowerCase().includes(trimmed))
      ) {
        matchingIds.add(file.moduleId);
      }
    }
  }

  return matchingIds;
}
