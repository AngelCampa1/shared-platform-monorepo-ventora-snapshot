import { describe, expect, it } from "vitest";
import {
  buildInternalLinkGraph,
  detectOrphans,
  resolveFunnelAwareRelatedEntries,
} from "../linking.js";
import type { SiteRoute } from "../types.js";

const routes: SiteRoute[] = [
  { path: "/", title: "Home" },
  {
    path: "/blog",
    title: "Blog",
    collection: "blog",
    funnelStage: "awareness",
    silo: "content",
    relatedPaths: ["/blog/post-1", "/blog/post-2"],
  },
  {
    path: "/blog/post-1",
    title: "Post 1",
    collection: "blog",
    funnelStage: "awareness",
    silo: "content",
    relatedPaths: ["/blog/post-2"],
  },
  {
    path: "/blog/post-2",
    title: "Post 2",
    collection: "blog",
    funnelStage: "awareness",
    silo: "content",
  },
  {
    path: "/features",
    title: "Features",
    funnelStage: "consideration",
    silo: "product",
    relatedPaths: ["/pricing"],
  },
  {
    path: "/pricing",
    title: "Pricing",
    funnelStage: "consideration",
    silo: "product",
    relatedPaths: ["/features"],
  },
  {
    path: "/orphan-page",
    title: "Orphan Page",
  },
];

function getRoute(graph: ReturnType<typeof buildInternalLinkGraph>, path: string): SiteRoute {
  const route = graph.nodes.get(path);
  expect(route).toBeDefined();
  if (route === undefined) {
    throw new Error(`Expected route ${path} to exist`);
  }
  return route;
}

describe("buildInternalLinkGraph", () => {
  it("creates nodes map for all routes", () => {
    const graph = buildInternalLinkGraph(routes);
    expect(graph.nodes.size).toBe(routes.length);
    expect(graph.nodes.has("/")).toBe(true);
    expect(graph.nodes.has("/blog")).toBe(true);
  });

  it("creates edges from relatedPaths", () => {
    const graph = buildInternalLinkGraph(routes);
    const blogEdges = graph.edges.get("/blog");
    expect(blogEdges?.has("/blog/post-1")).toBe(true);
    expect(blogEdges?.has("/blog/post-2")).toBe(true);
  });

  it("creates empty edge set for routes with no relatedPaths", () => {
    const graph = buildInternalLinkGraph(routes);
    const homeEdges = graph.edges.get("/");
    expect(homeEdges).toBeDefined();
    expect(homeEdges?.size).toBe(0);
  });

  it("stores correct route objects in nodes", () => {
    const graph = buildInternalLinkGraph(routes);
    const blogRoute = graph.nodes.get("/blog");
    expect(blogRoute?.title).toBe("Blog");
    expect(blogRoute?.collection).toBe("blog");
  });

  it("handles routes with no relatedPaths gracefully", () => {
    const simpleRoutes: SiteRoute[] = [
      { path: "/", title: "Home" },
      { path: "/about", title: "About" },
    ];
    const graph = buildInternalLinkGraph(simpleRoutes);
    expect(graph.edges.get("/")?.size).toBe(0);
    expect(graph.edges.get("/about")?.size).toBe(0);
  });
});

describe("resolveFunnelAwareRelatedEntries", () => {
  it("returns routes in the same silo", () => {
    const graph = buildInternalLinkGraph(routes);
    const route = getRoute(graph, "/blog");
    const related = resolveFunnelAwareRelatedEntries(route, graph);
    expect(related.silo.some((r) => r.path === "/blog/post-1")).toBe(true);
    expect(related.silo.some((r) => r.path === "/blog/post-2")).toBe(true);
  });

  it("excludes the current route from silo results", () => {
    const graph = buildInternalLinkGraph(routes);
    const route = getRoute(graph, "/blog");
    const related = resolveFunnelAwareRelatedEntries(route, graph);
    expect(related.silo.some((r) => r.path === "/blog")).toBe(false);
  });

  it("returns routes in the same funnelStage", () => {
    const graph = buildInternalLinkGraph(routes);
    const route = getRoute(graph, "/features");
    const related = resolveFunnelAwareRelatedEntries(route, graph);
    expect(related.funnel.some((r) => r.path === "/pricing")).toBe(true);
  });

  it("returns routes in the same collection", () => {
    const graph = buildInternalLinkGraph(routes);
    const route = getRoute(graph, "/blog/post-1");
    const related = resolveFunnelAwareRelatedEntries(route, graph);
    expect(related.collection.some((r) => r.path === "/blog")).toBe(true);
    expect(related.collection.some((r) => r.path === "/blog/post-2")).toBe(true);
  });

  it("returns empty arrays when route has no silo/funnel/collection", () => {
    const graph = buildInternalLinkGraph(routes);
    const route = getRoute(graph, "/orphan-page");
    const related = resolveFunnelAwareRelatedEntries(route, graph);
    expect(related.silo).toHaveLength(0);
    expect(related.funnel).toHaveLength(0);
    expect(related.collection).toHaveLength(0);
  });

  it("limits silo results to 5", () => {
    const manyRoutes: SiteRoute[] = Array.from({ length: 10 }, (_, i) => ({
      path: `/page-${i}`,
      title: `Page ${i}`,
      silo: "big-silo",
    }));
    const graph = buildInternalLinkGraph(manyRoutes);
    const route = getRoute(graph, "/page-0");
    const related = resolveFunnelAwareRelatedEntries(route, graph);
    expect(related.silo.length).toBeLessThanOrEqual(5);
  });

  it("limits funnel results to 5", () => {
    const manyRoutes: SiteRoute[] = Array.from({ length: 10 }, (_, i) => ({
      path: `/page-${i}`,
      title: `Page ${i}`,
      funnelStage: "awareness",
    }));
    const graph = buildInternalLinkGraph(manyRoutes);
    const route = getRoute(graph, "/page-0");
    const related = resolveFunnelAwareRelatedEntries(route, graph);
    expect(related.funnel.length).toBeLessThanOrEqual(5);
  });

  it("limits collection results to 5", () => {
    const manyRoutes: SiteRoute[] = Array.from({ length: 10 }, (_, i) => ({
      path: `/page-${i}`,
      title: `Page ${i}`,
      collection: "big-collection",
    }));
    const graph = buildInternalLinkGraph(manyRoutes);
    const route = getRoute(graph, "/page-0");
    const related = resolveFunnelAwareRelatedEntries(route, graph);
    expect(related.collection.length).toBeLessThanOrEqual(5);
  });
});

describe("detectOrphans", () => {
  it("returns routes with no incoming edges", () => {
    const graph = buildInternalLinkGraph(routes);
    const orphans = detectOrphans(graph);
    expect(orphans.some((r) => r.path === "/orphan-page")).toBe(true);
  });

  it("excludes the home route /", () => {
    const graph = buildInternalLinkGraph(routes);
    const orphans = detectOrphans(graph);
    expect(orphans.some((r) => r.path === "/")).toBe(false);
  });

  it("does not include routes that are referenced by others", () => {
    const graph = buildInternalLinkGraph(routes);
    const orphans = detectOrphans(graph);
    expect(orphans.some((r) => r.path === "/blog/post-1")).toBe(false);
    expect(orphans.some((r) => r.path === "/blog/post-2")).toBe(false);
  });

  it("returns empty array when all routes are connected", () => {
    const connected: SiteRoute[] = [
      { path: "/", title: "Home", relatedPaths: ["/about"] },
      { path: "/about", title: "About", relatedPaths: ["/"] },
    ];
    const graph = buildInternalLinkGraph(connected);
    const orphans = detectOrphans(graph);
    expect(orphans).toHaveLength(0);
  });

  it("handles graph with only home route", () => {
    const onlyHome: SiteRoute[] = [{ path: "/", title: "Home" }];
    const graph = buildInternalLinkGraph(onlyHome);
    const orphans = detectOrphans(graph);
    expect(orphans).toHaveLength(0);
  });

  it("detects multiple orphans", () => {
    const multiOrphan: SiteRoute[] = [
      { path: "/", title: "Home" },
      { path: "/orphan-1", title: "Orphan 1" },
      { path: "/orphan-2", title: "Orphan 2" },
    ];
    const graph = buildInternalLinkGraph(multiOrphan);
    const orphans = detectOrphans(graph);
    expect(orphans).toHaveLength(2);
  });
});
