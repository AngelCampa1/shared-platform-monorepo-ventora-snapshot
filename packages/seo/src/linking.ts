import type { InternalLinkGraph, RelatedEntries, SiteRoute } from "./types.js";

export function buildInternalLinkGraph(routes: SiteRoute[]): InternalLinkGraph {
  const nodes = new Map<string, SiteRoute>();
  const edges = new Map<string, Set<string>>();

  for (const route of routes) {
    nodes.set(route.path, route);
    if (!edges.has(route.path)) {
      edges.set(route.path, new Set<string>());
    }
  }

  for (const route of routes) {
    if (route.relatedPaths !== undefined) {
      const edgeSet = edges.get(route.path) ?? new Set<string>();
      for (const related of route.relatedPaths) {
        edgeSet.add(related);
      }
      edges.set(route.path, edgeSet);
    }
  }

  return { nodes, edges };
}

export function resolveFunnelAwareRelatedEntries(
  route: SiteRoute,
  graph: InternalLinkGraph,
): RelatedEntries {
  const allRoutes = Array.from(graph.nodes.values()).filter((r) => r.path !== route.path);

  const siloRoutes =
    route.silo !== undefined ? allRoutes.filter((r) => r.silo === route.silo).slice(0, 5) : [];

  const funnelRoutes =
    route.funnelStage !== undefined
      ? allRoutes.filter((r) => r.funnelStage === route.funnelStage).slice(0, 5)
      : [];

  const collectionRoutes =
    route.collection !== undefined
      ? allRoutes.filter((r) => r.collection === route.collection).slice(0, 5)
      : [];

  return {
    silo: siloRoutes,
    funnel: funnelRoutes,
    collection: collectionRoutes,
  };
}

export function detectOrphans(graph: InternalLinkGraph): SiteRoute[] {
  // Build the set of paths that appear as targets in any route's edges
  const referencedPaths = new Set<string>();
  for (const linkedPaths of graph.edges.values()) {
    for (const path of linkedPaths) {
      referencedPaths.add(path);
    }
  }

  const orphans: SiteRoute[] = [];
  for (const route of graph.nodes.values()) {
    if (route.path === "/") {
      continue;
    }
    if (!referencedPaths.has(route.path)) {
      orphans.push(route);
    }
  }

  return orphans;
}
