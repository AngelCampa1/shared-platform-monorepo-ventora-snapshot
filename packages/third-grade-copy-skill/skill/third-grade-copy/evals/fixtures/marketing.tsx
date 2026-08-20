export function Hero() {
  return (
    <section>
      <h1>Our comprehensive platform helps teams optimize workflows</h1>
      <p>See every deal in one place. Know what needs work.</p>
      <p>Get guaranteed results in one day.</p>
      <a href="/features">Learn more</a>
      <a href="/pricing" className="btn">
        More details
      </a>
      <a href="/trial" aria-label="Start free trial">
        Start free trial
      </a>
      <button aria-label="open menu" type="button">
        See plans
      </button>
      <nav>{[{ label: "Wall of Fame", href: "/wall" }]}</nav>
      <div className="bg-indigo-600 text-white hover:bg-indigo-700 focus-visible:ring-indigo-500" />
      <script>{"business_unit_id must be a valid Trustpilot review path segment"}</script>
      <script>{"SELECT * FROM testimonials WHERE id = ?"}</script>
      <script>{"Mozilla/5.0 (compatible; VentoraCRM/1.0; +https://ventora.app) RSS reader"}</script>
      <script>{"application/rss+xml, application/atom+xml, application/xml, text/xml, */*"}</script>
    </section>
  );
}
