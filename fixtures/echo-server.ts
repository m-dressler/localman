// Minimal service used by the `serve` task and manual testing: echoes the URL
// it received so you can see how localman forwarded the request.
Deno.serve({
  port: Number(Deno.env.get("PORT")),
  handler: (req) => Response.json({ url: req.url }),
  onListen: (addr) => console.log("Echo server listening on port", addr.port),
});
